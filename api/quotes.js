/* ============================================================
   Transia — /api/quotes
   POST : dépôt d'une offre par un transporteur vérifié (à l'aveugle).
     - verrou anti double-coteur : une seule offre active par
       (RFQ, transporteur) ; une modification crée une NOUVELLE
       version (l'historique n'est jamais écrasé, spec §64)
     - prix comparable calculé et figé côté serveur (transport +
       frais obligatoires convertis) — le client ne soumet jamais
       lui-même son « prix comparable »
   GET  : offres d'une RFQ, selon le profil :
     - donneur d'ordre : lettres A/B/C… anonymisées + classement
     - transporteur : ses propres offres uniquement
     - plateforme : tout, y compris identités
   ============================================================ */
"use strict";

const { handler, json, readBody, fail } = require("./_lib/respond");
const { getPool, query } = require("./_lib/db");
const { requireAuth } = require("./_lib/auth");
const { loadFx, normalizeQuote, classify } = require("./_lib/ranking");
const { enqueueEmail, flushOutbox, adminEmails } = require("./_lib/notify");

const PLATFORM_ROLES = ["PLATFORM_OPERATIONS", "PLATFORM_FINANCE", "PLATFORM_ADMIN", "SUPER_ADMIN"];
const CARRIER_ROLES = ["CARRIER_USER", "CARRIER_ADMIN"];
const SHIPPER_ROLES = ["SHIPPER_USER", "SHIPPER_ADMIN"];

module.exports = handler(async (req, res) => {
  /* ================= POST : dépôt d'offre ================= */
  if (req.method === "POST") {
    const denied = await requireAuth(CARRIER_ROLES)(req, res);
    if (denied) return;
    const user = req.user;
    const body = await readBody(req);

    const rfqNumber = String(body.rfqNumber || "").trim();
    if (!rfqNumber) return fail(res, 400, "Référence de demande obligatoire.", "MISSING_RFQ");

    /* Transporteur vérifié uniquement */
    const prof = await query(
      `SELECT cp.validation_status, c.status FROM companies c
       LEFT JOIN carrier_profiles cp ON cp.company_id = c.company_id
       WHERE c.company_id = $1`,
      [user.company_id]
    );
    const p = prof.rows[0];
    if (!p || p.validation_status !== "VERIFIED" || p.status !== "ACTIVE") {
      return fail(res, 403, "Compte non vérifié : dépôt d'offre impossible.", "CARRIER_NOT_VERIFIED");
    }

    /* Devise + prix de base */
    const currency = String(body.currency || "EUR").toUpperCase();
    const basePrice = parseFloat(body.baseTransportPrice);
    if (!isFinite(basePrice) || basePrice <= 0) return fail(res, 400, "Prix de transport invalide.", "INVALID_PRICE");

    /* Frais obligatoires : soit un montant explicite, soit « à préciser » */
    const feesToSpecify = body.feesToSpecify === true;
    let mandatoryFees = parseFloat(body.mandatoryFeesTotal);
    if (!isFinite(mandatoryFees) || mandatoryFees < 0) mandatoryFees = 0;

    /* Périmètre : le transporteur déclare si son offre couvre le
       même périmètre que la demande (sinon non comparable). */
    const scopeComparable = body.scopeComparable !== false;
    const nonComplianceReason = scopeComparable ? null : String(body.nonComplianceReason || "Périmètre différent déclaré par le transporteur.").slice(0, 500);

    const transitValue = isFinite(parseFloat(body.transitTimeValue)) ? parseFloat(body.transitTimeValue) : null;
    const transitUnit = ["day", "hour", "week"].includes(String(body.transitTimeUnit)) ? String(body.transitTimeUnit) : "day";
    const validUntil = body.validUntil && !isNaN(Date.parse(body.validUntil)) ? String(body.validUntil).slice(0, 10) : null;
    const conditions = String(body.conditions || "").trim().slice(0, 2000) || null;

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const rfq = await client.query(
        `SELECT r.rfq_id, r.status, r.quote_deadline, r.origin_city, r.destination_city,
                r.shipper_company_id, r.origin_private_address, r.destination_private_address
           FROM rfqs r WHERE r.rfq_number = $1`,
        [rfqNumber]
      );
      if (!rfq.rows.length) {
        await client.query("ROLLBACK");
        return fail(res, 404, "Demande introuvable.", "NOT_FOUND");
      }
      const rfqRow = rfq.rows[0];
      if (rfqRow.status !== "OPEN") {
        await client.query("ROLLBACK");
        return fail(res, 409, "Cette demande n'est plus ouverte aux offres.", "RFQ_CLOSED");
      }
      if (rfqRow.quote_deadline && new Date(rfqRow.quote_deadline) < new Date()) {
        await client.query("ROLLBACK");
        return fail(res, 409, "Le dépôt des offres est clos pour cette demande.", "DEADLINE_PASSED");
      }

      /* Devise connue ? */
      const cur = await client.query("SELECT currency_id FROM currencies WHERE iso_code = $1 AND active", [currency]);
      if (!cur.rows.length) {
        await client.query("ROLLBACK");
        return fail(res, 400, "Devise inconnue : " + currency, "UNKNOWN_CURRENCY");
      }

      /* Version suivante (jamais d'écrasement) */
      const v = await client.query(
        `SELECT COALESCE(max(quote_version), 0) + 1 AS next
           FROM quotes WHERE rfq_id = $1 AND carrier_company_id = $2`,
        [rfqRow.rfq_id, user.company_id]
      );
      const version = v.rows[0].next;

      /* Prix comparable figé côté serveur */
      const fx = await loadFx();
      const probe = normalizeQuote(
        { quote_id: null, rfq_id: rfqRow.rfq_id, carrier_company_id: user.company_id,
          currency, base_transport_price: basePrice, mandatory_fees_total: mandatoryFees,
          fees_to_specify: feesToSpecify, scope_comparable: scopeComparable,
          submitted_at: new Date().toISOString() },
        fx, "EUR"
      );

      const q = await client.query(
        `INSERT INTO quotes (rfq_id, carrier_company_id, quote_version, currency_id,
                             base_transport_price, mandatory_fees_total, comparable_total,
                             commissionable_amount, transit_time_value, transit_time_unit,
                             valid_until, compliance_status, status, conditions,
                             fees_to_specify, scope_comparable, non_compliance_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'SUBMITTED',$13,$14,$15,$16)
         RETURNING quote_id, quote_version, submitted_at`,
        [
          rfqRow.rfq_id, user.company_id, version, cur.rows[0].currency_id,
          basePrice, mandatoryFees, probe.prixComparable, probe.assietteCommission,
          transitValue, transitUnit, validUntil,
          probe.statutTechnique === "CONFORME" ? "CONFORME"
            : probe.statutTechnique === "A_VERIFIER" ? "A_VERIFIER" : "NON_CONFORME",
          conditions, feesToSpecify, scopeComparable, nonComplianceReason
        ]
      );

      /* Lignes de prix : transport (assiette commission) + frais obligatoires */
      await client.query(
        `INSERT INTO quote_price_lines (quote_id, line_type, description, amount, currency_id, mandatory, commissionable, included_in_comparison)
         VALUES ($1,'TRANSPORT','Transport principal',$2,$3,true,true,true)`,
        [q.rows[0].quote_id, basePrice, cur.rows[0].currency_id]
      );
      if (mandatoryFees > 0) {
        await client.query(
          `INSERT INTO quote_price_lines (quote_id, line_type, description, amount, currency_id, mandatory, commissionable, included_in_comparison)
           VALUES ($1,'MANDATORY_FEES','Frais obligatoires déclarés',$2,$3,true,false,true)`,
          [q.rows[0].quote_id, mandatoryFees, cur.rows[0].currency_id]
        );
      }

      /* Snapshot version (historique inaltérable) */
      await client.query(
        `INSERT INTO quote_versions (quote_id, version_number, snapshot_data, modified_by)
         VALUES ($1,$2,$3,$4)`,
        [q.rows[0].quote_id, version,
         JSON.stringify({ basePrice, currency, mandatoryFees, feesToSpecify, scopeComparable, transitValue, validUntil }),
         user.user_id]
      );

      /* Anti-contournement : détecter coordonnées dans les conditions */
      if (conditions && /(?:\+?\d[\d\s.-]{7,}\d)|(?:(?:[a-z0-9_-]+\.)+[a-z]{2,})/i.test(conditions)) {
        await client.query(
          `INSERT INTO content_flags (entity_type, entity_id, flag_type, detected_content, risk_level)
           VALUES ('quotes',$1,'PHONE_DETECTED',$2,'ATTENTION')`,
          [q.rows[0].quote_id, conditions.slice(0, 300)]
        );
      }

      await client.query(
        `INSERT INTO audit_log (user_id, action_type, entity_type, entity_id, new_value)
         VALUES ($1,'QUOTE_SUBMITTED','quotes',$2,$3)`,
        [user.user_id, q.rows[0].quote_id, JSON.stringify({ rfqNumber, version, currency, basePrice })]
      );

      /* Notifications transactionnelles : au donneur d'ordre (sans
         montant : la confidentialité des offres est préservée) et à
         la plateforme (file de travail). */
      const shipper = await client.query(
        `SELECT u.user_id, u.email, u.first_name
           FROM users u
          WHERE u.company_id = $1 AND u.status = 'ACTIVE'
          ORDER BY (u.last_login_at IS NULL), u.last_login_at DESC NULLS LAST
          LIMIT 1`,
        [rfqRow.shipper_company_id]
      );
      if (shipper.rows.length) {
        await enqueueEmail(client, {
          dedupeKey: "quote_received:" + q.rows[0].quote_id,
          eventType: "quote_received",
          entityType: "quotes",
          entityId: q.rows[0].quote_id,
          to: shipper.rows[0].email,
          userId: shipper.rows[0].user_id,
          vars: { firstName: shipper.rows[0].first_name, rfqNumber }
        });
      }
      for (const admin of await adminEmails(client)) {
        await enqueueEmail(client, {
          dedupeKey: "quote_received_admin:" + q.rows[0].quote_id + ":" + admin.email,
          eventType: "quote_received_admin",
          entityType: "quotes",
          entityId: q.rows[0].quote_id,
          to: admin.email,
          vars: { rfqNumber, route: rfqRow.origin_city + " → " + rfqRow.destination_city }
        });
      }

      await client.query("COMMIT");
      await flushOutbox();
      return json(res, 201, {
        quote: {
          quote_id: q.rows[0].quote_id,
          rfqNumber,
          version,
          status: "SUBMITTED",
          compliance_status: probe.statutTechnique,
          comparable_total: probe.prixComparable,
          submitted_at: q.rows[0].submitted_at
        },
        note: "Offre déposée à l'aveugle : le nombre et le montant des autres offres ne sont jamais communiqués."
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /* ================= GET : lecture des offres ================= */
  if (req.method === "GET") {
    const denied = await requireAuth()(req, res);
    if (denied) return;
    const user = req.user;
    const rfqNumber = String((req.query || {}).rfq || "").trim();
    if (!rfqNumber) return fail(res, 400, "Paramètre ?rfq requis.", "MISSING_RFQ");

    const rfq = await query(
      `SELECT r.rfq_id, r.shipper_company_id, r.status FROM rfqs r WHERE r.rfq_number = $1`,
      [rfqNumber]
    );
    if (!rfq.rows.length) return fail(res, 404, "Demande introuvable.", "NOT_FOUND");
    const rfqId = rfq.rows[0].rfq_id;

    const isPlatform = PLATFORM_ROLES.includes(user.role);
    const isShipper = user.company_id === rfq.rows[0].shipper_company_id && SHIPPER_ROLES.includes(user.role);
    const isCarrier = CARRIER_ROLES.includes(user.role);
    if (!isPlatform && !isShipper && !isCarrier) {
      return fail(res, 403, "Accès refusé à ces offres.", "FORBIDDEN");
    }

    let rows;
    if (isCarrier) {
      /* Le transporteur ne voit QUE ses propres offres (aveugle).
         ?mine=1 : toutes ses offres de la RFQ (dernière version). */
      const r = await query(
        `SELECT DISTINCT ON (q.carrier_company_id)
                q.quote_id, q.carrier_company_id, q.quote_version, q.base_transport_price, q.mandatory_fees_total,
                q.comparable_total, q.commissionable_amount, q.transit_time_value, q.transit_time_unit,
                q.valid_until, q.conditions, q.compliance_status, q.status, q.submitted_at, q.updated_at,
                cur.iso_code AS currency,
                q.fees_to_specify, q.scope_comparable, q.non_compliance_reason
           FROM quotes q JOIN currencies cur ON cur.currency_id = q.currency_id
          WHERE q.rfq_id = $1 AND q.carrier_company_id = $2
          ORDER BY q.carrier_company_id, q.quote_version DESC`,
        [rfqId, user.company_id]
      );
      rows = r.rows;
    } else {
      /* Donneur d'ordre / plateforme : dernière version par transporteur */
      const r = await query(
        `SELECT DISTINCT ON (q.carrier_company_id)
                q.quote_id, q.carrier_company_id, q.quote_version, q.base_transport_price,
                q.mandatory_fees_total, q.comparable_total, q.commissionable_amount,
                q.transit_time_value, q.transit_time_unit, q.valid_until, q.conditions,
                q.compliance_status, q.status, q.submitted_at, q.updated_at,
                cur.iso_code AS currency,
                q.fees_to_specify, q.scope_comparable, q.non_compliance_reason
           FROM quotes q JOIN currencies cur ON cur.currency_id = q.currency_id
          WHERE q.rfq_id = $1
          ORDER BY q.carrier_company_id, q.quote_version DESC`,
        [rfqId]
      );
      rows = r.rows;
    }

    /* Classement serveur (normalisation) */
    const fx = await loadFx();
    const normalized = rows.map((row) => normalizeQuote(row, fx, "EUR"));
    const classement = classify(normalized);

    /* Anonymat : les lettres A/B/C suivent l'ordre de dépôt —
       l'identité transporteur n'est révélée qu'après acceptation. */
    const letterOf = {};
    const ordered = rows.slice().sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
    ordered.forEach((row, i) => { letterOf[row.quote_id] = String.fromCharCode(65 + (i % 26)); });

    const revealIdentity = isPlatform || rfq.rows[0].status === "CONFIRMED";

    const out = normalized.map((o) => {
      const base = {
        letter: letterOf[o.quote_id],
        quote_id: o.quote_id,
        version: rows.find((r) => r.quote_id === o.quote_id).quote_version,
        currency: o.currency,
        base_transport_price: o.base_transport_price,
        mandatory_fees_total: o.mandatory_fees_total,
        transportConv: o.transportConv,
        feesConv: o.feesConv,
        prixComparable: o.prixComparable,
        assietteCommission: o.assietteCommission,
        statutTechnique: o.statutTechnique,
        motifNonConformite: o.motifNonConformite,
        transitTime: o.transit_time_value == null ? null : { value: o.transit_time_value, unit: o.transit_time_unit },
        validUntil: o.valid_until,
        conditions: o.conditions,
        submittedAt: o.submitted_at,
        rank: o.rank || null
      };
      if (isCarrier) {
        /* pas de rang ni de classement concurrentiel visible */
        delete base.rank;
      }
      if (revealIdentity) {
        base.carrier_company_id = o.carrier_company_id;
      }
      return base;
    });

    /* Après confirmation : identité légale dévoilée au donneur d'ordre */
    if (revealIdentity && out.length) {
      const ids = out.map((o) => o.carrier_company_id).filter(Boolean);
      if (ids.length) {
        const cos = await query(
          `SELECT company_id, legal_name, main_email, main_phone, city FROM companies WHERE company_id = ANY($1)`,
          [ids]
        );
        const byId = {};
        cos.rows.forEach((c) => { byId[c.company_id] = c; });
        out.forEach((o) => {
          if (o.carrier_company_id && byId[o.carrier_company_id]) {
            o.carrier = byId[o.carrier_company_id];
          }
        });
      }
    }

    /* Affaire : visible du donneur d'ordre et de la plateforme, et du
       transporteur seulement s'il en est partie prenante. Sans ce
       filtre, n'importe quel transporteur du marché lisait le montant
       de la commission et le prix de l'affaire d'un concurrent. */
    const dealParams = [rfqId];
    let dealScope = "";
    if (!isPlatform && !isShipper) {
      dealParams.push(user.company_id);
      dealScope = " AND d.carrier_company_id = $2";
    }
    const affairee = await query(
      `SELECT d.deal_number, d.status, d.commission_rate, d.commission_amount, d.transport_amount
         FROM deals d WHERE d.rfq_id = $1${dealScope}`,
      dealParams
    );

    return json(res, 200, {
      rfqNumber,
      rfqStatus: rfq.rows[0].status,
      quotes: isCarrier ? out : out.sort((a, b) => (a.rank || 99) - (b.rank || 99) || a.letter.localeCompare(b.letter)),
      count: out.length,
      ranking: isCarrier ? undefined : {
        recommandee: classement.recommandee ? letterOf[classement.recommandee.quote_id] : null,
        secours: classement.secours.map((s) => letterOf[s.quote_id])
      },
      deal: affairee.rows[0] || null
    });
  }

  res.setHeader("Allow", "GET, POST");
  return json(res, 405, { error: "Méthode non autorisée." });
});
