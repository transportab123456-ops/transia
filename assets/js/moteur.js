/* ============================================================
   Transia — Moteur de matching, cotation et sélection
   Partagé par comparateur.html et admin.html
   - conversion de devise (base EUR)
   - normalisation : prix comparable = transport + frais obligatoires
   - 3 statuts techniques : CONFORME / À VÉRIFIER / NON CONFORME
   - classement + offres de secours
   - validation administrateur (gouvernance)
   ============================================================ */

var Moteur = (function () {
  var TAUX = { EUR: 1, USD: 0.92, GBP: 1.17, CHF: 1.06, MAD: 0.092, JPY: 0.0061, CAD: 0.68, AED: 0.25 };
  var DEVISE_RFQ = "EUR"; /* devise de comparaison choisie par le donneur d'ordre */
  var COMMISSION = 0.08;

  function convertir(prix, devise, cible) {
    var from = TAUX[devise], to = TAUX[cible];
    if (!from || !to) return prix;
    return prix * (from / to);
  }

  /* Normalisation d'une offre */
  function normaliser(offre) {
    var devise = offre.devise || "EUR";
    var frais = offre.fraisObligatoires || 0;
    var taux = TAUX[devise] && TAUX[DEVISE_RFQ] ? +(TAUX[devise] / TAUX[DEVISE_RFQ]).toFixed(4) : 1;
    var transport = convertir(offre.prix, devise, DEVISE_RFQ);
    var fraisEur = convertir(frais, devise, DEVISE_RFQ);

    var statut;
    if (offre.motifNonConformite) statut = "NON_CONFORME";
    else if (offre.fraisAPreciser) statut = "A_VERIFIER";
    else statut = "CONFORME";

    var comparable = (statut === "A_VERIFIER" && frais === 0 && offre.fraisAPreciser)
      ? null
      : Math.round(transport + fraisEur);

    return Object.assign({}, offre, {
      tauxChange: taux,
      deviseComparaison: DEVISE_RFQ,
      transportComparaison: Math.round(transport),
      fraisComparaison: Math.round(fraisEur),
      prixComparable: comparable,
      assietteCommission: Math.round(transport),
      statutTechnique: statut
    });
  }

  /* Classement complet */
  function classer(offres) {
    var norm = offres.map(normaliser);
    var ecartees = norm.filter(function (o) { return o.statutTechnique === "NON_CONFORME"; });
    var aVerifier = norm.filter(function (o) { return o.statutTechnique === "A_VERIFIER"; });
    var conformes = norm.filter(function (o) { return o.statutTechnique === "CONFORME"; });
    conformes.sort(function (a, b) { return a.prixComparable - b.prixComparable; });
    aVerifier.sort(function (a, b) { return (b.prixComparable || 0) - (a.prixComparable || 0); });
    return {
      conforme: conformes,
      aVerifier: aVerifier,
      ecartees: ecartees,
      recommandee: conformes[0] || null,
      secours: conformes.slice(1, 3)
    };
  }

  /* Validation administrateur */
  function getValidations() { return Store.get("validations", {}); }
  function estValidee(ref) { return !!getValidations()[ref]; }
  function valider(ref, choisi, motif) {
    var v = getValidations();
    v[ref] = { choisi: choisi, motif: motif || null, par: "Administrateur", date: nowFr() };
    Store.set("validations", v);
  }

  return {
    TAUX: TAUX,
    DEVISE_RFQ: DEVISE_RFQ,
    COMMISSION: COMMISSION,
    convertir: convertir,
    normaliser: normaliser,
    classer: classer,
    getValidations: getValidations,
    estValidee: estValidee,
    valider: valider
  };
})();
