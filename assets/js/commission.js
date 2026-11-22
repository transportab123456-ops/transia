/* ============================================================
   Transia — Barème de commission (scénario D, clause CGU)

   SOURCE UNIQUE. Ce fichier est chargé tel quel par le navigateur
   et par les fonctions serverless, via api/_lib/commission.js qui
   le réexporte. Il n'y a donc qu'une seule implémentation.

   Barème dégressif par tranches, appliqué MARGINALEMENT :
     jusqu'à 2 000 €       → 8 %
     2 000 à 10 000 €      → 6 %
     10 000 à 30 000 €     → 4 %
     au-delà de 30 000 €   → 2,5 %
   Plafond : 700 € par opération de transport.
   ============================================================ */

var Commission = (function () {
  var TRANCHES = [
    { jusquA: 2000, taux: 0.08 },
    { jusquA: 10000, taux: 0.06 },
    { jusquA: 30000, taux: 0.04 },
    { jusquA: Infinity, taux: 0.025 }
  ];

  var PLAFOND = 700;

  /* Libellé destiné aux e-mails et aux écrans : sans parenthèses
     internes, car il est lui-même inséré entre parenthèses. */
  var LIBELLE = "8 % → 2,5 % dégressif, plafond 700 €";

  /* Commission due sur une assiette (partie transport seule). */
  function calculer(assiette) {
    var base = Number(assiette);
    if (!isFinite(base) || base <= 0) {
      return { assiette: 0, commission: 0, tauxEffectif: 0, plafondApplique: false };
    }

    var bas = 0;
    var brut = 0;
    for (var i = 0; i < TRANCHES.length; i++) {
      var t = TRANCHES[i];
      var haut = Math.min(base, t.jusquA);
      if (haut > bas) brut += (haut - bas) * t.taux;
      bas = haut;
      if (bas >= base) break;
    }

    var plafondApplique = brut > PLAFOND;
    var commission = Math.round(Math.min(brut, PLAFOND) * 100) / 100;

    return {
      assiette: base,
      commission: commission,
      tauxEffectif: Math.round((commission / base) * 10000) / 10000,
      plafondApplique: plafondApplique
    };
  }

  return {
    TRANCHES: TRANCHES,
    PLAFOND: PLAFOND,
    LIBELLE: LIBELLE,
    calculer: calculer
  };
})();

/* Export CommonJS pour les fonctions serverless (api/_lib/commission.js).
   En navigateur, `module` n'existe pas : la condition est ignorée. */
if (typeof module === "object" && module && module.exports) {
  module.exports = Commission;
}
