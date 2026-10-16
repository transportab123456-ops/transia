/* ============================================================
   Transia — POST /api/auth/login
   Vérifie e-mail + mot de passe, ouvre une session (cookie httpOnly).
   Réponse volontairement identique que l'e-mail existe ou non.
   ============================================================ */
"use strict";

const { handler, json, readBody, fail } = require("../_lib/respond");
const { query } = require("../_lib/db");
const { verifyPassword, createSession, sessionCookie } = require("../_lib/auth");

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

  const r = await query(
    `SELECT user_id, email, first_name, last_name, role, company_id, status, password_hash
       FROM users WHERE email = $1`,
    [email]
  );
  const user = r.rows[0];
  if (!user) {
    /* vérification factice : même temps de réponse que le bon mot de passe */
    await verifyPassword(password, "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA");
    return fail(res, 401, GENERIC, "INVALID_CREDENTIALS");
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return fail(res, 401, GENERIC, "INVALID_CREDENTIALS");
  if (user.status !== "ACTIVE") return fail(res, 403, "Compte inactif ou suspendu.", "ACCOUNT_DISABLED");

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
