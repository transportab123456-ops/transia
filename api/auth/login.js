/* ============================================================
   Transia — POST /api/auth/login
   Vérifie e-mail + mot de passe, ouvre une session (cookie httpOnly).
   Réponse volontairement identique que l'e-mail existe ou non.
   ============================================================ */
"use strict";

const { handler, json, readBody, fail } = require("../_lib/respond");
const { query } = require("../_lib/db");
const { verifyPassword, createSession, sessionCookie } = require("../_lib/auth");
const { rateLimit, recordAttempt, pruneAttempts, clientIp } = require("../_lib/security");

const GENERIC = "E-mail ou mot de passe incorrect.";

module.exports = handler(async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Méthode non autorisée." });
  }

  const body = await readBody(req);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!email || !password) return fail(res, 400, "E-mail et mot de passe obligatoires.", "MISSING_CREDENTIALS");

  /* Anti brute-force : fenêtre par e-mail + par IP */
  const ip = clientIp(req);
  for (const [subject, limit] of [[email, 5], [ip, 20]]) {
    const rl = await rateLimit(req, "login", subject, limit, 15);
    if (!rl.allowed) {
      res.setHeader("Retry-After", String(rl.retryAfterSec));
      return fail(res, 429, "Trop de tentatives. Réessayez dans quelques minutes.", "RATE_LIMITED");
    }
  }
  pruneAttempts();

  const r = await query(
    `SELECT user_id, email, first_name, last_name, role, company_id, status, password_hash
       FROM users WHERE email = $1`,
    [email]
  );
  const user = r.rows[0];
  if (!user) {
    /* vérification factice : même temps de réponse que le bon mot de passe */
    await verifyPassword(password, "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA");
    await recordAttempt("login", email, false);
    await recordAttempt("login", ip, false);
    return fail(res, 401, GENERIC, "INVALID_CREDENTIALS");
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    await recordAttempt("login", email, false);
    await recordAttempt("login", ip, false);
    return fail(res, 401, GENERIC, "INVALID_CREDENTIALS");
  }
  /* Mot de passe correct : on peut différencier les blocages sans
     risque d'énumération (l'attaquant possède déjà le mot de passe). */
  if (user.status === "PENDING_EMAIL") {
    return fail(res, 403, "E-mail non vérifié : cliquez sur le lien reçu à l'inscription (un renvoi est possible depuis la page de connexion).", "EMAIL_NOT_VERIFIED");
  }
  if (user.status !== "ACTIVE") return fail(res, 403, "Compte inactif ou suspendu.", "ACCOUNT_DISABLED");

  await recordAttempt("login", email, true);
  await recordAttempt("login", ip, true);

  await query("UPDATE users SET last_login_at = now() WHERE user_id = $1", [user.user_id]);
  const { token, expires } = await createSession(user, req);
  res.setHeader("Set-Cookie", sessionCookie(token, expires));

  return json(res, 200, {
    user: {
      user_id: user.user_id, email: user.email, first_name: user.first_name,
      last_name: user.last_name, role: user.role, company_id: user.company_id
    }
  });
});
