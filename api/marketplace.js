/* ============================================================
   Transia — /api/marketplace
   GET : RFQ ouvertes pour les transporteurs VÉRIFIÉS.
   Cotation à l'aveugle côté serveur :
   - aucune identité du donneur d'ordre (ni entreprise, ni contact)
   - l'adresse privée n'est jamais exposée avant confirmation
   - seul le nombre d'offres déposées est masqué aussi
   ============================================================ */
"use strict";

const { handler, json, fail } = require("./_lib/respond");
const { query } = require("./_lib/db");
const { requireAuth } = require("./_lib/auth");

const CARRIER_ROLES = ["CARRIER_USER", "CARRIER_ADMIN"];

module.exports = handler(async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: "Méthode non autorisée." });
  }

  const denied = await requireAuth(CARRIER_ROLES)(req, res);
  if (denied) return;
  const user = req.user;

  /* Seuls les transporteurs vérifiés et actifs accèdent au marché. */
  const prof = await query(
    `SELECT cp.validation_status, c.status
       FROM companies c LEFT JOIN carrier_profiles cp ON cp.company_id = c.company_id
      WHERE c.company_id = $1`,
    [user.company_id]
  );
  const p = prof.rows[0];
  if (!p || p.validation_status !== "VERIFIED" || p.status !== "ACTIVE") {
    return fail(res, 403, "Compte non vérifié : accès au marché indisponible.", "CARRIER_NOT_VERIFIED");
  }

  /* Filtres facultatifs */
  const params = [];
  const where = ["r.status = 'OPEN'", "r.published_at IS NOT NULL"];
  const q = req.query || {};
  if (q.mode && /^[A-Z]+$/.test(String(q.mode))) {
    params.push(String(q.mode));
    where.push(`m.code = $${params.length}`);
  }
  if (q.originCountry && /^[A-Z]{2}$/.test(String(q.originCountry))) {
    params.push(String(q.originCountry));
    where.push(`oc.iso_code = $${params.length}`);
  }
  if (q.destinationCountry && /^[A-Z]{2}$/.test(String(q.destinationCountry))) {
    params.push(String(q.destinationCountry));
    where.push(`dc.iso_code = $${params.length}`);
  }

  /* Détail d'une RFQ précise */
  if (q.rfq) {
    params.push(String(q.rfq));
    const r = await query(
      `SELECT r.rfq_id, r.rfq_number, r.status, r.pickup_date, r.quote_deadline,
              oc.iso_code AS origin_country, r.origin_city, r.origin_public_location,
              dc.iso_code AS destination_country, r.destination_city, r.destination_public_location,
              m.code AS mode, i.code AS incoterm,
              cargo.description, cargo.package_count, cargo.pallet_count,
              cargo.gross_weight, cargo.volume, cargo.dangerous_goods,
              (SELECT count(*)::int FROM quotes q2 WHERE q2.rfq_id = r.rfq_id AND q2.carrier_company_id = $${params.length + 1}) AS my_quotes
         FROM rfqs r
         LEFT JOIN countries oc ON oc.country_id = r.origin_country_id
         LEFT JOIN countries dc ON dc.country_id = r.destination_country_id
         LEFT JOIN transport_modes m ON m.transport_mode_id = r.transport_mode_id
         LEFT JOIN incoterms i ON i.incoterm_id = r.incoterm_id
         LEFT JOIN rfq_cargo cargo ON cargo.rfq_id = r.rfq_id
        WHERE r.rfq_number = $${params.length} AND ${where.join(" AND ")}`,
      params.concat([user.company_id])
    );
    if (!r.rows.length) return fail(res, 404, "Demande introuvable ou non ouverte.", "NOT_FOUND");
    const row = r.rows[0];
    /* On retire l'identifiant interne du résultat public */
    const { rfq_id, ...pub } = row;
    return json(res, 200, { rfq: pub });
  }

  /* Liste du marché */
  params.push(user.company_id);
  const myCo = `$${params.length}`;
  const r = await query(
    `SELECT r.rfq_number, r.pickup_date, r.quote_deadline,
            oc.iso_code AS origin_country, r.origin_city,
            dc.iso_code AS destination_country, r.destination_city,
            m.code AS mode, i.code AS incoterm,
            cargo.gross_weight, cargo.volume, cargo.pallet_count, cargo.dangerous_goods,
            EXISTS (SELECT 1 FROM quotes q2 WHERE q2.rfq_id = r.rfq_id AND q2.carrier_company_id = ${myCo}) AS already_quoted
       FROM rfqs r
       LEFT JOIN countries oc ON oc.country_id = r.origin_country_id
       LEFT JOIN countries dc ON dc.country_id = r.destination_country_id
       LEFT JOIN transport_modes m ON m.transport_mode_id = r.transport_mode_id
       LEFT JOIN incoterms i ON i.incoterm_id = r.incoterm_id
       LEFT JOIN rfq_cargo cargo ON cargo.rfq_id = r.rfq_id
      WHERE ${where.join(" AND ")}
      ORDER BY r.published_at DESC
      LIMIT 200`,
    params
  );

  /* Le nombre d'offres n'est JAMAIS communiqué (règle d'aveugle) */
  return json(res, 200, { rfqs: r.rows, count: r.rows.length });
});
