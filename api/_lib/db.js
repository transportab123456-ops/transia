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

/* Reprise après mise en veille de la base. Neon suspend le calcul
   après quelques minutes sans activité ; la première connexion qui
   suit échoue souvent avant que le calcul ne soit réveillé (refus,
   réinitialisation, « the database system is starting up »). Le
   réessai ne porte QUE sur l'obtention d'une connexion : aucun ordre
   SQL n'a encore été envoyé, donc rejouer ne peut ni dupliquer un
   INSERT ni rejouer une transaction à moitié faite. */
const DEFAULT_RETRY_ATTEMPTS = 3;
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [250, 750, 1500, 3000];

/* Budget total de reprise, égal au délai de connexion : un vrai
   timeout de connexion (connectionTimeoutMillis = 8 s) ne doit pas
   être payé deux fois, la fonction Vercel étant coupée bien avant.
   Les échecs francs (refus, réinitialisation) restent dans le budget
   et consomment bien les trois essais. */
const RETRY_BUDGET_MS = 8000;

/* Borne d'exécution d'un ordre SQL. Sans elle, une requête bloquée
   immobilise la connexion jusqu'à la coupure de la fonction Vercel :
   le client reçoit alors une erreur de plateforme au lieu d'un 500
   explicite, et la connexion reste occupée pour les requêtes
   suivantes. */
const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;
const MIN_STATEMENT_TIMEOUT_MS = 500;
const MAX_STATEMENT_TIMEOUT_MS = 30000;

/* Erreurs qui signalent une connexion non établie : classes 08
   (connexion), 57P01/57P02/57P03 (arrêt, plantage, démarrage),
   53300 (trop de connexions) et codes réseau de Node. Les messages
   couvrent les erreurs que pg laisse sans code, notamment
   « Connection terminated unexpectedly » au réveil de la base. */
const TRANSIENT_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT",
  "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN",
  "57P01", "57P02", "57P03", "53300",
  "08000", "08001", "08003", "08004", "08006"
]);
const TRANSIENT_MESSAGES = [
  /connection terminated/i,
  /server closed the connection unexpectedly/i,
  /the database system is (starting up|shutting down)/i,
  /connection timeout/i,
  /socket hang up/i
];

/* Entier d'environnement borné : une valeur fautive retombe sur le
   défaut au lieu de désarmer la protection. */
function envInt(name, fallback, min, max) {
  const raw = Number(process.env[name]);
  if (!Number.isInteger(raw) || raw < min) return fallback;
  return Math.min(raw, max);
}

/* Plafond du pool : 3 par défaut (budget serverless), surchargeable
   par PG_POOL_MAX et borné à 20 pour qu'une valeur fautive n'épuise
   pas le quota de la base (Neon : 105 connexions directes utilisables
   sur un calcul 0,25 CU). Lu à la création du pool, une seule fois
   par processus. */
function poolMax() {
  return envInt("PG_POOL_MAX", DEFAULT_POOL_MAX, 1, MAX_POOL_MAX);
}

function retryAttempts() {
  return envInt("PG_RETRY_ATTEMPTS", DEFAULT_RETRY_ATTEMPTS, 1, MAX_RETRY_ATTEMPTS);
}

function statementTimeoutMs() {
  return envInt(
    "PG_STATEMENT_TIMEOUT_MS",
    DEFAULT_STATEMENT_TIMEOUT_MS,
    MIN_STATEMENT_TIMEOUT_MS,
    MAX_STATEMENT_TIMEOUT_MS
  );
}

function isTransient(err) {
  if (!err) return false;
  if (typeof err.code === "string" && TRANSIENT_CODES.has(err.code)) return true;
  const message = String(err.message || "");
  return TRANSIENT_MESSAGES.some((re) => re.test(message));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* Rejoue fn tant que l'échec est transitoire, dans la limite du
   nombre d'essais. Une erreur permanente (mot de passe refusé, base
   inexistante) remonte immédiatement : inutile de la payer trois fois. */
async function withRetry(fn, what) {
  const attempts = retryAttempts();
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isTransient(err) || Date.now() - started >= RETRY_BUDGET_MS) {
        throw err;
      }
      const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
      console.warn(
        "[db] " + what + " : échec transitoire (" + (err.code || err.message) + "), " +
          "essai " + (attempt + 1) + "/" + attempts + " dans " + delay + " ms"
      );
      await sleep(delay);
    }
  }
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

    /* Une connexion inactive coupée par la base (suspension, arrêt)
       émet « error » sur le client : sans écouteur sur le pool, Node
       arrête le processus serverless. pg retire le client fautif ;
       il suffit de ne pas mourir et de le dire. */
    pool.on("error", (err) => {
      console.warn("[db] connexion inactive perdue :", err.message);
    });

    /* statement_timeout posé par SET et non par un paramètre de
       démarrage : un pooler en mode transaction (PgBouncer, pooler
       Neon) refuse les paramètres de démarrage inconnus et ferait
       échouer toute connexion. Lu à la création du pool. */
    const timeout = statementTimeoutMs();
    pool.on("connect", (client) => {
      client.query("SET statement_timeout = " + timeout).catch((err) => {
        console.warn("[db] statement_timeout non appliqué :", err.message);
      });
    });

    /* Les handlers font `await getPool().connect()` : la reprise se
       place ici pour couvrir aussi les transactions, sans modifier
       les douze appelants. La forme callback de pg reste intacte. */
    const connect = pool.connect.bind(pool);
    pool.connect = function (cb) {
      if (typeof cb === "function") return connect(cb);
      return withRetry(() => connect(), "connexion à la base");
    };
  }
  return pool;
}

/* Exécute une requête paramétrée (jamais de SQL concaténé).
   La requête elle-même n'est pas rejouée : seule l'obtention de la
   connexion l'est, ce qui rend le réessai sûr pour les écritures. */
async function query(text, params) {
  const client = await getPool().connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

module.exports = { getPool, query };
