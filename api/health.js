/* ============================================================
   Transia — GET /api/health
   Santé de l'API + connectivité base de données.
   GET ?flush=emails (Bearer CRON_SECRET) : drain de la file
   outbox_emails — le cron Vercel appelle cette route (plan
   Hobby : limite de fonctions serverless, le drain vit ici).
   ============================================================ */
"use strict";

const { handler, json } = require("./_lib/respond");
const { query } = require("./_lib/db");
const { drainOutbox } = require("./_lib/mailer");

module.exports = handler(async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: "Méthode non autorisée." });
  }

  /* Drain de la file d'e-mail (appelé par le cron quotidien) */
  if (String((req.query || {}).flush || "") === "emails") {
    const secret = process.env.CRON_SECRET;
    const auth = String(req.headers.authorization || "");
    if (!secret || auth !== "Bearer " + secret) {
      return json(res, 401, { error: "Accès réservé au cron." });
    }
    const drained = await drainOutbox(50);
    return json(res, 200, { ok: true, drained, at: new Date().toISOString() });
  }

  const started = Date.now();
  let db = { ok: false };
  try {
    const r = await query("SELECT now() AS now, current_database() AS db");
    db = { ok: true, now: r.rows[0].now, database: r.rows[0].db };
  } catch (err) {
    db = { ok: false, error: err.code || "CONNECTION_FAILED" };
  }

  return json(res, db.ok ? 200 : 503, {
    status: db.ok ? "ok" : "degraded",
    version: "0.2.0",
    db,
    latencyMs: Date.now() - started,
    time: new Date().toISOString()
  });
});
