/* ============================================================
   Transia — /api/recommendations
   GET  : classement persisté d'une RFQ (donneur d'ordre ou
          plateforme). Le classement n'est visible du client
          qu'après validation administrative (spec : l'algorithme
          propose, l'administrateur valide avant envoi).
   POST : recalcule et persiste le classement (plateforme), puis
          valide la recommandation — soit la proposition n°1 du
          moteur, soit un écart motivé (override journalisé).
          La décision de valider d'office ou de router vers une
          relecture humaine s'appuie sur les probabilités calibrées
          renvoyées par Nace Drex (api/_lib/drex.js).
   ============================================================ */
"use strict";

const { handler, json, readBody, fail } = require("./_lib/respond");
const { getPool, query } = require("./_lib/db");
const { requireAuth } = require("./_lib/auth");
const { loadFx, normalizeQuote, classify } = require("./_lib/ranking");
const { decide } = require("./_lib/drex");
const { enqueueEmail, flushOutbox, companyEmails } = require("./_lib/notify");
const { calculer: calculerCommission } = require("./_lib/commission");

const PLATFORM_ROLES = ["PLATFORM_OPERATIONS", "PLATFORM_ADMIN", "SUPER_ADMIN"];
const SHIPPER_ROLES = ["SHIPPER_USER", "SHIPPER_ADMIN"];

/* Seuil de validation automatique : au-delà, la proposition part
   directement ; en dessous, elle passe en relecture humaine. */
const DREX_VALIDATION_THRESHOLD = 0.7;

/* État transmis à Drex : uniquement les faits utiles à la décision
   (prix comparables, délais, complétude), jamais d'identité. */
function drexCaseState(rfqNumber, rfqRow, classement) {
  const offer = (o) => ({
    rang: o.rank,
    prix_comparable_eur: o.prixComparable,
    delai: o.transit_time_value == null ? null : o.transit_time_value + " " + o.transit_time_unit,
    validite: o.valid_until,
    conditions_renseignees: !!o.conditions
  });
  const first = classement.conforme[0];
  const second = classement.conforme[1];

  return {
    demande: {
      reference: rfqNumber,
      origine: rfqRow.origin_city,
      destination: rfqRow.destination_city
    },
    offres_conformes: classement.conforme.slice(0, 5).map(offer),
    ecart_prix_eur_entre_1_et_2: second ? first.prixComparable - second.prixComparable : null,
    offres_a_verifier: classement.aVerifier.length,
    offres_non_conformes: classement.ecartees.length
  };
}

module.exports = handler(async (req, res) => {
  /* ---------- GET : classement d'une RFQ ---------- */
  if (req.method === "GET") {
    const denied = await requireAuth()(req, res);
    if (denied) return;
    const user = req.user;
    const rfqNumber = String((req.query || {}).rfq || "").trim();
    if (!rfqNumber) return fail(res, 400, "Paramètre ?rfq requis.", "MISSING_RFQ");

    const rfq = await query(
      `SELECT r.rfq_id, r.shipper_company_id, r.status
         FROM rfqs r WHERE r.rfq_number = $1`,
      [rfqNumber]
    );
    if (!rfq.rows.length) return fail(res, 404, "Demande introuvable.", "NOT_FOUND");
    const rfqRow = rfq.rows[0];

    const isPlatform = PLATFORM_ROLES.includes(user.role) || user.role === "PLATFORM_FINANCE";
    const isShipper = user.company_id === rfqRow.shipper_company_id && SHIPPER_ROLES.includes(user.role);
    if (!isPlatform && !isShipper) return fail(res, 403, "Accès refusé.", "FORBIDDEN");

    /* Recommandation persistée */
    const rec = await query(
      `SELECT rec.recommendation_id, rec.status, rec.system_recommended_at,
              rec.admin_validated_at, rec.sent_to_client_at,
              q.quote_id, q.carrier_company_id, q.comparable_total, q.commissionable_amount,
              cur.iso_code AS currency
         FROM rfq_recommendations rec
         JOIN quotes q ON q.quote_id = rec.quote_id
         JOIN currencies cur ON cur.currency_id = q.currency_id
        WHERE rec.rfq_id = $1 AND rec.status <> 'SUPERSEDED'
        ORDER BY rec.system_recommended_at DESC
        LIMIT 1`,
      [rfqRow.rfq_id]
    );

    /* Commission : barème dégressif de la clause CGU, calculé sur la
       seule partie transport de l'offre recommandée. */
    const bareme = rec.rows.length
      ? calculerCommission(rec.rows[0].commissionable_amount)
      : { commission: 0, tauxEffectif: 0 };

    const rankings = await query(
      `SELECT rk.rank_position, rk.comparable_price, rk.system_recommended,
              rk.admin_validated, rk.admin_reason,
              q.quote_id, q.base_transport_price, q.mandatory_fees_total, q.comparable_total,
              q.transit_time_value, q.transit_time_unit, q.valid_until, q.conditions,
              q.compliance_status, cur.iso_code AS currency
         FROM quote_rankings rk
         JOIN quotes q ON q.quote_id = rk.quote_id
         JOIN currencies cur ON cur.currency_id = q.currency_id
        WHERE rk.rfq_id = $1
        ORDER BY rk.rank_position NULLS LAST, q.submitted_at`,
      [rfqRow.rfq_id]
    );

    /* Seules les offres conformes sont classées ; pour le client on
       masque les lignes non classées tant que tout n'est pas validé. */
    const validated = rec.rows.length && rec.rows[0].status !== "PENDING_ADMIN";

    if (isShipper && !validated) {
      return json(res, 200, {
        rfqNumber,
        status: "PENDING_ADMIN",
        message: "Le classement est en cours d'analyse par la plateforme et vous sera présenté après validation."
      });
    }

    /* Lettres anonymes (ordre de dépôt) */
    const letters = await query(
      `SELECT quote_id, row_number() OVER (ORDER BY submitted_at)::int AS n
         FROM quotes WHERE rfq_id = $1`,
      [rfqRow.rfq_id]
    );
    const letterOf = {};
    letters.rows.forEach((r) => { letterOf[r.quote_id] = String.fromCharCode(64 + Math.min(r.n, 26)); });

    return json(res, 200, {
      rfqNumber,
      status: rec.rows.length ? rec.rows[0].status : "NONE",
      validated: !!validated,
      recommended: rec.rows.length ? {
        letter: letterOf[rec.rows[0].quote_id],
        quote_id: rec.rows[0].quote_id,
        comparable_total: rec.rows[0].comparable_total,
        commissionable_amount: rec.rows[0].commissionable_amount,
        commission_rate: bareme.tauxEffectif,
        commission_amount: bareme.commission,
        currency: rec.rows[0].currency,
        validatedAt: rec.rows[0].admin_validated_at,
        sentAt: rec.rows[0].sent_to_client_at
      } : null,
      rankings: rankings.rows.map((r) => ({
        letter: letterOf[r.quote_id],
        rank: r.rank_position,
        comparable_price: r.comparable_price,
        currency: r.currency,
        transitTime: r.transit_time_value == null ? null : { value: r.transit_time_value, unit: r.transit_time_unit },
        validUntil: r.valid_until,
        conditions: r.conditions,
        compliance: r.compliance_status,
        system_recommended: r.system_recommended,
        admin_validated: r.admin_validated,
        admin_reason: r.admin_reason
      }))
    });
  }

  /* ---------- POST : calcul + validation ---------- */
  if (req.method === "POST") {
    const denied = await requireAuth(PLATFORM_ROLES)(req, res);
    if (denied) return;
    const user = req.user;
    const body = await readBody(req);
    const rfqNumber = String(body.rfqNumber || "").trim();
    if (!rfqNumber) return fail(res, 400, "Référence de demande obligatoire.", "MISSING_RFQ");

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const rfq = await client.query(
        `SELECT rfq_id, status, origin_city, destination_city FROM rfqs WHERE rfq_number = $1`,
        [rfqNumber]
      );
      if (!rfq.rows.length) { await client.query("ROLLBACK"); return fail(res, 404, "Demande introuvable.", "NOT_FOUND"); }
      const rfqId = rfq.rows[0].rfq_id;

      /* Recalcul du classement depuis les données réelles —
         DERNIÈRE VERSION par transporteur uniquement (les versions
         antérieures restent en base pour l'historique) */
      const quotes = await client.query(
        `SELECT DISTINCT ON (q.carrier_company_id)
                q.quote_id, q.carrier_company_id, q.base_transport_price, q.mandatory_fees_total,
                q.comparable_total, q.commissionable_amount, q.transit_time_value, q.transit_time_unit,
                q.valid_until, q.conditions, q.compliance_status, q.submitted_at,
                q.fees_to_specify, q.scope_comparable, q.non_compliance_reason,
                cur.iso_code AS currency
           FROM quotes q JOIN currencies cur ON cur.currency_id = q.currency_id
          WHERE q.rfq_id = $1 AND q.status IN ('SUBMITTED','RANKED','SELECTED')
          ORDER BY q.carrier_company_id, q.quote_version DESC`,
        [rfqId]
      );
      if (!quotes.rows.length) { await client.query("ROLLBACK"); return fail(res, 409, "Aucune offre déposée sur cette demande.", "NO_QUOTES"); }

      const fx = await loadFx(client);
      const normalized = quotes.rows.map((q) => normalizeQuote(q, fx, "EUR"));
      const classement = classify(normalized);

      /* Persistance du classement (historique conservé : on supprime
         les entrées système non validées de ce calcul) */
      await client.query(`DELETE FROM quote_rankings WHERE rfq_id = $1 AND admin_validated = false`, [rfqId]);

      for (const o of classement.conforme) {
        await client.query(
          `INSERT INTO quote_rankings (rfq_id, quote_id, rank_position, comparable_price, system_recommended)
           VALUES ($1,$2,$3,$4,$5)`,
          [rfqId, o.quote_id, o.rank, o.prixComparable, o.rank === 1]
        );
        await client.query(
          `UPDATE quotes SET rank = $2, comparable_total = $3, commissionable_amount = $4,
                              compliance_status = 'CONFORME', updated_at = now()
            WHERE quote_id = $1`,
          [o.quote_id, o.rank, o.prixComparable, o.assietteCommission]
        );
      }
      for (const o of classement.aVerifier) {
        await client.query(
          `UPDATE quotes SET comparable_total = NULL, compliance_status = 'A_VERIFIER', updated_at = now()
            WHERE quote_id = $1`,
          [o.quote_id]
        );
      }
      for (const o of classement.ecartees) {
        await client.query(
          `UPDATE quotes SET compliance_status = 'NON_CONFORME', updated_at = now() WHERE quote_id = $1`,
          [o.quote_id]
        );
      }

      if (!classement.recommandee) {
        await client.query("COMMIT");
        return json(res, 200, {
          rfqNumber,
          status: "NO_CONFORME_QUOTE",
          message: "Aucune offre conforme : clarification requise avant recommandation.",
          aVerifier: classement.aVerifier.length,
          ecartees: classement.ecartees.length
        });
      }

      /* Nouvelle recommandation système (l'ancienne devient SUPERSEDED) */
      await client.query(
        `UPDATE rfq_recommendations SET status = 'SUPERSEDED' WHERE rfq_id = $1 AND status <> 'SUPERSEDED'`,
        [rfqId]
      );

      const motorPick = classement.recommandee;
      let chosen = motorPick;
      let overrideReason = null;

      /* Écart motivé : le client admin peut retenir une autre offre conforme */
      if (body.overrideQuoteId) {
        const alt = classement.conforme.find((o) => o.quote_id === String(body.overrideQuoteId));
        if (!alt) { await client.query("ROLLBACK"); return fail(res, 400, "L'offre retenue doit être conforme et avoir été déposée.", "INVALID_OVERRIDE"); }
        const motif = String(body.overrideReason || "").trim();
        if (motif.length < 5) {
          await client.query("ROLLBACK");
          return fail(res, 400, "Motif d'écart obligatoire (journalisé, spec : jamais d'écart sans motif).", "OVERRIDE_REASON_REQUIRED");
        }
        chosen = alt;
        overrideReason = motif;
      }

      /* ---------- Décision assistée (Nace Drex) ----------
         L'algorithme propose ; Drex renvoie la probabilité calibrée
         de chaque issue (validation d'office / relecture humaine) et
         on route sur ces probabilités. Un écart motivé est déjà une
         décision humaine : on ne la double pas d'un appel Drex. Sans
         NACE_API_KEY, la plateforme garde son comportement actuel. */
      let drex = null;
      if (!overrideReason) {
        try {
          drex = await decide({
            questionId: "validation_route",
            threshold: DREX_VALIDATION_THRESHOLD,
            instructions: "Le classement de ces offres peut-il être validé d'office et présenté au donneur d'ordre, ou doit-il être relu par un opérateur de la plateforme avant envoi ?",
            options: {
              auto_validate: "Une offre conforme domine clairement les autres, l'écart de prix est net et les offres sont complètes : la proposition n°1 peut être validée d'office.",
              human_review: "Les offres sont trop proches, incomplètes ou ambiguës : un opérateur doit relire le classement avant qu'il soit présenté au donneur d'ordre."
            },
            state: drexCaseState(rfqNumber, rfq.rows[0], classement)
          });
        } catch (err) {
          console.warn("[drex] décision indisponible :", err.code || err.message);
        }
      }
      const autoValidate = !drex || drex.routed === "auto";

      const rec = await client.query(
        `INSERT INTO rfq_recommendations (rfq_id, quote_id, status)
         VALUES ($1,$2,'PENDING_ADMIN')
         RETURNING recommendation_id, system_recommended_at`,
        [rfqId, chosen.quote_id]
      );

      if (!autoValidate) {
        /* Routée vers la relecture : la recommandation reste en attente
           d'un opérateur, rien n'est envoyé au donneur d'ordre. */
        await client.query(
          `INSERT INTO audit_log (user_id, action_type, entity_type, entity_id, old_value, new_value, reason)
           VALUES ($1,'RECOMMENDATION_PENDING_REVIEW','rfqs',$2,$3,$4,$5)`,
          [user.user_id, rfqId,
           JSON.stringify({ motorPick: motorPick.quote_id }),
           JSON.stringify({ chosen: chosen.quote_id, comparable: chosen.prixComparable, drex }),
           "Décision automatique sous le seuil : relecture opérateur requise."]
        );
        await client.query("COMMIT");
        return json(res, 200, {
          rfqNumber,
          status: "PENDING_ADMIN",
          message: "Recommandation en attente de relecture : la décision automatique n'atteint pas le seuil de confiance.",
          recommended: {
            quote_id: chosen.quote_id,
            comparable_total: chosen.prixComparable,
            commissionable_amount: chosen.assietteCommission,
            rank: chosen.rank
          },
          drex,
          secours: classement.secours.map((s) => s.quote_id),
          stats: { conforme: classement.conforme.length, aVerifier: classement.aVerifier.length, ecartees: classement.ecartees.length }
        });
      }

      /* Validation immédiate de la recommandation par l'admin qui exécute */
      await client.query(
        `UPDATE rfq_recommendations SET status = 'VALIDATED', admin_validated_at = now()
          WHERE recommendation_id = $1`,
        [rec.rows[0].recommendation_id]
      );
      await client.query(
        `UPDATE quote_rankings SET admin_validated = true, admin_user_id = $3, admin_reason = $4
          WHERE rfq_id = $1 AND quote_id = $2`,
        [rfqId, chosen.quote_id, user.user_id, overrideReason]
      );
      await client.query(`UPDATE rfqs SET status = 'RECOMMENDED' WHERE rfq_id = $1 AND status IN ('OPEN','COTATION','ANALYSIS')`, [rfqId]);

      await client.query(
        `INSERT INTO audit_log (user_id, action_type, entity_type, entity_id, old_value, new_value, reason)
         VALUES ($1,'RECOMMENDATION_VALIDATED','rfqs',$2,$3,$4,$5)`,
        [user.user_id, rfqId,
         JSON.stringify({ motorPick: motorPick.quote_id }),
         JSON.stringify({ chosen: chosen.quote_id, comparable: chosen.prixComparable, drex }),
         overrideReason]
      );

      /* Notification transactionnelle : le comparatif est prêt —
         le donneur d'ordre est invité à accepter ou refuser. */
      const rfqFull = await client.query(
        `SELECT r.shipper_company_id, r.origin_city, r.destination_city
           FROM rfqs r WHERE r.rfq_id = $1`,
        [rfqId]
      );
      const shipper = await companyEmails(client, rfqFull.rows[0].shipper_company_id);
      if (shipper) {
        await enqueueEmail(client, {
          dedupeKey: "recommendation_ready:" + rfqId + ":" + rec.rows[0].recommendation_id,
          eventType: "recommendation_ready",
          entityType: "rfqs",
          entityId: rfqId,
          to: shipper.email,
          userId: shipper.user_id,
          vars: { firstName: shipper.first_name, rfqNumber, offers: classement.conforme.length }
        });
      }

      await client.query("COMMIT");
      await flushOutbox(client);

      return json(res, 200, {
        rfqNumber,
        status: "VALIDATED",
        recommended: {
          quote_id: chosen.quote_id,
          comparable_total: chosen.prixComparable,
          commissionable_amount: chosen.assietteCommission,
          rank: chosen.rank
        },
        // Probabilités Drex ayant servi au routage (null : Drex non configuré/injoignable).
        drex,
        override: overrideReason ? { from: motorPick.quote_id, reason: overrideReason } : null,
        secours: classement.secours.map((s) => s.quote_id),
        stats: { conforme: classement.conforme.length, aVerifier: classement.aVerifier.length, ecartees: classement.ecartees.length }
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  res.setHeader("Allow", "GET, POST");
  return json(res, 405, { error: "Méthode non autorisée." });
});
