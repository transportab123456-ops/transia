/* ============================================================
   Transia — /api/carriers
   POST : inscription d'un transporteur.
     Crée l'entreprise (rôle CARRIER), le profil transporteur
     (validation PENDING — le back-office garde la décision
     finale d'activation, spec back-office) et l'utilisateur
     CARRIER_USER, en transaction. Ouvre une session.
   GET  : profil du transporteur connecté + état de vérification.
   ============================================================ */
"use strict";

const { handler, json, readBody, fail } = require("./_lib/respond");
const { getPool, query } = require("./_lib/db");
const { hashPassword, createSession, sessionCookie, requireAuth } = require("./_lib/auth");
const { rateLimit, recordAttempt, clientIp } = require("./_lib/security");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MODES = ["ROAD", "SEA", "AIR", "MULTIMODAL"];

module.exports = handler(async (req, res) => {
  /* ---------- Profil du transporteur connecté ---------- */
  if (req.method === "GET") {
    const denied = await requireAuth(["CARRIER_USER", "CARRIER_ADMIN"])(req, res);
    if (denied) return;
    const user = req.user;
    const r = await query(
      `SELECT c.company_id, c.legal_name, c.status AS company_status,
              cp.validation_status, cp.insurance_status, cp.license_status,
              cp.verified_at,
              COALESCE(array_agg(DISTINCT m.code) FILTER (WHERE m.code IS NOT NULL), '{}') AS modes
         FROM companies c
         LEFT JOIN carrier_profiles cp ON cp.company_id = c.company_id
         LEFT JOIN carrier_transport_modes ctm ON ctm.company_id = c.company_id
         LEFT JOIN transport_modes m ON m.transport_mode_id = ctm.transport_mode_id
        WHERE c.company_id = $1
        GROUP BY c.company_id, cp.carrier_profile_id`,
      [user.company_id]
    );
    if (!r.rows.length) return fail(res, 404, "Profil transporteur introuvable.", "NOT_FOUND");
    const row = r.rows[0];
    return json(res, 200, {
      company: {
        company_id: row.company_id,
        legal_name: row.legal_name,
        status: row.company_status
      },
      verification: {
        status: row.validation_status || "PENDING",
        insurance: row.insurance_status,
        license: row.license_status,
        verified_at: row.verified_at
      },
      modes: row.modes
    });
  }

  /* ---------- Inscription transporteur ---------- */
  if (req.method === "POST") {
    const rl = await rateLimit(req, "carrier-register", clientIp(req), 10, 60);
    if (!rl.allowed) {
      res.setHeader("Retry-After", String(rl.retryAfterSec));
      return fail(res, 429, "Trop d'inscriptions. Réessayez plus tard.", "RATE_LIMITED");
    }

    const body = await readBody(req);
    const legalName = String(body.companyName || "").trim();
    const countryCode = String(body.countryCode || "").trim().toUpperCase();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const firstName = String(body.firstName || "").trim();
    const lastName = String(body.lastName || "").trim();
    const phone = String(body.phone || "").trim() || null;
    const taxId = String(body.taxId || "").trim() || null;      // immatriculation
    const vatNumber = String(body.vatNumber || "").trim() || null;
    const modes = Array.isArray(body.modes) ? body.modes.map((m) => String(m).toUpperCase()) : [];

    if (!legalName) return fail(res, 400, "Raison sociale obligatoire.", "MISSING_COMPANY");
    if (!EMAIL_RE.test(email)) return fail(res, 400, "E-mail professionnel invalide.", "INVALID_EMAIL");
    if (password.length < 10) return fail(res, 400, "Mot de passe : 10 caractères minimum.", "WEAK_PASSWORD");
    if (!firstName || !lastName) return fail(res, 400, "Nom et prénom obligatoires.", "MISSING_NAME");
    if (!/^[A-Z]{2}$/.test(countryCode)) return fail(res, 400, "Code pays ISO à 2 lettres attendu.", "INVALID_COUNTRY");
    const cleanModes = modes.filter((m) => MODES.includes(m));
    if (!cleanModes.length) return fail(res, 400, "Au moins un mode de transport est requis.", "MISSING_MODES");

    const existing = await query("SELECT 1 FROM users WHERE email = $1", [email]);
    if (existing.rows.length) return fail(res, 409, "Un compte existe déjà avec cet e-mail.", "EMAIL_TAKEN");

    const passwordHash = await hashPassword(password);
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const c = await client.query("SELECT country_id FROM countries WHERE iso_code = $1", [countryCode]);
      if (!c.rows.length) {
        await client.query("ROLLBACK");
        return fail(res, 400, "Pays inconnu dans le référentiel.", "UNKNOWN_COUNTRY");
      }

      const company = await client.query(
        `INSERT INTO companies (legal_name, country_id, tax_id, vat_number, main_email, main_phone, status)
         VALUES ($1,$2,$3,$4,$5,$6,'PENDING')
         RETURNING company_id`,
        [legalName, c.rows[0].country_id, taxId, vatNumber, email, phone]
      );
      const companyId = company.rows[0].company_id;

      await client.query(
        `INSERT INTO company_roles (company_id, role_type, active, start_date)
         VALUES ($1,'CARRIER',true,current_date)`,
        [companyId]
      );

      /* Le transporteur n'est PAS actif tant que le back-office
         n'a pas validé ses justificatifs. */
      await client.query(
        `INSERT INTO carrier_profiles (company_id, validation_status, insurance_status, license_status, active)
         VALUES ($1,'PENDING','UNKNOWN','UNKNOWN',true)`,
        [companyId]
      );

      for (const code of cleanModes) {
        await client.query(
          `INSERT INTO carrier_transport_modes (company_id, transport_mode_id)
           SELECT $1, transport_mode_id FROM transport_modes WHERE code = $2
           ON CONFLICT DO NOTHING`,
          [companyId, code]
        );
      }

      const user = await client.query(
        `INSERT INTO users (company_id, first_name, last_name, email, phone, password_hash, role, status)
         VALUES ($1,$2,$3,$4,$5,$6,'CARRIER_USER','ACTIVE')
         RETURNING user_id, email, first_name, last_name, role, company_id`,
        [companyId, firstName, lastName, email, phone, passwordHash]
      );

      await client.query(
        `INSERT INTO audit_log (user_id, action_type, entity_type, entity_id, new_value)
         VALUES ($1,'CARRIER_REGISTERED','companies',$2,$3)`,
        [user.rows[0].user_id, companyId, JSON.stringify({ legalName, modes: cleanModes })]
      );

      await client.query("COMMIT");
      await recordAttempt("carrier-register", clientIp(req), true);

      const { token, expires } = await createSession(user.rows[0], req);
      res.setHeader("Set-Cookie", sessionCookie(token, expires));

      return json(res, 201, {
        user: user.rows[0],
        company: { company_id: companyId, legal_name: legalName, status: "PENDING" },
        verification: { status: "PENDING" },
        message: "Compte créé. L'activation suit la vérification des justificatifs par la plateforme."
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
