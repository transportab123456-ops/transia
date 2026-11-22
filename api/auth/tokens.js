/* ============================================================
   Transia — /api/auth/tokens
   Point d'entrée unique des jetons envoyés par e-mail.

   POST { token }                            : valide le jeton d'inscription,
                                               active le compte (PENDING_EMAIL
                                               → ACTIVE) et ouvre une session.
   POST { action:"resend", email }           : renvoie un jeton de vérification.
   POST { action:"reset-request", email }    : envoie un lien de réinitialisation
                                               de mot de passe (1 h, usage unique).
   POST { action:"reset-confirm", token, password }
                                             : remplace le mot de passe et révoque
                                               toutes les sessions du compte.

   Jetons de vérification : hachés (sha256) en base, 24 h, usage unique.
   Jetons de réinitialisation : signés (HMAC) et sans état — ils
   s'invalident d'eux-mêmes dès que le mot de passe change, donc
   aucune table ni migration n'est nécessaire.
   ============================================================ */
"use strict";

const crypto = require("crypto");
const { handler, json, readBody, fail } = require("../_lib/respond");
const { getPool, query } = require("../_lib/db");
const { createSession, sessionCookie, hashPassword } = require("../_lib/auth");
const { rateLimit, recordAttempt, pruneAttempts, clientIp } = require("../_lib/security");
const { enqueueEmail, flushOutbox, APP_URL } = require("../_lib/notify");
const resetToken = require("../_lib/reset-token");

const TOKEN_TTL_HOURS = 24;
const PASSWORD_MIN = 10;

const GENERIC_RESET = {
  message: "Si un compte correspond à cette adresse, un lien de réinitialisation vient d'être envoyé (valable 1 heure)."
};

function sha256(v) {
  return crypto.createHash("sha256").update(String(v)).digest("hex");
}

module.exports = handler(async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Méthode non autorisée." });
  }

  const body = await readBody(req);
  const action = String(body.action || "");

  /* ---------- Renvoi d'un jeton de vérification ---------- */
  if (action === "resend") {
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

  /* ---------- Réinitialisation : demande de lien ---------- */
  if (action === "reset-request") {
    const email = String(body.email || "").trim().toLowerCase();
    if (!email) return fail(res, 400, "E-mail obligatoire.", "MISSING_EMAIL");

    /* Un jeton ne peut pas être émis sans secret de signature. */
    if (!resetToken.configured()) {
      return fail(res, 503, "Réinitialisation non configurée sur ce serveur (RESET_SECRET absent).", "RESET_NOT_CONFIGURED");
    }

    const rlEmail = await rateLimit(req, "reset_request", email, 3, 60);
    const rlIp = await rateLimit(req, "reset_request_ip", clientIp(req), 10, 60);
    if (!rlEmail.allowed || !rlIp.allowed) {
      res.setHeader("Retry-After", String(rlEmail.retryAfterSec || rlIp.retryAfterSec));
      return fail(res, 429, "Trop de demandes. Réessayez dans une heure.", "RATE_LIMITED");
    }

    /* Chaque demande est journalisée, qu'un compte corresponde ou non :
       rateLimit() ne compte que les lignes écrites ici. Sans elles, le
       quota resterait à zéro indéfiniment. */
    await recordAttempt("reset_request", email, false);
    await recordAttempt("reset_request_ip", clientIp(req), false);
    pruneAttempts();

    const r = await query(
      `SELECT user_id, email, first_name, status, password_hash
         FROM users WHERE email = $1`,
      [email]
    );
    const user = r.rows[0];

    /* Compte inexistant, suspendu ou archivé : réponse identique. */
    if (!user || user.status === "SUSPENDED" || user.status === "ARCHIVED") {
      return json(res, 200, GENERIC_RESET);
    }

    const token = resetToken.sign(user.user_id, user.password_hash);
    if (!token) return json(res, 200, GENERIC_RESET);

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await enqueueEmail(client, {
        dedupeKey: "reset:" + user.user_id + ":" + Date.now(),
        eventType: "password_reset",
        entityType: "users",
        entityId: user.user_id,
        to: user.email,
        userId: user.user_id,
        vars: { firstName: user.first_name, token }
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    await flushOutbox();
    return json(res, 200, GENERIC_RESET);
  }

  /* ---------- Réinitialisation : application ---------- */
  if (action === "reset-confirm") {
    const token = String(body.token || "").trim();
    const password = String(body.password || "");

    const rl = await rateLimit(req, "reset_confirm", clientIp(req), 20, 15);
    if (!rl.allowed) {
      res.setHeader("Retry-After", String(rl.retryAfterSec));
      return fail(res, 429, "Trop de tentatives. Réessayez plus tard.", "RATE_LIMITED");
    }

    if (password.length < PASSWORD_MIN) {
      return fail(res, 400, "Mot de passe : " + PASSWORD_MIN + " caractères minimum.", "WEAK_PASSWORD");
    }

    if (!resetToken.configured()) {
      return fail(res, 503, "Réinitialisation non configurée sur ce serveur (RESET_SECRET absent).", "RESET_NOT_CONFIGURED");
    }

    const parsed = resetToken.parse(token);
    if (!parsed) {
      await recordAttempt("reset_confirm", clientIp(req), false);
      return fail(res, 400, "Lien de réinitialisation invalide ou expiré.", "TOKEN_INVALID");
    }

    const r = await query(
      `SELECT user_id, email, status, password_hash FROM users WHERE user_id = $1`,
      [parsed.userId]
    );
    const user = r.rows[0];

    /* Le jeton est vérifié contre l'empreinte actuelle : un mot de passe
       déjà changé rend tous les jetons antérieurs inutilisables. */
    const valid = user && user.status !== "SUSPENDED" && user.status !== "ARCHIVED"
      ? resetToken.verify(token, user.password_hash)
      : null;
    if (!valid) {
      await recordAttempt("reset_confirm", clientIp(req), false);
      return fail(res, 400, "Lien de réinitialisation invalide ou expiré. Demandez un nouveau lien.", "TOKEN_INVALID");
    }

    const hash = await hashPassword(password);
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `UPDATE users
            SET password_hash = $2,
                status = CASE WHEN status = 'PENDING_EMAIL' THEN 'ACTIVE' ELSE status END,
                email_verified_at = COALESCE(email_verified_at, now()),
                updated_at = now()
          WHERE user_id = $1`,
        [user.user_id, hash]
      );

      /* Toutes les sessions ouvertes tombent : un jeton de
         réinitialisation ne doit pas laisser survivre une session
         potentiellement volée. */
      const revoked = await client.query(
        `UPDATE sessions SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [user.user_id]
      );

      await client.query(
        `INSERT INTO audit_log (user_id, action_type, entity_type, entity_id, new_value)
         VALUES ($1,'PASSWORD_RESET','users',$1,$2)`,
        [user.user_id, JSON.stringify({ email: user.email, sessions_revoked: revoked.rowCount })]
      );

      await client.query("COMMIT");

      /* Une réussite remet le compteur de l'adresse à zéro. */
      await recordAttempt("reset_confirm", clientIp(req), true);

      return json(res, 200, {
        reset: true,
        message: "Mot de passe modifié. Vous pouvez vous connecter.",
        sessions_revoked: revoked.rowCount
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /* ---------- Validation d'un jeton de vérification ---------- */
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
