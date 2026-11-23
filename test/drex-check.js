/* ============================================================
   Transia — test/drex-check.js
   Vérification de l'intégration Nace Drex (api/_lib/drex.js) :
   envoie l'état d'un dossier réel (RFQ Lyon → Casablanca, deux
   offres conformes) et contrôle que Drex renvoie bien une
   probabilité calibrée par option, puis route la décision.

   Usage :
     NACE_API_KEY=nace_sk_... node test/drex-check.js
   Code de sortie 0 = tous les contrôles passent, 2 = clé absente.
   ============================================================ */
"use strict";

const { ask, decide, isConfigured, DREX_MODEL, DEFAULT_THRESHOLD } = require("../api/_lib/drex");

if (!isConfigured()) {
  console.error("NACE_API_KEY manquant : impossible d'interroger Drex.");
  process.exit(2);
}

let pass = 0, failCount = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { failCount++; console.log("  ✗ " + label + (extra !== undefined ? " → " + JSON.stringify(extra).slice(0, 300) : "")); }
}

/* État du dossier : les faits utiles à la décision, rien d'autre. */
const STATE = {
  demande: { reference: "RFQ-2026-000042", origine: "Lyon", destination: "Casablanca" },
  offres_conformes: [
    { rang: 1, prix_comparable_eur: 2350, delai: "5 day", validite: "2026-12-20", conditions_renseignees: true },
    { rang: 2, prix_comparable_eur: 2429, delai: "4 day", validite: "2026-12-22", conditions_renseignees: true }
  ],
  ecart_prix_eur_entre_1_et_2: 79,
  offres_a_verifier: 1,
  offres_non_conformes: 0
};

(async () => {
  console.log(`\nModèle demandé : ${DREX_MODEL}`);

  console.log("\n[1] Décision de routage (question « choice »)");
  const decision = await decide({
    questionId: "validation_route",
    threshold: DEFAULT_THRESHOLD,
    instructions: "Le classement de ces offres peut-il être validé d'office et présenté au donneur d'ordre, ou doit-il être relu par un opérateur de la plateforme avant envoi ?",
    options: {
      auto_validate: "Une offre conforme domine clairement les autres, l'écart de prix est net et les offres sont complètes.",
      human_review: "Les offres sont trop proches, incomplètes ou ambiguës : un opérateur doit relire le classement."
    },
    state: STATE
  });

  console.log("  probabilités : " + decision.ranked.map((r) => r.option + "=" + r.probability).join("  "));
  console.log(`  → ${decision.option || decision.unknownOption} (${decision.probability}), seuil ${decision.threshold}, routage « ${decision.routed} »`);
  check("Drex a répondu", !!decision.requestId || !!decision.model, decision);
  check("une probabilité par option", decision.ranked.length === 2, decision.ranked);
  check("option retenue dans les critères envoyés", ["auto_validate", "human_review"].includes(decision.option), decision);
  check("probabilités entre 0 et 1", decision.ranked.every((r) => r.probability >= 0 && r.probability <= 1), decision.ranked);
  check("routage cohérent avec le seuil", decision.routed === (decision.probability >= decision.threshold ? "auto" : "review"), decision);

  console.log("\n[2] Questions typées en un seul appel (noul + score)");
  const multi = await ask({
    state: STATE,
    questions: {
      offres_comparables: {
        type: "noul",
        instructions: "Les deux offres comparables décrivent-elles la même prestation de transport ?"
      },
      urgence: {
        type: "score",
        instructions: "À quel point cette demande est-elle urgente à traiter ?",
        criteria: ["Peut attendre", "Normale", "Urgente"]
      }
    }
  });

  Object.keys(multi.answers).forEach((id) => {
    const a = multi.answers[id];
    console.log("  " + id + " : " + a.ranked.map((r) => r.option + "=" + r.probability).join("  "));
  });
  check("noul : probabilité oui + non", multi.answers.offres_comparables.ranked.length === 2, multi.answers.offres_comparables);
  check("score : une probabilité par niveau", multi.answers.urgence.ranked.length === 3, multi.answers.urgence);
  check("jetons consommés renseignés", !!(multi.usage && multi.usage.input_tokens > 0), multi.usage);

  console.log("\n----------------------------------------");
  console.log(`Résultat : ${pass} succès, ${failCount} échec(s)`);
  require("../tools/fin-de-suite")(__filename);
  process.exit(failCount === 0 ? 0 : 1);
})().catch((err) => {
  console.error("ERREUR FATALE:", err.code || "", err.message);
  process.exit(1);
});
