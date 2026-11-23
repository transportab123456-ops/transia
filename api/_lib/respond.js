/* ============================================================
   Transia — api/_lib/respond.js
   Réponses JSON + gestion d'erreurs commune des fonctions Vercel.
   ============================================================ */
"use strict";

const { securityHeaders, sameOriginOk } = require("./security");

function json(res, status, payload) {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function fail(res, status, message, code) {
  json(res, status, { error: message, code: code || undefined });
}

/* Identifiants uuid fournis par le client : PostgreSQL rejette une
   chaîne malformée (erreur 22P02), ce qui remonterait en 500. On les
   valide en amont pour répondre 400. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value) {
  return UUID_RE.test(String(value));
}

/* Parse un corps JSON avec limite de taille. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    const LIMIT = 64 * 1024; // 64 Ko
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > LIMIT) {
        const err = new Error("Corps de requête trop volumineux (max 64 Ko).");
        err.code = "PAYLOAD_TOO_LARGE";
        reject(err);
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        const err = new Error("JSON invalide dans le corps de la requête.");
        err.code = "INVALID_JSON";
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/* Wrapper : attrape les erreurs et renvoie une réponse JSON propre. */
function handler(fn) {
  return async (req, res) => {
    try {
      if (!sameOriginOk(req)) {
        return fail(res, 403, "Origine non autorisée.", "BAD_ORIGIN");
      }
      await fn(req, res);
    } catch (err) {
      if (err.code === "NO_DATABASE_URL") {
        return fail(res, 503, err.message, "NO_DATABASE_URL");
      }
      if (err.code === "PAYLOAD_TOO_LARGE" || err.code === "INVALID_JSON") {
        return fail(res, 400, err.message, err.code);
      }
      /* Erreurs PostgreSQL d'origine client, jamais des incidents
         serveur : classe 22 (uuid malformé, capacité dépassée, date
         inexistante…) → 400 ; unicité atteinte sous concurrence
         (e-mail d'inscription, version d'offre) → 409. Seul le code
         est journalisé, jamais la requête ni la valeur. */
      if (typeof err.code === "string" && err.code.startsWith("22")) {
        const identifiant = err.code === "22P02";
        if (!identifiant) console.warn("[api] valeur client rejetée par PostgreSQL :", err.code);
        return fail(res, 400,
          identifiant ? "Identifiant invalide." : "Donnée invalide.",
          identifiant ? "INVALID_IDENTIFIER" : "INVALID_DATA");
      }
      if (err.code === "23505") {
        console.warn("[api] conflit d'unicité :", err.constraint || "contrainte inconnue");
        return fail(res, 409, "Cette valeur existe déjà.", "CONFLICT");
      }
      console.error("[api]", err);
      return fail(res, 500, "Erreur interne du serveur.", "INTERNAL");
    }
  };
}

module.exports = { json, fail, readBody, handler, isUuid };
