/* ============================================================
   Transia — test/token-check.js
   Contrôle le jeton de réinitialisation (signature, expiration,
   altération, invalidation après changement de mot de passe).
   Ne touche ni la base ni le réseau.

   Usage : node test/token-check.js
   ============================================================ */
"use strict";

process.env.RESET_SECRET = "secret-de-test-0123456789abcdef";

const resetToken = require("../api/_lib/reset-token");

let ok = 0;
let ko = 0;

function check(label, cond, detail) {
  if (cond) {
    ok++;
    console.log("  ✓ " + label);
  } else {
    ko++;
    console.log("  ✗ " + label + (detail !== undefined ? "  → " + JSON.stringify(detail) : ""));
  }
}

const UID = "ea270fff-cc78-4f19-ae35-07fd5e14a4e4";
const OTHER_UID = "11111111-1111-1111-1111-111111111111";
const HASH = "scrypt$16384$8$1$c2FsdA==$aGFzaA==";

console.log("\n[1] Émission et vérification");
const token = resetToken.sign(UID, HASH);
check("jeton émis (3 segments)", typeof token === "string" && token.split(".").length === 3, token);
check("vérifié avec la bonne empreinte", !!resetToken.verify(token, HASH));
check("identifiant retrouvé", (resetToken.verify(token, HASH) || {}).userId === UID);
check("expiration à une heure", (resetToken.parse(token) || {}).exp - Date.now() <= resetToken.TTL_MS);

console.log("\n[2] Refus attendus");
check("refusé si le mot de passe a changé", resetToken.verify(token, HASH + "x") === null);
check("refusé si la signature est altérée", resetToken.verify(token.slice(0, -2) + "AA", HASH) === null);
check("refusé si l'identifiant est remplacé",
  resetToken.verify(
    Buffer.from(OTHER_UID).toString("base64url") + "." + token.split(".").slice(1).join("."),
    HASH
  ) === null);
check("refusé après expiration", resetToken.verify(token, HASH, Date.now() + resetToken.TTL_MS + 1000) === null);
check("accepté juste avant expiration", !!resetToken.verify(token, HASH, Date.now() + resetToken.TTL_MS - 1000));
check("jeton malformé refusé", resetToken.verify("abc", HASH) === null);
check("jeton vide refusé", resetToken.verify("", HASH) === null);
check("empreinte absente refusée", resetToken.verify(token, "") === null);
check("parse() rejette un identifiant non uuid",
  resetToken.parse(Buffer.from("pas-un-uuid").toString("base64url") + ".9999999999999.abc") === null);

console.log("\n[3] Configuration du secret");
const saved = process.env.RESET_SECRET;
delete process.env.RESET_SECRET;
check("configured() faux sans secret", resetToken.configured() === false);
check("sign() renvoie null sans secret", resetToken.sign(UID, HASH) === null);
check("verify() renvoie null sans secret", resetToken.verify(token, HASH) === null);
process.env.RESET_SECRET = "trop-court";
check("secret trop court refusé", resetToken.sign(UID, HASH) === null);
process.env.RESET_SECRET = saved;
check("configured() vrai avec secret", resetToken.configured() === true);

console.log("\n----------------------------------------");
console.log("Jeton : " + ok + " succès, " + ko + " échec(s)");
require("../tools/fin-de-suite")(__filename);
process.exit(ko ? 1 : 0);
