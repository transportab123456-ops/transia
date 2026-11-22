/* ============================================================
   Transia — api/_lib/reset-token.js
   Jeton de réinitialisation de mot de passe, sans état.

   Format : base64url(user_id) "." expiration_ms "." signature

   La signature est un HMAC-SHA256 qui couvre l'identifiant, la date
   d'expiration ET l'empreinte du mot de passe actuel. Conséquence :
   dès que le mot de passe change, tous les jetons émis auparavant
   deviennent invalides — l'usage unique est garanti sans table ni
   écriture en base, donc sans migration de schéma.

   Secret : RESET_SECRET (32 octets recommandés). Absent ou trop
   court → aucune émission possible (échec fermé).
   ============================================================ */
"use strict";

const crypto = require("crypto");

const TTL_MS = 60 * 60 * 1000; // 1 heure
const MIN_SECRET_LEN = 16;

function secret() {
  const s = process.env.RESET_SECRET || "";
  return s.length >= MIN_SECRET_LEN ? s : null;
}

function configured() {
  return !!secret();
}

function b64url(value) {
  return Buffer.from(String(value), "utf8").toString("base64url");
}

function signature(userId, exp, passwordHash) {
  const s = secret();
  if (!s) return null;
  return crypto
    .createHmac("sha256", s)
    .update(userId + "." + exp + "." + passwordHash)
    .digest("base64url");
}

/* Émet un jeton pour un utilisateur. null si RESET_SECRET manque. */
function sign(userId, passwordHash, nowMs) {
  if (!userId || !passwordHash) return null;
  const exp = (nowMs || Date.now()) + TTL_MS;
  const sig = signature(userId, exp, passwordHash);
  if (!sig) return null;
  return b64url(userId) + "." + exp + "." + sig;
}

/* Décompose un jeton sans vérifier la signature. */
function parse(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  let userId;
  try {
    userId = Buffer.from(parts[0], "base64url").toString("utf8");
  } catch (e) {
    return null;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return null;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp <= 0) return null;
  return { userId, exp, sig: parts[2] };
}

/* Vérifie signature + expiration contre l'empreinte du mot de passe
   actuel du compte. Renvoie { userId, exp } ou null. */
function verify(token, passwordHash, nowMs) {
  const p = parse(token);
  if (!p || !passwordHash) return null;
  const now = nowMs || Date.now();
  if (p.exp < now) return null;
  const expected = signature(p.userId, p.exp, passwordHash);
  if (!expected) return null;
  const given = Buffer.from(p.sig, "utf8");
  const want = Buffer.from(expected, "utf8");
  if (given.length !== want.length) return null;
  return crypto.timingSafeEqual(given, want) ? { userId: p.userId, exp: p.exp } : null;
}

module.exports = { sign, verify, parse, configured, TTL_MS };
