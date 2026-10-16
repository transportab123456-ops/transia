/* ============================================================
   Transia — api/_lib/security.js
   Durcissement commun aux fonctions serverless :
   - rate limiting stocké en base (partagé entre instances)
   - en-têtes de sécurité sur chaque réponse JSON
   - contrôle d'origine pour les mutations (anti-CSRF
     complémentaire au cookie SameSite=Lax)
   ============================================================ */
"use strict";

const crypto = require("crypto");
const { query } = require("./db");

function hashKey(v) {
  return crypto.createHash("sha256").update(String(v || "")).digest("hex").slice(0, 40);
}

/* Adresse client réelle derrière Vercel. */
function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.headers["x-real-ip"] || "unknown";
}

/* Vérifie une fenêtre glissante. key : identifiant du sujet (e-mail,
   IP…). Renvoie { allowed, remaining } et écrit l'événement. */
async function rateLimit(req, action, key, limit, windowMinutes) {
  const attemptKey = action + ":" + hashKey(key);
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);

  const r = await query(
    `SELECT count(*)::int AS n FROM login_attempts
      WHERE attempt_key = $1 AND succeeded = false AND created_at > $2`,
    [attemptKey, since]
  );
  const used = r.rows[0].n;
  if (used >= limit) {
    return { allowed: false, remaining: 0, retryAfterSec: windowMinutes * 60 };
  }
  return { allowed: true, remaining: limit - used };
}

/* Enregistre l'issue d'une tentative protégée. */
async function recordAttempt(action, key, succeeded) {
  await query(
    `INSERT INTO login_attempts (attempt_key, succeeded) VALUES ($1, $2)`,
    [action + ":" + hashKey(key), !!succeeded]
  );
  if (succeeded) {
    /* Une réussite remet le compteur du sujet à zéro. */
    await query(
      `DELETE FROM login_attempts WHERE attempt_key = $1 AND succeeded = false`,
      [action + ":" + hashKey(key)]
    );
  }
}

/* Nettoie les tentatives trop anciennes (appel opportunune). */
async function pruneAttempts() {
  await query(
    `DELETE FROM login_attempts WHERE created_at < now() - interval '2 days'`
  ).catch(() => {});
}

/* En-têtes de sécurité appliqués à chaque réponse d'API. */
function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
}

/* Contrôle d'origine sur les mutations (POST/PUT/PATCH/DELETE).
   Accepte les requêtes sans Origine (curl, server-to-server) mais
   refuse une origine étrangère : bloque le CSRF par formulaire. */
function sameOriginOk(req) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  try {
    return new URL(origin).host === host;
  } catch (e) {
    return false;
  }
}

module.exports = { rateLimit, recordAttempt, pruneAttempts, securityHeaders, sameOriginOk, clientIp, hashKey };
