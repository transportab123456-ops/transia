/* ============================================================
   Transia — test/reco-routing-check.js
   Contrôles autonomes du routage des recommandations : ni base ni
   réseau.

   Le point sensible est le repli : sans décision Drex (clé absente,
   panne, timeout), la recommandation doit partir en relecture
   humaine, jamais en validation d'office. Seuls un écart motivé ou
   une probabilité au-dessus du seuil valident d'office ; la
   validation d'une relecture ({ approve }) suit un chemin distinct.
   La section [4] couvre l'empreinte qui permet de refuser une
   relecture devenue obsolète.

   Usage : node test/reco-routing-check.js
   Code de sortie 0 = tous les contrôles passent.
   ============================================================ */
"use strict";

const { routingDecision, rankingFingerprint, rankingRows } = require("../api/recommendations");

let pass = 0;
let failCount = 0;

function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else {
    failCount++;
    console.log("  ✗ " + label + (extra !== undefined ? " → " + JSON.stringify(extra).slice(0, 300) : ""));
  }
}

const AUTO = { routed: "auto", probability: 0.91 };
const REVIEW = { routed: "review", probability: 0.42 };

console.log("\n[1] Repli sans Drex");
const noDrex = routingDecision(null);
check("Drex absent → relecture humaine", noDrex.autoValidate === false, noDrex);
check("Drex absent → motif explicite", /relecture/i.test(noDrex.reason), noDrex.reason);
check("Drex undefined → relecture humaine", routingDecision(undefined).autoValidate === false);

console.log("\n[2] Décision Drex");
const auto = routingDecision(AUTO);
check("au-dessus du seuil → validation d'office", auto.autoValidate === true, auto);
check("validation d'office → aucun motif inventé", auto.reason === null, auto.reason);
const review = routingDecision(REVIEW);
check("sous le seuil → relecture humaine", review.autoValidate === false, review);
check("sous le seuil → motif explicite", /seuil/i.test(review.reason), review.reason);
check("routage inconnu → relecture (repli prudent)",
  routingDecision({ routed: "peut-etre" }).autoValidate === false);
check("routage absent → relecture (repli prudent)",
  routingDecision({ probability: 0.99 }).autoValidate === false);

console.log("\n[3] Écart motivé");
const override = routingDecision(null, { overrideReason: "Offre C retenue pour son délai" });
check("écart motivé → validé", override.autoValidate === true, override);
check("écart motivé → motif conservé", override.reason === "Offre C retenue pour son délai", override.reason);
check("écart motivé prime sur un Drex en relecture",
  routingDecision(REVIEW, { overrideReason: "Offre C retenue pour son délai" }).autoValidate === true);

console.log("\n[4] Empreinte du classement relu");
const reviewed = rankingRows([
  { quote_id: "q-a", rank: 1, prixComparable: 2290 },
  { quote_id: "q-b", rank: 2, prixComparable: 2434 }
]);
const stored = [
  { quote_id: "q-a", rank_position: 1, comparable_price: "2290.00" },
  { quote_id: "q-b", rank_position: 2, comparable_price: "2434.00" }
];
check("classement identique (numeric PostgreSQL) → même empreinte",
  rankingFingerprint(reviewed) === rankingFingerprint(stored));
check("ordre des lignes sans effet",
  rankingFingerprint(reviewed) === rankingFingerprint(stored.slice().reverse()));
check("prix modifié → empreinte différente",
  rankingFingerprint(reviewed) !== rankingFingerprint([stored[0], { ...stored[1], comparable_price: "2400.00" }]));
check("rang modifié → empreinte différente",
  rankingFingerprint(reviewed) !== rankingFingerprint([stored[0], { ...stored[1], rank_position: 1 }]));
check("offre ajoutée → empreinte différente",
  rankingFingerprint(reviewed) !== rankingFingerprint(stored.concat([{ quote_id: "q-c", rank_position: 3, comparable_price: "2500.00" }])));
check("offre retirée → empreinte différente",
  rankingFingerprint(reviewed) !== rankingFingerprint([stored[0]]));
check("classement vide → empreinte vide",
  rankingFingerprint([]) === "" && rankingFingerprint(null) === "");

console.log("\n" + pass + " contrôle(s) OK, " + failCount + " échec(s).");
require("../tools/fin-de-suite")(__filename);
if (failCount) process.exitCode = 1;
