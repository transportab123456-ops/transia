/* ============================================================
   Transia — /api/auth/verify-email
   POST { token }                  : valide le jeton d'inscription,
                                     active le compte (PENDING_EMAIL
                                     → ACTIVE) et ouvre une session.
   POST { action:"resend", email } : renvoie un jeton de
                                     vérification (rate-limité).
   Jetons hachés (sha256) + expiration 24 h + usage unique.
   ============================================================ */
"use strict";

const crypto = require("crypto");
const { handler, json, readBody, fail } = require("../_lib/respond");
const { getPool, query } = require("../_lib/db");
const { createSession, sessionCookie } = require("../_lib/auth");
const { rateLimit, recordAttempt, clientIp } = require("../_lib/security");
const { enqueueEmail, flushOutbox, APP_URL } = require("../_lib/notify");

const TOKEN_TTL_HOURS = 24;

function sha256(v) {
  return crypto.createHash("sha256").update(String(v)).digest("hex");
}

module.exports = handler(async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Méthode non autorisée." });
  }

  const body = await readBody(req);

  /* ---------- Renvoi d'un jeton ---------- */
  if (String(body.action || "") === "resend") {
    const email = String(body.email || "").trim().toLowerCase();
    if (!email) return fail(res, 400, "E-mail obligatoire.", "MISSING_EMAIL");

    const rl = await rateLimit(req, "verify_resend", email, 5, 60);
    if (!rl.allowed) {
      res.setHeader("Retry-After", String(rl.retryAfterSec));
      return fail(res, 429, "Trop de demandes de renvoi. Réessayez plus tard.", "RATE_LIMITED");
    }

    const r = await query(
      `SELECT u.user_id, u.email, u.first_name, u.last_name, u.status, c.legal_name
         FROM users u JOIN companies c ON c.company_id = u.company_id
        WHERE u.email = $1`,
      [email]
    );
    const user = r.rows[0];

    /* Réponse identique que le compte existe ou non (pas d'énumération). */
    const generic = { message: "Si un compte en attente de vérification existe pour cet e-mail, un nouveau lien vient d'être envoyé." };
    if (!user || user.status !== "PENDING_EMAIL") return json(res, 200, generic);

    const token = crypto.randomBytes(32).toString("hex");
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      /* Un seul jeton actif par compte : le précédent est révoqué. */
      await client.query(
        `UPDATE email_verifications SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
        [user.user_id]
      );
      await client.query(
        `INSERT INTO email_verifications (token_hash, user_id, email, expires_at)
         VALUES ($1,$2,$3, now() + make_interval(hours => $4))`,
        [sha256(token), user.user_id, user.email, TOKEN_TTL_HOURS]
      );
      await enqueueEmail(client, {
        dedupeKey: "verify:" + user.user_id + ":" + Date.now(),
        eventType: "email_verification",
        entityType: "users",
        entityId: user.user_id,
        to: user.email,
        userId: user.user_id,
        vars: { firstName: user.first_name, companyName: user.legal_name, token }
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    await flushOutbox();
    return json(res, 200, generic);
  }

  /* ---------- Validation d'un jeton ---------- */
  const token = String(body.token || "").trim();
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return fail(res, 400, "Jeton de vérification invalide.", "INVALID_TOKEN");
  }

  const rl = await rateLimit(req, "verify", clientIp(req), 20, 15);
  if (!rl.allowed) {
    res.setHeader("Retry-After", String(rl.retryAfterSec));
    return fail(res, 429, "Trop de tentatives. Réessayez plus tard.", "RATE_LIMITED");
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const v = await client.query(
      `SELECT v.token_hash, v.user_id, v.email, v.expires_at, v.used_at,
              u.status, u.first_name, u.last_name, u.role, u.company_id
         FROM email_verifications v
         JOIN users u ON u.user_id = v.user_id
        WHERE v.token_hash = $1
        FOR UPDATE OF v`,
      [sha256(token)]
    );
    const verif = v.rows[0];

    if (!verif || verif.used_at || new Date(verif.expires_at) < new Date()) {
      await client.query("ROLLBACK");
      await recordAttempt("verify", clientIp(req), false);
      return fail(res, 400, "Lien de vérification invalide ou expiré. Demandez un nouveau lien.", "TOKEN_INVALID");
    }

    await client.query(
      `UPDATE email_verifications SET used_at = now() WHERE token_hash = $1`,
      [verif.token_hash]
    );

    /* PENDING_EMAIL → ACTIVE (le statut reste géré par CHECK) */
    await client.query(
      `UPDATE users SET status = 'ACTIVE', email_verified_at = now(), updated_at = now()
        WHERE user_id = $1`,
      [verif.user_id]
    );
    await client.query(
      `INSERT INTO audit_log (user_id, action_type, entity_type, entity_id, new_value)
       VALUES ($1,'EMAIL_VERIFIED','users',$1,$2)`,
      [verif.user_id, JSON.stringify({ email: verif.email })]
    );

    const u = await client.query(
      `SELECT user_id, email, first_name, last_name, role, company_id, status
         FROM users WHERE user_id = $1`,
      [verif.user_id]
    );
    await client.query("COMMIT");

    await recordAttempt("verify", clientIp(req), true);

    const { token: sessionToken, expires } = await createSession(u.rows[0], req);
    res.setHeader("Set-Cookie", sessionCookie(sessionToken, expires));

    return json(res, 200, {
      verified: true,
      user: u.rows[0],
      next: u.rows[0].role === "CARRIER_USER" || u.rows[0].role === "CARRIER_ADMIN"
        ? "Compte actif. Votre dossier transporteur reste à vérifier par la plateforme."
        : "Compte actif. Vous pouvez publier vos demandes.",
      appUrl: APP_URL
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});
