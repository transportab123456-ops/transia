/* ============================================================
   Transia — api/_lib/db.js
   Pool PostgreSQL partagé pour les fonctions serverless Vercel.
   DATABASE_URL doit être défini (Neon en production, Docker en local).
   ============================================================ */
"use strict";

const { Pool } = require("pg");

let pool = null;

const DEFAULT_POOL_MAX = 3;
const MAX_POOL_MAX = 20;

/* Plafond du pool : 3 par défaut (budget serverless), surchargeable
   par PG_POOL_MAX et borné à 20 pour qu'une valeur fautive n'épuise
   pas le quota de la base (Neon : 105 connexions directes utilisables
   sur un calcul 0,25 CU). Lu à la création du pool, une seule fois
   par processus. */
function poolMax() {
  const raw = Number(process.env.PG_POOL_MAX);
  if (!Number.isInteger(raw) || raw < 1) return DEFAULT_POOL_MAX;
  return Math.min(raw, MAX_POOL_MAX);
}

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
      max: poolMax(),
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
