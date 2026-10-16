/* ============================================================
   Transia — /api/cron/flush-emails
   Cron Vercel (vercel.json) qui draine la file outbox_emails :
   - reprend les e-mails PENDING (dont les échecs avec backoff)
   - débloque les verrous orphelins (instance gelée)
   Sécurisé par CRON_SECRET (Bearer) — Vercel injecte la même
   valeur dans l'en-tête Authorization du cron.
   ============================================================ */
"use strict";

const { handler, json } = require("../_lib/respond");
const { drainOutbox } = require("../_lib/mailer");

module.exports = handler(async (req, res) => {
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: "Méthode non autorisée." });
  }

  const secret = process.env.CRON_SECRET;
  const auth = String(req.headers.authorization || "");
  if (!secret || auth !== "Bearer " + secret) {
    return json(res, 401, { error: "Accès réservé au cron." });
  }

  const drained = await drainOutbox(50);
  return json(res, 200, { ok: true, drained, at: new Date().toISOString() });
});
