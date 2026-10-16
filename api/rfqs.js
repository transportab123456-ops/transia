/* ============================================================
   Transia — /api/rfqs
   GET  : liste des RFQ visibles pour l'utilisateur connecté.
          RBAC côté serveur : un shipper ne voit que les siennes ;
          un rôle plateforme voit tout.
   POST : création d'une RFQ (transaction) :
          numéro mondial unique RFQ-AAAA-NNNNNN, localisation
          publique (ville) + adresse privée séparées, cargo,
          entrée audit.
   ============================================================ */
"use strict";

const { handler, json, readBody, fail } = require("./_lib/respond");
const { getPool, query } = require("./_lib/db");
const { requireAuth } = require("./_lib/auth");
const { enqueueEmail, flushOutbox } = require("./_lib/notify");

const PLATFORM_ROLES = ["PLATFORM_OPERATIONS", "PLATFORM_FINANCE", "PLATFORM_ADMIN", "SUPER_ADMIN"];
const SHIPPER_ROLES = ["SHIPPER_USER", "SHIPPER_ADMIN"];

async function nextRfqNumber(client) {
  const r = await client.query(
    `SELECT 'RFQ-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('rfq_number_seq')::text, 6, '0') AS n`
  );
  return r.rows[0].n;
}

module.exports = handler(async (req, res) => {
  if (req.method === "GET") {
    const denied = await requireAuth()(req, res);
    if (denied) return;
    const user = req.user;

    const params = [];
    let where = "";
    if (!PLATFORM_ROLES.includes(user.role)) {
      params.push(user.company_id);
      where = "WHERE r.shipper_company_id = $" + params.length;
    }
    params.push(100);
    const limitIdx = "$" + (params.length);

    const r = await query(
      `SELECT r.rfq_id, r.rfq_number, r.origin_city, r.destination_city,
              oc.iso_code AS origin_country, dc.iso_code AS destination_country,
              m.code AS mode, r.status, r.pickup_date, r.quote_deadline, r.created_at
         FROM rfqs r
         LEFT JOIN countries oc ON oc.country_id = r.origin_country_id
         LEFT JOIN countries dc ON dc.country_id = r.destination_country_id
         LEFT JOIN transport_modes m ON m.transport_mode_id = r.transport_mode_id
         ${where}
        ORDER BY r.created_at DESC
        LIMIT ${limitIdx}`,
      params
    );
    return json(res, 200, { rfqs: r.rows, count: r.rows.length });
  }

  if (req.method === "POST") {
    const denied = await requireAuth(SHIPPER_ROLES)(req, res);
    if (denied) return;
    const user = req.user;
    const body = await readBody(req);

    /* ---- Validation des entrées ---- */
    const originCity = String(body.originCity || "").trim();
    const destCity = String(body.destinationCity || "").trim();
    const originCountry = String(body.originCountry || "").trim().toUpperCase();
    const destCountry = String(body.destinationCountry || "").trim().toUpperCase();
    if (!originCity || !destCity) return fail(res, 400, "Villes d'origine et de destination obligatoires.", "MISSING_ROUTE");
    if (!/^[A-Z]{2}$/.test(originCountry) || !/^[A-Z]{2}$/.test(destCountry)) {
      return fail(res, 400, "Codes pays ISO à 2 lettres attendus (ex. FR, MA).", "INVALID_COUNTRY");
    }
    const modeCode = String(body.mode || "").toUpperCase(); // ROAD|SEA|AIR|MULTIMODAL
    if (!["ROAD", "SEA", "AIR", "MULTIMODAL"].includes(modeCode)) {
      return fail(res, 400, "Mode invalide : ROAD, SEA, AIR ou MULTIMODAL.", "INVALID_MODE");
    }
    const incoterm = body.incoterm ? String(body.incoterm).toUpperCase() : null;
    if (incoterm && !/^[A-Z]{3}$/.test(incoterm)) return fail(res, 400, "Incoterm invalide (EXW, FOB…).", "INVALID_INCOTERM");

    const dangerous = body.dangerousGoods === true || body.dangerousGoods === "true";
    const dangerousFields = ["unNumber", "hazardClass"];
    if (dangerous) {
      for (const f of dangerousFields) {
        if (!String(body[f] || "").trim()) return fail(res, 400, "Marchandise dangereuse : numéro ONU et classe obligatoires.", "MISSING_DG_FIELDS");
      }
    }

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const iso = async (code) => {
        const r = await client.query("SELECT country_id FROM countries WHERE iso_code = $1", [code]);
        if (!r.rows.length) { const e = new Error("Pays inconnu : " + code); e.status = 400; e.code = "UNKNOWN_COUNTRY"; throw e; }
        return r.rows[0].country_id;
      };
      const originCountryId = await iso(originCountry);
      const destCountryId = await iso(destCountry);

      const modeRow = await client.query("SELECT transport_mode_id FROM transport_modes WHERE code = $1", [modeCode]);
      if (!modeRow.rows.length) { const e = new Error("Mode introuvable."); e.status = 400; e.code = "INVALID_MODE"; throw e; }
      const modeId = modeRow.rows[0].transport_mode_id;

      let incotermId = null;
      if (incoterm) {
        const r = await client.query("SELECT incoterm_id FROM incoterms WHERE code = $1 AND active", [incoterm]);
        if (!r.rows.length) { const e = new Error("Incoterm inconnu : " + incoterm); e.status = 400; e.code = "INVALID_INCOTERM"; throw e; }
        incotermId = r.rows[0].incoterm_id;
      }

      const rfqNumber = await nextRfqNumber(client);

      /* Localisation publique (ville) vs adresse privée : séparation
         native demandée par le spec (masquage avant confirmation). */
      const rfq = await client.query(
        `INSERT INTO rfqs (rfq_number, shipper_company_id, created_by_user_id,
                           origin_country_id, origin_city, origin_postal_code, origin_public_location, origin_private_address,
                           destination_country_id, destination_city, destination_postal_code, destination_public_location, destination_private_address,
                           transport_mode_id, incoterm_id, pickup_date, quote_deadline, quote_currency_id,
                           status, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'OPEN', now())
         RETURNING rfq_id, rfq_number, status, created_at`,
        [
          rfqNumber, user.company_id, user.user_id,
          originCountryId, originCity, String(body.originPostalCode || "").trim() || null,
          String(body.originPublicLocation || originCity).trim(),
          String(body.originPrivateAddress || "").trim() || null,
          destCountryId, destCity, String(body.destinationPostalCode || "").trim() || null,
          String(body.destinationPublicLocation || destCity).trim(),
          String(body.destinationPrivateAddress || "").trim() || null,
          modeId, incotermId,
          body.pickupDate && /^\d{4}-\d{2}-\d{2}$/.test(body.pickupDate) ? body.pickupDate : null,
          body.quoteDeadline && !isNaN(Date.parse(body.quoteDeadline)) ? new Date(body.quoteDeadline) : null,
          null
        ]
      );
      const rfqId = rfq.rows[0].rfq_id;

      await client.query(
        `INSERT INTO rfq_cargo (rfq_id, description, package_count, pallet_count, gross_weight, volume, dangerous_goods)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          rfqId,
          String(body.cargoDescription || "").trim() || null,
          Number.isInteger(+body.packageCount) && +body.packageCount > 0 ? +body.packageCount : null,
          Number.isInteger(+body.palletCount) && +body.palletCount > 0 ? +body.palletCount : null,
          isFinite(parseFloat(body.grossWeight)) ? parseFloat(body.grossWeight) : null,
          isFinite(parseFloat(body.volume)) ? parseFloat(body.volume) : null,
          dangerous
        ]
      );

      if (dangerous) {
        const cargo = await client.query("SELECT rfq_cargo_id FROM rfq_cargo WHERE rfq_id = $1", [rfqId]);
        await client.query(
          `INSERT INTO dangerous_goods_details (rfq_cargo_id, un_number, proper_shipping_name, hazard_class, packing_group, quantity)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            cargo.rows[0].rfq_cargo_id,
            String(body.unNumber || "").trim(),
            String(body.properShippingName || "").trim() || null,
            String(body.hazardClass || "").trim(),
            String(body.packingGroup || "").trim() || null,
            String(body.quantity || "").trim() || null
          ]
        );
      }

      await client.query(
        `INSERT INTO audit_log (user_id, action_type, entity_type, entity_id, new_value)
         VALUES ($1,'RFQ_CREATED','rfqs',$2,$3)`,
        [user.user_id, rfqId, JSON.stringify({ rfqNumber, mode: modeCode })]
      );

      /* Notification transactionnelle : confirmation de publication */
      await enqueueEmail(client, {
        dedupeKey: "rfq_created:" + rfqId + ":" + user.user_id,
        eventType: "rfq_created",
        entityType: "rfqs",
        entityId: rfqId,
        to: user.email,
        userId: user.user_id,
        vars: {
          firstName: user.first_name, rfqNumber,
          route: originCity + " → " + destCity,
          mode: { ROAD: "Routier", SEA: "Maritime", AIR: "Aérien", MULTIMODAL: "Multimodal" }[modeCode] || modeCode
        }
      });

      await client.query("COMMIT");
      await flushOutbox();
      return json(res, 201, { rfq: rfq.rows[0] });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err.code === "UNKNOWN_COUNTRY" || err.code === "INVALID_MODE" || err.code === "INVALID_INCOTERM") {
        return fail(res, err.status || 400, err.message, err.code);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  res.setHeader("Allow", "GET, POST");
  return json(res, 405, { error: "Méthode non autorisée." });
});
