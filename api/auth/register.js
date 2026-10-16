/* ============================================================
   Transia — POST /api/auth/register
   Crée une entreprise (donneur d'ordre) + son utilisateur en
   transaction, puis ouvre une session.
   Validation e-mail simulée (statut ACTIVE) : le schéma prévoit
   déjà PENDING_EMAIL dès que l'envoi d'e-mail sera branché.
   ============================================================ */
"use strict";

const { handler, json, readBody, fail } = require("../_lib/respond");
const { getPool, query } = require("../_lib/db");
const { hashPassword, sessionCookie, createSession } = require("../_lib/auth");
const { rateLimit, recordAttempt, clientIp } = require("../_lib/security");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

module.exports = handler(async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Méthode non autorisée." });
  }

  const body = await readBody(req);
  /* Limite aussi la création de comptes depuis une même IP */
  const rl = await rateLimit(req, "register", clientIp(req), 10, 60);
  if (!rl.allowed) {
    res.setHeader("Retry-After", String(rl.retryAfterSec));
    return fail(res, 429, "Trop de créations de compte. Réessayez plus tard.", "RATE_LIMITED");
  }

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const firstName = String(body.firstName || "").trim();
  const lastName = String(body.lastName || "").trim();
  const companyName = String(body.companyName || "").trim();
  const countryCode = String(body.countryCode || "").trim().toUpperCase();

  /* Validation des entrées (côté serveur, jamais uniquement au client) */
  if (!EMAIL_RE.test(email)) return fail(res, 400, "E-mail professionnel invalide.", "INVALID_EMAIL");
  if (password.length < 10) return fail(res, 400, "Mot de passe : 10 caractères minimum.", "WEAK_PASSWORD");
  if (!firstName || !lastName) return fail(res, 400, "Nom et prénom obligatoires.", "MISSING_NAME");
  if (!companyName) return fail(res, 400, "Raison sociale obligatoire.", "MISSING_COMPANY");
  if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) return fail(res, 400, "Code pays ISO à 2 lettres attendu (ex. FR).", "INVALID_COUNTRY");

  /* Unicité de l'e-mail */
  const existing = await query("SELECT 1 FROM users WHERE email = $1", [email]);
  if (existing.rows.length) return fail(res, 409, "Un compte existe déjà avec cet e-mail.", "EMAIL_TAKEN");

  const passwordHash = await hashPassword(password);
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let countryId = null;
    if (countryCode) {
      const c = await client.query("SELECT country_id FROM countries WHERE iso_code = $1", [countryCode]);
      if (!c.rows.length) {
        await client.query("ROLLBACK");
        return fail(res, 400, "Pays inconnu dans le référentiel.", "UNKNOWN_COUNTRY");
      }
      countryId = c.rows[0].country_id;
    }

    const company = await client.query(
      `INSERT INTO companies (legal_name, country_id, main_email, status)
       VALUES ($1, $2, $3, 'ACTIVE') RETURNING company_id`,
      [companyName, countryId, email]
    );
    const companyId = company.rows[0].company_id;

    await client.query(
      `INSERT INTO company_roles (company_id, role_type, active, start_date)
       VALUES ($1, 'SHIPPER', true, current_date)`,
      [companyId]
    );

    const user = await client.query(
      `INSERT INTO users (company_id, first_name, last_name, email, password_hash, role, status)
       VALUES ($1, $2, $3, $4, $5, 'SHIPPER_USER', 'ACTIVE')
       RETURNING user_id, email, first_name, last_name, role, company_id`,
      [companyId, firstName, lastName, email, passwordHash]
    );

    await client.query(
      `INSERT INTO audit_log (user_id, action_type, entity_type, entity_id, new_value)
       VALUES ($1, 'ACCOUNT_REGISTERED', 'users', $1, $2)`,
      [user.rows[0].user_id, JSON.stringify({ email, companyName })]
    );

    await client.query("COMMIT");
    await recordAttempt("register", clientIp(req), true);

    /* Session */
    const { token, expires } = await createSession(user.rows[0], req);
    res.setHeader("Set-Cookie", sessionCookie(token, expires));

    return json(res, 201, {
      user: user.rows[0],
      company: { company_id: companyId, legal_name: companyName }
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});
