/* ============================================================
   Transia — GET /api/auth/me   ·   POST /api/auth/me
   GET  : session courante + état d'acceptation des CGU.
   POST : acceptation des CGU depuis une session déjà ouverte
          (compte hérité, ou version mise à jour) ;
          sans corps d'acceptation, ferme la session (logout).
   ============================================================ */
"use strict";

const { handler, json, readBody } = require("../_lib/respond");
const { getSessionUser, revokeSession, clearCookie } = require("../_lib/auth");
const { query } = require("../_lib/db");
const { termsForRole, parseAcceptance, acceptanceError, recordAcceptance } = require("../_lib/terms");

module.exports = handler(async (req, res) => {
  if (req.method === "GET") {
    const user = await getSessionUser(req);
    if (!user) return json(res, 200, { user: null, terms: null });

    const pending = user.termsPending;
    return json(res, 200, {
      user: {
        user_id: user.user_id, email: user.email, first_name: user.first_name,
        last_name: user.last_name, role: user.role, company_id: user.company_id
      },
      terms: pending
        ? {
            required: true, documentType: pending.documentType,
            version: pending.version, label: pending.label, url: pending.url
          }
        : null
    });
  }

  if (req.method === "POST") {
    const body = await readBody(req);

    /* Corps d'acceptation : enregistre la preuve pour la session
       courante. La version reste celle du serveur. */
    if (body && (body.termsAccepted !== undefined || body.termsVersion !== undefined)) {
      const user = await getSessionUser(req);
      if (!user) return json(res, 401, { error: "Authentification requise.", code: "UNAUTHENTICATED" });

      const terms = termsForRole(user.role);
      if (!terms) {
        return json(res, 400, { error: "Aucune condition à accepter pour ce compte.", code: "NO_TERMS" });
      }

      const state = parseAcceptance(body, terms);
      if (!state.accepted) {
        const err = acceptanceError(state.reason);
        return json(res, err.status, {
          error: err.message,
          code: err.code,
          terms: { documentType: terms.documentType, version: terms.version, label: terms.label, url: terms.url }
        });
      }

      const written = await recordAcceptance({ query }, {
        userId: user.user_id, companyId: user.company_id,
        terms, req, context: "REACCEPTANCE"
      });

      return json(res, 200, {
        ok: true,
        alreadyAccepted: !written.inserted,
        terms: { documentType: terms.documentType, version: terms.version }
      });
    }

    await revokeSession(req);
    res.setHeader("Set-Cookie", clearCookie());
    return json(res, 200, { ok: true });
  }

  res.setHeader("Allow", "GET, POST");
  return json(res, 405, { error: "Méthode non autorisée." });
});
