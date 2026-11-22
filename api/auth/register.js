/* ============================================================
   Transia — POST /api/auth/register
   Crée une entreprise (donneur d'ordre) + son utilisateur en
   transaction.
   Vérification d'e-mail : quand le transport e-mail est actif
   (RESEND_API_KEY présent et REQUIRE_EMAIL_VERIFY != "false"),
   l'utilisateur est créé en PENDING_EMAIL et reçoit un lien de
   vérification ; la session n'est ouverte qu'après vérification.
   Sans transport e-mail (mode log/démo) : compte actif
   immédiatement, comme avant — rien ne casse.
   ============================================================ */
"use strict";

const crypto = require("crypto");
const { handler, json, readBody, fail } = require("../_lib/respond");
const { getPool, query } = require("../_lib/db");
const { hashPassword, sessionCookie, createSession } = require("../_lib/auth");
const { rateLimit, recordAttempt, clientIp } = require("../_lib/security");
const { mailEnabled } = require("../_lib/mailer");
const { enqueueEmail, flushOutbox } = require("../_lib/notify");
const { checkAcceptance, recordAcceptance } = require("../_lib/terms");

/* Activation de la vérification :
   - REQUIRE_EMAIL_VERIFY=true  → exigée même sans transport
     (l'e-mail part alors en mode log, corps visible en base :
     utile pour les tests et la démonstration) ;
   - REQUIRE_EMAIL_VERIFY=false → désactivée même avec une clé
     (staging) ;
   - non défini → exigée dès qu'un transport est configuré. */
function verificationRequired() {
  const flag = process.env.REQUIRE_EMAIL_VERIFY;
  if (flag === "true") return true;
  if (flag === "false") return false;
  return mailEnabled();
}

function sha256(v) {
  return crypto.createHash("sha256").update(String(v)).digest("hex");
}

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

  /* Acceptation des CGU : vérifiée avant toute écriture. */
  const acceptance = checkAcceptance(body, "SHIPPER");
  if (!acceptance.ok) return fail(res, acceptance.status, acceptance.message, acceptance.code);

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

    const needVerify = verificationRequired();
    const user = await client.query(
      `INSERT INTO users (company_id, first_name, last_name, email, password_hash, role, status)
       VALUES ($1, $2, $3, $4, $5, 'SHIPPER_USER', $6)
       RETURNING user_id, email, first_name, last_name, role, company_id`,
      [companyId, firstName, lastName, email, passwordHash, needVerify ? "PENDING_EMAIL" : "ACTIVE"]
    );
    const userId = user.rows[0].user_id;

    /* Preuve d'acceptation, dans la même transaction que le compte. */
    await recordAcceptance(client, {
      userId, companyId, terms: acceptance.terms, req, context: "REGISTRATION"
    });

    await client.query(
      `INSERT INTO audit_log (user_id, action_type, entity_type, entity_id, new_value)
       VALUES ($1, 'ACCOUNT_REGISTERED', 'users', $1, $2)`,
      [userId, JSON.stringify({ email, companyName, termsVersion: acceptance.terms.version })]
    );

    /* Événement d'e-mail écrit DANS LA TRANSACTION : soit le lien
       de vérification, soit la bienvenue (mode log = journalisé). */
    if (needVerify) {
      const verifyToken = crypto.randomBytes(32).toString("hex");
      await client.query(
        `INSERT INTO email_verifications (token_hash, user_id, email, expires_at)
         VALUES ($1,$2,$3, now() + make_interval(hours => 24))`,
        [sha256(verifyToken), userId, email]
      );
      await enqueueEmail(client, {
        dedupeKey: "verify:" + userId,
        eventType: "email_verification",
        entityType: "users",
        entityId: userId,
        to: email,
        userId,
        vars: { firstName, companyName, token: verifyToken }
      });
    } else {
      await enqueueEmail(client, {
        dedupeKey: "welcome:" + userId,
        eventType: "welcome",
        entityType: "users",
        entityId: userId,
        to: email,
        userId,
        vars: { firstName, companyName }
      });
    }

    await client.query("COMMIT");
    await recordAttempt("register", clientIp(req), true);
    await flushOutbox();

    /* Session : ouverte seulement si la vérification n'est pas exigée */
    if (needVerify) {
      return json(res, 201, {
        user: {
          user_id: userId, email, first_name: firstName,
          last_name: lastName, role: "SHIPPER_USER", company_id: companyId
        },
        company: { company_id: companyId, legal_name: companyName },
        requiresEmailVerification: true,
        message: "Votre compte est créé. Un e-mail de vérification vient de vous être envoyé : cliquez sur le lien pour activer votre compte."
      });
    }

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
