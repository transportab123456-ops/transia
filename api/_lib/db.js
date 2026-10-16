/* ============================================================
   Transia — api/_lib/db.js
   Pool PostgreSQL partagé pour les fonctions serverless Vercel.
   DATABASE_URL doit être défini (Neon en production, Docker en local).
   ============================================================ */
"use strict";

const { Pool } = require("pg");

let pool = null;

function getPool() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    const err = new Error("DATABASE_URL manquant : définissez la variable d'environnement (Neon en prod, Docker en local).");
    err.code = "NO_DATABASE_URL";
    throw err;
  }
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: 3,                 // budget serverless
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 8000,
      // Neon (et Supabase) exigent SSL en production
      ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false }
    });
  }
  return pool;
}

/* Exécute une requête paramétrée (jamais de SQL concaténé). */
async function query(text, params) {
  const p = getPool();
  return p.query(text, params);
}

module.exports = { getPool, query };
