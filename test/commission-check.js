/* ============================================================
   Transia — Vérification du barème de commission (scénario D)
   Test unitaire pur : ni base de données, ni serveur.

   Usage : node test/commission-check.js
   ============================================================ */
"use strict";

const serveur = require("../api/_lib/commission");
const navigateur = require("../assets/js/commission");

let echecs = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log("  ✓ " + label);
  } else {
    echecs++;
    console.log("  ✗ " + label + (detail !== undefined ? " → " + JSON.stringify(detail) : ""));
  }
}

console.log("[1] Valeurs de référence (clause CGU)");
const attendus = [
  { assiette: 800, commission: 64 },
  { assiette: 1200, commission: 96 },
  { assiette: 2000, commission: 160 },
  { assiette: 2290, commission: 177.4 },
  { assiette: 2350, commission: 181 },
  { assiette: 3500, commission: 250 },
  { assiette: 7200, commission: 472 },
  { assiette: 10000, commission: 640 },
  { assiette: 18000, commission: 700 },
  { assiette: 45000, commission: 700 },
  { assiette: 50000, commission: 700 }
];
attendus.forEach(function (cas) {
  const r = serveur.calculer(cas.assiette);
  check(cas.assiette + " € → " + cas.commission + " €", r.commission === cas.commission, r);
});

console.log("\n[2] Plafond et taux effectif");
check("plafond non atteint à 2 000 €", serveur.calculer(2000).plafondApplique === false);
check("plafond atteint à 18 000 €", serveur.calculer(18000).plafondApplique === true);
check("brut 50 000 € = 1 940 € ramené à 700 €", serveur.calculer(50000).commission === 700);
check("taux effectif 2 000 € = 8 %", serveur.calculer(2000).tauxEffectif === 0.08);
check("taux effectif 2 290 € = 7,75 %", serveur.calculer(2290).tauxEffectif === 0.0775);
check("taux effectif 50 000 € = 1,4 %", serveur.calculer(50000).tauxEffectif === 0.014);

console.log("\n[3] Entrées dégénérées");
[0, -100, null, undefined, "", "abc", NaN].forEach(function (v) {
  const r = serveur.calculer(v);
  check("assiette " + JSON.stringify(v) + " → 0 €", r.commission === 0 && r.tauxEffectif === 0, r);
});
check("assiette en chaîne numérique acceptée", serveur.calculer("3500").commission === 250);

console.log("\n[4] Une seule implémentation");
check("api/_lib/commission réexporte le fichier navigateur", serveur === navigateur);
check("même barème des deux côtés", serveur.TRANCHES.length === 4 && serveur.PLAFOND === 700);
check("libellé sans parenthèses imbriquées", serveur.LIBELLE.indexOf("(") === -1, serveur.LIBELLE);
check("libellé annonce le plafond", /700/.test(serveur.LIBELLE), serveur.LIBELLE);

console.log("");
if (echecs) {
  console.log("ÉCHEC — " + echecs + " contrôle(s) en erreur.");
  process.exit(1);
}
console.log("OK — barème conforme, une seule implémentation.");
require("../tools/fin-de-suite")(__filename);
