/* ============================================================
   Transia — /api/admin
   Back-office plateforme (rôles PLATFORM_* / SUPER_ADMIN).
   GET  ?view=overview   : KPI réels (RFQ, offres, affaires, commissions)
   GET  ?view=carriers   : file de vérification des transporteurs
   GET  ?view=companies  : annuaire des entreprises
   POST action=verify    : valide/suspend/réactive un transporteur
                           (décision + motif journalisés)
   ============================================================ */
"use strict";

const { handler, json, readBody, fail } = require("./_lib/respond");
const { getPool, query } = require("./_lib/db");
const { requireAuth } = require("./_lib/auth");

const PLATFORM_ROLES = ["PLATFORM_OPERATIONS", "PLATFORM_FINANCE", "PLATFORM_ADMIN", "SUPER_ADMIN"];

module.exports = handler(async (req, res) => {
  /* ================= GET : vues de lecture ================= */
  if (req.method === "GET") {
    const denied = await requireAuth(PLATFORM_ROLES)(req, res);
    if (denied) return;
    const view = String((req.query || {}).view || "overview");

    if (view === "overview") {
      const [rfqs, quotes, deals, carriers, commissions] = await Promise.all([
        query(`SELECT count(*)::int AS total,
                      count(*) FILTER (WHERE status = 'OPEN')::int AS ouvertes,
                      count(*) FILTER (WHERE status = 'CONFIRMED')::int AS confirmees
                 FROM rfqs`),
        query(`SELECT count(*)::int AS total,
                      count(DISTINCT rfq_id)::int AS rfq_avec_offre
                 FROM quotes WHERE status = 'SUBMITTED' OR status = 'SELECTED' OR status = 'RANKED'`),
        query(`SELECT count(*)::int AS total, COALESCE(sum(commission_amount),0) AS commission
                 FROM deals`),
        query(`SELECT count(*)::int AS total,
                      count(*) FILTER (WHERE cp.validation_status = 'PENDING')::int AS en_attente
                 FROM companies c JOIN company_roles cr ON cr.company_id = c.company_id AND cr.role_type = 'CARRIER'
                 LEFT JOIN carrier_profiles cp ON cp.company_id = c.company_id`),
        query(`SELECT COALESCE(sum(total_amount),0) AS total,
                      count(*) FILTER (WHERE status = 'CALCULATED')::int AS en_attente
                 FROM commissions`)
      ]);

      const tauxReponse = rfqs.rows[0].total
        ? Math.round((quotes.rows[0].rfq_avec_offre / rfqs.rows[0].total) * 100)
        : 0;

      return json(res, 200, {
        rfqs: rfqs.rows[0],
        quotes: quotes.rows[0],
        deals: deals.rows[0],
        carriers: carriers.rows[0],
        commissions: commissions.rows[0],
        metrics: {
          taux_reponse: tauxReponse,
          offres_par_rfq: rfqs.rows[0].total
            ? +(quotes.rows[0].total / Math.max(quotes.rows[0].rfq_avec_offre, 1)).toFixed(1)
            : 0
        }
      });
    }

    if (view === "carriers") {
      const r = await query(
        `SELECT c.company_id, c.legal_name, c.tax_id, c.vat_number, c.main_email,
                c.main_phone, c.status, co.iso_code AS country,
                cp.validation_status, cp.insurance_status, cp.license_status, cp.verified_at,
                COALESCE(array_agg(DISTINCT m.code) FILTER (WHERE m.code IS NOT NULL), '{}') AS modes
           FROM companies c
           JOIN company_roles cr ON cr.company_id = c.company_id AND cr.role_type = 'CARRIER'
           LEFT JOIN countries co ON co.country_id = c.country_id
           LEFT JOIN carrier_profiles cp ON cp.company_id = c.company_id
           LEFT JOIN carrier_transport_modes ctm ON ctm.company_id = c.company_id
           LEFT JOIN transport_modes m ON m.transport_mode_id = ctm.transport_mode_id
          GROUP BY c.company_id, co.iso_code, cp.carrier_profile_id
          ORDER BY (cp.validation_status = 'PENDING') DESC, c.created_at DESC
          LIMIT 200`
      );
      return json(res, 200, { carriers: r.rows, count: r.rows.length });
    }

    if (view === "companies") {
      const r = await query(
        `SELECT c.company_id, c.legal_name, c.status, co.iso_code AS country,
                string_agg(DISTINCT cr.role_type, ', ') AS roles,
                c.created_at,
                (SELECT count(*)::int FROM rfqs r WHERE r.shipper_company_id = c.company_id) AS rfqs,
                (SELECT count(*)::int FROM quotes q WHERE q.carrier_company_id = c.company_id) AS quotes
           FROM companies c
           LEFT JOIN countries co ON co.country_id = c.country_id
           LEFT JOIN company_roles cr ON cr.company_id = c.company_id AND cr.active
          GROUP BY c.company_id, co.iso_code
          ORDER BY c.created_at DESC
          LIMIT 300`
      );
      return json(res, 200, { companies: r.rows, count: r.rows.length });
    }

    return fail(res, 400, "Vue inconnue : overview, carriers ou companies.", "INVALID_VIEW");
  }

  /* ================= POST : décisions ================= */
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: "Méthode non autorisée." });
  }

  const denied = await requireAuth(PLATFORM_ROLES)(req, res);
  if (denied) return;
  const user = req.user;
  const body = await readBody(req);
  const action = String(body.action || "");
  const companyId = String(body.companyId || "").trim();

  if (!companyId) return fail(res, 400, "Identifiant d'entreprise requis.", "MISSING_COMPANY");

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const co = await client.query(
      `SELECT c.company_id, c.legal_name, c.status, cp.carrier_profile_id, cp.validation_status
         FROM companies c
         LEFT JOIN carrier_profiles cp ON cp.company_id = c.company_id
        WHERE c.company_id = $1 FOR UPDATE OF c`,
      [companyId]
    );
    if (!co.rows.length) { await client.query("ROLLBACK"); return fail(res, 404, "Entreprise introuvable.", "NOT_FOUND"); }
    const row = co.rows[0];

    if (action === "verify") {
      if (!row.carrier_profile_id) {
        await client.query("ROLLBACK");
        return fail(res, 400, "Cette entreprise n'a pas de profil transporteur.", "NOT_A_CARRIER");
      }
      const decision = String(body.decision || "").toUpperCase();
      const motif = String(body.reason || "").trim() || null;

      if (!["VERIFIED", "REJECTED", "SUSPENDED"].includes(decision)) {
        await client.query("ROLLBACK");
        return fail(res, 400, "Décision invalide : VERIFIED, REJECTED ou SUSPENDED.", "INVALID_DECISION");
      }
      /* Suspension / rejet exigent un motif (décision traçable) */
      if (decision !== "VERIFIED" && (!motif || motif.length < 5)) {
        await client.query("ROLLBACK");
        return fail(res, 400, "Motif obligatoire pour suspendre ou rejeter.", "REASON_REQUIRED");
      }

      const oldStatus = row.validation_status;

      await client.query(
        `UPDATE carrier_profiles
            SET validation_status = $2,
                verified_at = CASE WHEN $2 = 'VERIFIED' THEN now() ELSE verified_at END,
                verified_by = $3,
                active = $2 = 'VERIFIED'
          WHERE carrier_profile_id = $1`,
        [row.carrier_profile_id, decision, user.user_id]
      );
      /* Une suspension bloque aussi l'accès au marché côté entreprise */
      const companyStatus = decision === "VERIFIED" ? "ACTIVE" : decision === "SUSPENDED" ? "SUSPENDED" : "PENDING";
      await client.query(`UPDATE companies SET status = $2, updated_at = now() WHERE company_id = $1`, [companyId, companyStatus]);

      await client.query(
        `INSERT INTO audit_log (user_id, action_type, entity_type, entity_id, old_value, new_value, reason)
         VALUES ($1,'CARRIER_VERIFICATION','companies',$2,$3,$4,$5)`,
        [user.user_id, companyId,
         JSON.stringify({ validation_status: oldStatus }),
         JSON.stringify({ validation_status: decision, company_status: companyStatus }),
         motif]
      );

      await client.query("COMMIT");
      return json(res, 200, {
        company_id: companyId,
        validation_status: decision,
        company_status: companyStatus,
        message: decision === "VERIFIED"
          ? "Transporteur vérifié : il peut désormais accéder au marché et déposer des offres."
          : "Décision enregistrée et journalisée."
      });
    }

    await client.query("ROLLBACK");
    return fail(res, 400, "Action inconnue : verify.", "INVALID_ACTION");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});
