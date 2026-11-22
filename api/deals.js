/* ============================================================
   Transia — /api/deals
   Double confirmation → affaire + commission.
   POST action=accept    : le donneur d'ordre accepte la offre
                           recommandée (validée) → en attente de
                           confirmation transporteur.
   POST action=confirm   : le transporteur confirme → l'affaire
                           (TR-AAAA-NNNNNN) et la commission sont
                           créées transactionnellement, taux figé
                           à la création (jamais codé en dur).
   POST action=refuse    : le donneur d'ordre refuse avec motif.
   GET                  : liste des affaires selon le profil.
   ============================================================ */
"use strict";

const { handler, json, readBody, fail } = require("./_lib/respond");
const { getPool, query } = require("./_lib/db");
const { requireAuth } = require("./_lib/auth");
const { enqueueEmail, flushOutbox, companyEmails } = require("./_lib/notify");
const { calculer: calculerCommission, LIBELLE: BAREME_LIBELLE } = require("./_lib/commission");

const PLATFORM_ROLES = ["PLATFORM_OPERATIONS", "PLATFORM_FINANCE", "PLATFORM_ADMIN", "SUPER_ADMIN"];
const SHIPPER_ROLES = ["SHIPPER_USER", "SHIPPER_ADMIN"];
const CARRIER_ROLES = ["CARRIER_USER", "CARRIER_ADMIN"];

/* quote_id et acceptance_id sont des uuid : une chaîne malformée
   ferait échouer la requête SQL (22P02) et remonterait en 500.
   On la rejette en amont comme une entrée invalide. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => UUID_RE.test(String(v));

async function nextDealNumber(client) {
  const r = await client.query(
    `SELECT 'TR-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('deal_number_seq')::text, 6, '0') AS n`
  );
  return r.rows[0].n;
}

module.exports = handler(async (req, res) => {
  /* ================= GET : journal des affaires ================= */
  if (req.method === "GET") {
    const denied = await requireAuth()(req, res);
    if (denied) return;
    const user = req.user;

    const params = [];
    let where = "";
    if (PLATFORM_ROLES.includes(user.role) || user.role === "PLATFORM_FINANCE") {
      /* tout visible */
    } else if (SHIPPER_ROLES.includes(user.role)) {
      params.push(user.company_id);
      where = "WHERE d.shipper_company_id = $" + params.length;
    } else if (CARRIER_ROLES.includes(user.role)) {
      params.push(user.company_id);
      where = "WHERE d.carrier_company_id = $" + params.length;
    } else {
      return fail(res, 403, "Accès refusé.", "FORBIDDEN");
    }

    const r = await query(
      `SELECT d.deal_number, d.transport_amount, d.commissionable_amount,
              d.commission_rate, d.commission_amount, d.status, d.confirmed_at,
              r.rfq_number, r.origin_city, r.destination_city, m.code AS mode,
              cur.iso_code AS currency,
              sc.legal_name AS shipper_name, cc.legal_name AS carrier_name
         FROM deals d
         JOIN rfqs r ON r.rfq_id = d.rfq_id
         LEFT JOIN transport_modes m ON m.transport_mode_id = r.transport_mode_id
         JOIN currencies cur ON cur.currency_id = d.deal_currency_id
         JOIN companies sc ON sc.company_id = d.shipper_company_id
         JOIN companies cc ON cc.company_id = d.carrier_company_id
         ${where}
        ORDER BY d.confirmed_at DESC
        LIMIT 200`,
      params
    );

    const stats = await query(
      `SELECT count(*)::int AS n, COALESCE(sum(d.commission_amount), 0) AS commission
         FROM deals d ${where}`,
      params
    );

    return json(res, 200, { deals: r.rows, count: r.rows.length, stats: stats.rows[0] });
  }

  /* ================= POST : accept / confirm / refuse ================= */
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: "Méthode non autorisée." });
  }

  const denied = await requireAuth()(req, res);
  if (denied) return;
  const user = req.user;
  const body = await readBody(req);
  const action = String(body.action || "");
  const rfqNumber = String(body.rfqNumber || "").trim();
  if (!rfqNumber) return fail(res, 400, "Référence de demande obligatoire.", "MISSING_RFQ");

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const rfq = await client.query(
      `SELECT rfq_id, shipper_company_id, status, origin_city, destination_city
         FROM rfqs WHERE rfq_number = $1 FOR UPDATE`,
      [rfqNumber]
    );
    if (!rfq.rows.length) { await client.query("ROLLBACK"); return fail(res, 404, "Demande introuvable.", "NOT_FOUND"); }
    const rfqRow = rfq.rows[0];

    /* ---------- ACCEPTATION (donneur d'ordre) ---------- */
    if (action === "accept") {
      if (!SHIPPER_ROLES.includes(user.role) || user.company_id !== rfqRow.shipper_company_id) {
        await client.query("ROLLBACK");
        return fail(res, 403, "Seul le donneur d'ordre de cette demande peut accepter une offre.", "FORBIDDEN");
      }

      const requestedQuoteId = body.quoteId ? String(body.quoteId).trim() : null;
      if (requestedQuoteId && !isUuid(requestedQuoteId)) {
        await client.query("ROLLBACK");
        return fail(res, 400, "Identifiant d'offre invalide.", "INVALID_QUOTE_ID");
      }

      /* L'offre acceptée doit être la recommandation validée */
      const rec = await client.query(
        `SELECT rec.recommendation_id, q.quote_id, q.carrier_company_id, q.comparable_total,
                q.commissionable_amount, q.currency_id, cur.iso_code AS currency
           FROM rfq_recommendations rec
           JOIN quotes q ON q.quote_id = rec.quote_id
           JOIN currencies cur ON cur.currency_id = q.currency_id
          WHERE rec.rfq_id = $1 AND rec.status = 'VALIDATED'
          ORDER BY rec.admin_validated_at DESC NULLS LAST
          LIMIT 1`,
        [rfqRow.rfq_id]
      );
      let quoteRow = rec.rows[0];

      /* Repli : acceptation directe d'une offre conforme si aucune
         recommandation n'a encore été validée (démarrage à froid) */
      if (!quoteRow && requestedQuoteId) {
        const q = await client.query(
          `SELECT q.quote_id, q.carrier_company_id, q.comparable_total, q.commissionable_amount,
                  q.currency_id, cur.iso_code AS currency
             FROM quotes q JOIN currencies cur ON cur.currency_id = q.currency_id
            WHERE q.rfq_id = $1 AND q.quote_id = $2 AND q.compliance_status = 'CONFORME'`,
          [rfqRow.rfq_id, requestedQuoteId]
        );
        quoteRow = q.rows[0];
      }
      if (!quoteRow) {
        await client.query("ROLLBACK");
        return fail(res, 409, "Aucune offre validée disponible : l'administration doit d'abord valider une recommandation.", "NO_VALIDATED_RECOMMENDATION");
      }

      const existing = await client.query(
        `SELECT acceptance_id, status FROM quote_acceptances
          WHERE rfq_id = $1 AND status IN ('AWAITING_CARRIER','CONFIRMED')`,
        [rfqRow.rfq_id]
      );
      if (existing.rows.length) {
        await client.query("ROLLBACK");
        return fail(res, 409, "Une acceptation est déjà en cours sur cette demande.", "ALREADY_ACCEPTED");
      }

      const acc = await client.query(
        `INSERT INTO quote_acceptances (rfq_id, quote_id, shipper_user_id, status, client_comment)
         VALUES ($1,$2,$3,'AWAITING_CARRIER',$4)
         RETURNING acceptance_id, accepted_at`,
        [rfqRow.rfq_id, quoteRow.quote_id, user.user_id, String(body.comment || "").trim().slice(0, 1000) || null]
      );
      await client.query(`UPDATE quotes SET status = 'SELECTED', updated_at = now() WHERE quote_id = $1`, [quoteRow.quote_id]);
      await client.query(`UPDATE rfqs SET status = 'ACCEPTED' WHERE rfq_id = $1`, [rfqRow.rfq_id]);
      await client.query(
        `INSERT INTO audit_log (user_id, action_type, entity_type, entity_id, new_value)
         VALUES ($1,'QUOTE_ACCEPTED','rfqs',$2,$3)`,
        [user.user_id, rfqRow.rfq_id, JSON.stringify({ quoteId: quoteRow.quote_id, acceptanceId: acc.rows[0].acceptance_id })]
      );

      /* Le transporteur pressenti doit confirmer sous 48 h */
      const carrier = await companyEmails(client, quoteRow.carrier_company_id);
      if (carrier) {
        await enqueueEmail(client, {
          dedupeKey: "quote_accepted:" + acc.rows[0].acceptance_id,
          eventType: "quote_accepted",
          entityType: "quote_acceptances",
          entityId: acc.rows[0].acceptance_id,
          to: carrier.email,
          userId: carrier.user_id,
          vars: {
            firstName: carrier.first_name, rfqNumber,
            price: (quoteRow.currency || "EUR") === "EUR"
              ? new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(parseFloat(quoteRow.comparable_total))
              : quoteRow.comparable_total + " " + quoteRow.currency
          }
        });
      }

      await client.query("COMMIT");
      await flushOutbox();
      return json(res, 201, {
        status: "AWAITING_CARRIER",
        acceptance_id: acc.rows[0].acceptance_id,
        accepted_at: acc.rows[0].accepted_at,
        comparable_total: quoteRow.comparable_total,
        currency: quoteRow.currency,
        next: "Le transporteur doit confirmer pour créer l'affaire."
      });
    }

    /* ---------- CONFIRMATION (transporteur) ---------- */
    if (action === "confirm") {
      const acceptanceId = String(body.acceptanceId || "").trim();
      if (!acceptanceId) {
        await client.query("ROLLBACK");
        return fail(res, 400, "Identifiant d'acceptation requis.", "MISSING_ACCEPTANCE");
      }
      if (!isUuid(acceptanceId)) {
        await client.query("ROLLBACK");
        return fail(res, 400, "Identifiant d'acceptation invalide.", "INVALID_ACCEPTANCE_ID");
      }

      const acc = await client.query(
        `SELECT a.acceptance_id, a.status, a.quote_id,
                q.carrier_company_id, q.base_transport_price, q.commissionable_amount,
                q.comparable_total, q.currency_id, cur.iso_code AS currency
           FROM quote_acceptances a
           JOIN quotes q ON q.quote_id = a.quote_id
           JOIN currencies cur ON cur.currency_id = q.currency_id
          WHERE a.acceptance_id = $1 AND a.rfq_id = $2
          FOR UPDATE OF a`,
        [acceptanceId, rfqRow.rfq_id]
      );
      if (!acc.rows.length) { await client.query("ROLLBACK"); return fail(res, 404, "Acceptation introuvable.", "NOT_FOUND"); }
      const a = acc.rows[0];

      if (!CARRIER_ROLES.includes(user.role) || user.company_id !== a.carrier_company_id) {
        await client.query("ROLLBACK");
        return fail(res, 403, "Seul le transporteur pressenti peut confirmer.", "FORBIDDEN");
      }
      if (a.status !== "AWAITING_CARRIER") {
        await client.query("ROLLBACK");
        return fail(res, 409, "Cette acceptation n'attend plus de confirmation.", "INVALID_STATE");
      }

      await client.query(
        `INSERT INTO carrier_confirmations (acceptance_id, carrier_user_id, confirmed, confirmed_at)
         VALUES ($1,$2,true,now())`,
        [a.acceptance_id, user.user_id]
      );
      await client.query(`UPDATE quote_acceptances SET status = 'CONFIRMED' WHERE acceptance_id = $1`, [a.acceptance_id]);

      /* Affaire : barème dégressif de la clause CGU (8 / 6 / 4 / 2,5 %,
         plafond 700 €), appliqué à la seule partie transport puis FIGÉ
         sur l'affaire. Le taux stocké est le taux EFFECTIF réellement
         appliqué, pour que le journal et les rapports restent lisibles. */
      const commissionable = a.commissionable_amount != null ? parseFloat(a.commissionable_amount) : parseFloat(a.base_transport_price);
      const { commission: commissionAmount, tauxEffectif: rate } = calculerCommission(commissionable);
      const dealNumber = await nextDealNumber(client);

      const deal = await client.query(
        `INSERT INTO deals (deal_number, rfq_id, quote_id, shipper_company_id, carrier_company_id,
                            deal_currency_id, transport_amount, commissionable_amount,
                            commission_rate, commission_amount, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CONFIRMED')
         RETURNING deal_id, deal_number, confirmed_at`,
        [dealNumber, rfqRow.rfq_id, a.quote_id, rfqRow.shipper_company_id, a.carrier_company_id,
         a.currency_id, a.comparable_total != null ? a.comparable_total : a.base_transport_price,
         commissionable, rate, commissionAmount]
      );

      await client.query(
        `INSERT INTO commissions (deal_id, carrier_company_id, commissionable_amount, commission_rate, commission_amount, tax_amount, total_amount, status, due_date)
         VALUES ($1,$2,$3,$4,$5,0,$5,'CALCULATED', current_date + interval '30 days')`,
        [deal.rows[0].deal_id, a.carrier_company_id, commissionable, rate, commissionAmount]
      );

      await client.query(`UPDATE quotes SET status = 'SELECTED', updated_at = now() WHERE quote_id = $1`, [a.quote_id]);
      await client.query(`UPDATE rfqs SET status = 'CONFIRMED' WHERE rfq_id = $1`, [rfqRow.rfq_id]);
      await client.query(
        `INSERT INTO audit_log (user_id, action_type, entity_type, entity_id, new_value)
         VALUES ($1,'DEAL_CONFIRMED','deals',$2,$3)`,
        [user.user_id, deal.rows[0].deal_id, JSON.stringify({ dealNumber, rate, commissionAmount })]
      );

      /* Les deux parties sont informées : identités dévoilées */
      const fmt = (v) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: a.currency || "EUR" }).format(parseFloat(v));
      const dealVars = {
        rfqNumber, dealNumber,
        route: rfqRow.origin_city + " → " + rfqRow.destination_city,
        price: fmt(a.comparable_total != null ? a.comparable_total : a.base_transport_price),
        commission: fmt(commissionAmount),
        rate: BAREME_LIBELLE
      };
      for (const party of [await companyEmails(client, rfqRow.shipper_company_id), await companyEmails(client, a.carrier_company_id)]) {
        if (!party) continue;
        await enqueueEmail(client, {
          dedupeKey: "deal_confirmed:" + deal.rows[0].deal_id + ":" + party.email,
          eventType: "deal_confirmed",
          entityType: "deals",
          entityId: deal.rows[0].deal_id,
          to: party.email,
          userId: party.user_id,
          vars: Object.assign({ firstName: party.first_name }, dealVars)
        });
      }

      await client.query("COMMIT");
      await flushOutbox();
      return json(res, 201, {
        status: "CONFIRMED",
        deal: {
          deal_number: dealNumber,
          confirmed_at: deal.rows[0].confirmed_at,
          transport_amount: a.comparable_total != null ? a.comparable_total : a.base_transport_price,
          currency: a.currency,
          commissionable_amount: commissionable,
          commission_rate: rate,
          commission_amount: commissionAmount
        },
        note: "Identités débloquées : le contrat de transport est conclu entre les parties."
      });
    }

    /* ---------- REFUS (donneur d'ordre) ---------- */
    if (action === "refuse") {
      if (!SHIPPER_ROLES.includes(user.role) || user.company_id !== rfqRow.shipper_company_id) {
        await client.query("ROLLBACK");
        return fail(res, 403, "Seul le donneur d'ordre de cette demande peut refuser.", "FORBIDDEN");
      }
      const motif = String(body.motif || "").trim();
      if (motif.length < 3) { await client.query("ROLLBACK"); return fail(res, 400, "Motif de refus obligatoire.", "MISSING_MOTIF"); }

      /* L'offre citée doit appartenir à CETTE demande : sinon un
         donneur d'ordre référençait l'offre d'une autre entreprise. */
      let quoteId = null;
      if (body.quoteId) {
        quoteId = String(body.quoteId).trim();
        if (!isUuid(quoteId)) {
          await client.query("ROLLBACK");
          return fail(res, 400, "Identifiant d'offre invalide.", "INVALID_QUOTE_ID");
        }
        const own = await client.query(
          `SELECT 1 FROM quotes WHERE quote_id = $1 AND rfq_id = $2`,
          [quoteId, rfqRow.rfq_id]
        );
        if (!own.rows.length) {
          await client.query("ROLLBACK");
          return fail(res, 404, "Offre introuvable sur cette demande.", "NOT_FOUND");
        }
      }
      const close = body.closeRfq === true;

      await client.query(
        `INSERT INTO rfq_refusals (rfq_id, quote_id, refused_by, motif, comment, rfq_closed)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [rfqRow.rfq_id, quoteId, user.user_id, motif.slice(0, 200), String(body.comment || "").trim().slice(0, 1000) || null, close]
      );
      if (quoteId) {
        await client.query(`UPDATE quotes SET status = 'REJECTED', updated_at = now() WHERE quote_id = $1 AND rfq_id = $2`, [quoteId, rfqRow.rfq_id]);
      }
      if (close) {
        await client.query(`UPDATE rfqs SET status = 'REFUSED', closed_at = now() WHERE rfq_id = $1`, [rfqRow.rfq_id]);
      }
      await client.query(
        `INSERT INTO audit_log (user_id, action_type, entity_type, entity_id, new_value)
         VALUES ($1,'QUOTE_REFUSED','rfqs',$2,$3)`,
        [user.user_id, rfqRow.rfq_id, JSON.stringify({ motif, quoteId, close })]
      );

      await client.query("COMMIT");
      return json(res, 200, {
        status: close ? "REFUSED_CLOSED" : "REFUSED",
        motif,
        note: "Motif enregistré pour l'analyse commerciale."
      });
    }

    await client.query("ROLLBACK");
    return fail(res, 400, "Action inconnue : accept, confirm ou refuse.", "INVALID_ACTION");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});
