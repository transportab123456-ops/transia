/* ============================================================
   Transia — api/_lib/auth.js
   Authentification pour fonctions serverless (spec architecture) :
   - mots de passe hachés (scrypt, KDF moderne du cœur Node —
     l'équivalent natif d'Argon2/bcrypt sans dépendance native)
   - sessions révocables stockées côté BDD (token haché), cookie
     httpOnly + SameSite=Lax + Secure en production
   ============================================================ */
"use strict";

const crypto = require("crypto");
const { query } = require("./db");
const { termsForRole, DOCUMENTS } = require("./terms");

const SCRYPT_N = 16384, SCRYPT_r = 8, SCRYPT_p = 1, KEYLEN = 64;
const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 h
const COOKIE_NAME = "transia_session";

/* ---------- Mots de passe ---------- */

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p }, (err, key) => {
      if (err) return reject(err);
      // format: scrypt$N$r$p$salt_b64$hash_b64
      resolve(["scrypt", SCRYPT_N, SCRYPT_r, SCRYPT_p, salt.toString("base64"), key.toString("base64")].join("$"));
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    const parts = String(stored || "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return resolve(false);
    const [, N, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    crypto.scrypt(password, salt, expected.length, { N: +N, r: +r, p: +p }, (err, key) => {
      if (err) return resolve(false);
      resolve(key.length === expected.length && crypto.timingSafeEqual(key, expected));
    });
  });
}

/* ---------- Sessions ---------- */

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}
function sha256(v) {
  return crypto.createHash("sha256").update(v).digest("hex");
}

async function createSession(user, req) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await query(
    `INSERT INTO sessions (user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.user_id, sha256(token), (req.headers["user-agent"] || "").slice(0, 300), null, expires]
  );
  return { token, expires };
}

/* Renvoie l'utilisateur de la session courante, ou null. */
async function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  /* La jointure porte l'état d'acceptation des CGU : une session
     ouverte avant la mise en place de la preuve (ou avant un
     changement de version) doit être bloquée comme une connexion
     neuve, sans quoi elle contourne la ré-acceptation. */
  const r = await query(
    `SELECT u.user_id, u.email, u.first_name, u.last_name, u.role, u.company_id, u.status,
            s.session_id, s.expires_at, s.revoked_at, ta.acceptance_id
       FROM sessions s
       JOIN users u ON u.user_id = s.user_id
       LEFT JOIN terms_acceptances ta
         ON ta.user_id = u.user_id
        AND ta.document_type = CASE
              WHEN u.role LIKE 'SHIPPER_%' THEN 'SHIPPER_TERMS'
              WHEN u.role LIKE 'CARRIER_%' THEN 'CARRIER_TERMS'
            END
        AND ta.document_version = CASE
              WHEN u.role LIKE 'SHIPPER_%' THEN $2
              WHEN u.role LIKE 'CARRIER_%' THEN $3
            END
      WHERE s.token_hash = $1`,
    [sha256(token), DOCUMENTS.SHIPPER.version, DOCUMENTS.CARRIER.version]
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.revoked_at || new Date(row.expires_at) < new Date()) return null;
  if (row.status !== "ACTIVE") return null;
  const terms = termsForRole(row.role);

  return {
    user_id: row.user_id, email: row.email, first_name: row.first_name,
    last_name: row.last_name, role: row.role, company_id: row.company_id,
    session_id: row.session_id,
    /* Document à accepter, ou null si la preuve existe déjà (ou si
       le rôle n'est pas soumis aux conditions). */
    termsPending: terms && !row.acceptance_id ? terms : null
  };
}

async function revokeSession(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[COOKIE_NAME];
  if (!token) return;
  await query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [sha256(token)]);
}

/* ---------- Cookies ---------- */

function parseCookies(header) {
  const out = {};
  header.split(";").forEach((pair) => {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

function sessionCookie(token, expires) {
  const secure = process.env.VERCEL ? "; Secure" : "";
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((expires - Date.now()) / 1000)}${secure}`;
}
function clearCookie() {
  const secure = process.env.VERCEL ? "; Secure" : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

/* Middleware : exige une session. */
function requireAuth(roles) {
  return async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ error: "Authentification requise.", code: "UNAUTHENTICATED" }));
    }
    if (roles && roles.length && !roles.includes(user.role)) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ error: "Droits insuffisants pour cette ressource.", code: "FORBIDDEN" }));
    }
    /* Session valide mais conditions non acceptées : aucune donnée
       métier n'est servie tant que la preuve manque. */
    if (user.termsPending) {
      const t = user.termsPending;
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.end(JSON.stringify({
        error: "Conditions générales à accepter pour continuer.",
        code: "TERMS_REACCEPTANCE_REQUIRED",
        terms: { documentType: t.documentType, version: t.version, label: t.label, url: t.url }
      }));
    }

    req.user = user;
    return null;
  };
}

module.exports = {
  hashPassword, verifyPassword, createSession, getSessionUser, revokeSession,
  sessionCookie, clearCookie, requireAuth, COOKIE_NAME
};
