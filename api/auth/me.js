/* ============================================================
   Transia — GET /api/auth/me   ·   POST /api/auth/logout
   Session courante, ou révocation (fermeture de session).
   ============================================================ */
"use strict";

const { handler, json } = require("../_lib/respond");
const { getSessionUser, revokeSession, clearCookie } = require("../_lib/auth");

module.exports = handler(async (req, res) => {
  if (req.method === "GET") {
    const user = await getSessionUser(req);
    if (!user) return json(res, 200, { user: null });
    return json(res, 200, {
      user: {
        user_id: user.user_id, email: user.email, first_name: user.first_name,
        last_name: user.last_name, role: user.role, company_id: user.company_id
      }
    });
  }

  if (req.method === "POST") {
    await revokeSession(req);
    res.setHeader("Set-Cookie", clearCookie());
    return json(res, 200, { ok: true });
  }

  res.setHeader("Allow", "GET, POST");
  return json(res, 405, { error: "Méthode non autorisée." });
});
