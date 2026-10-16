/* ============================================================
   Transia — GET /api/health
   Santé de l'API + connectivité base de données.
   ============================================================ */
"use strict";

const { handler, json } = require("./_lib/respond");
const { query } = require("./_lib/db");

module.exports = handler(async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: "Méthode non autorisée." });
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
