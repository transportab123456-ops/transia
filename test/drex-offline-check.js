/* ============================================================
   Transia — test/drex-offline-check.js
   Contrôles déterministes de l'intégration Nace Drex
   (api/_lib/drex.js) : ni clé, ni réseau, ni base.

   `fetch` est remplacé par un double qui enregistre l'appel et
   rend une réponse choisie. On vérifie donc, sans jamais sortir de
   la machine : la requête construite (endpoint, en-tête
   d'autorisation, modèle, état, questions typées), la lecture de la
   réponse calibrée (choice / noul / score, arrondis, ex æquo,
   option inconnue, seuil de routage) et le repli quand Drex est
   injoignable — réseau coupé, délai dépassé, 429/5xx, réponse
   illisible —, qui doit toujours produire une relecture humaine et
   jamais une validation d'office.

   Le pendant réel, qui appelle l'API avec NACE_API_KEY, reste
   test/drex-check.js : il n'est pas dans `npm test`.

   Usage : node test/drex-offline-check.js
   Code de sortie 0 = tous les contrôles passent.
   ============================================================ */
"use strict";

/* L'endpoint et le modèle sont lus à l'import du module : on les
   fixe avant le require pour prouver qu'ils viennent bien de
   l'environnement, et on part sans clé. */
process.env.NACE_DREX_URL = "https://drex.invalid/v1/systemone";
process.env.NACE_DREX_MODEL = "drex-test-modele";
delete process.env.NACE_API_KEY;

const { systemOne, ask, decide, rankOptions, isConfigured, DEFAULT_THRESHOLD } = require("../api/_lib/drex");
const { routingDecision } = require("../api/recommendations");

let pass = 0;
let failCount = 0;

function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else {
    failCount++;
    console.log("  ✗ " + label + (extra !== undefined ? " → " + JSON.stringify(extra).slice(0, 300) : ""));
  }
}

/* ---------- Double de fetch : aucun paquet ne quitte la machine ---------- */
const realFetch = globalThis.fetch;
const calls = [];
let handler = null;

globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  if (!handler) throw new Error("fetch inattendu : " + url);
  return handler(url, init);
};

function stub(fn) {
  calls.length = 0;
  handler = fn;
}

function reset() {
  calls.length = 0;
  handler = null;
}

function response(status, body, headers) {
  const h = headers || {};
  const get = (name) => {
    const v = h[String(name).toLowerCase()];
    return v === undefined ? null : String(v);
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body))
  };
}

/* Rend l'erreur d'un appel qui doit échouer, sans la laisser remonter. */
async function failureOf(fn) {
  try {
    await fn();
    return { code: null, message: "(aucune erreur)", err: null };
  } catch (err) {
    return { code: err && err.code ? err.code : null, message: err && err.message, err };
  }
}

const KEY = "nace_sk_test_offline";
const STATE = {
  demande: { reference: "RFQ-2026-000042", origine: "Lyon", destination: "Casablanca" },
  offres_conformes: [
    { rang: 1, prix_comparable_eur: 2350 },
    { rang: 2, prix_comparable_eur: 2429 }
  ],
  ecart_prix_eur_entre_1_et_2: 79
};
const QUESTIONS = {
  conforme: { type: "noul", instructions: "Le dossier est-il complet ?" },
  route: {
    type: "choice",
    instructions: "Valider d'office ?",
    criteria: { auto_validate: "écart net", human_review: "offres proches" }
  },
  urgence: { type: "score", instructions: "Urgence", levels: ["faible", "moyenne", "forte"] }
};

(async () => {
  console.log("\n[1] Sans clé : aucun appel réseau");
  check("isConfigured() faux sans clé", isConfigured() === false);
  let err = await failureOf(() => systemOne({ state: STATE, questions: QUESTIONS }));
  check("clé absente → NO_NACE_API_KEY", err.code === "NO_NACE_API_KEY", err.code);
  check("clé absente → fetch jamais appelé", calls.length === 0, calls.length);

  process.env.NACE_API_KEY = KEY;
  check("isConfigured() vrai avec clé", isConfigured() === true);

  err = await failureOf(() => systemOne({ questions: QUESTIONS }));
  check("état absent → NACE_MISSING_STATE", err.code === "NACE_MISSING_STATE", err.code);
  err = await failureOf(() => systemOne({ state: STATE, questions: {} }));
  check("aucune question → NACE_MISSING_QUESTIONS", err.code === "NACE_MISSING_QUESTIONS", err.code);
  err = await failureOf(() => decide({ state: STATE, options: { seule: "unique" } }));
  check("décision à moins de deux options → NACE_INVALID_OPTIONS", err.code === "NACE_INVALID_OPTIONS", err.code);
  check("ces refus n'appellent pas le réseau", calls.length === 0, calls.length);

  console.log("\n[2] Construction de la requête");
  stub(() => response(200, { model: "drex-test-modele", answers: {}, request_id: "req-brut" }));
  const raw = await systemOne({ state: STATE, questions: QUESTIONS });
  check("un seul appel HTTP", calls.length === 1, calls.length);
  const call = calls[0] || { init: { headers: {} } };
  check("URL lue depuis NACE_DREX_URL", call.url === "https://drex.invalid/v1/systemone", call.url);
  check("méthode POST", call.init.method === "POST", call.init.method);
  check("clé en en-tête Authorization", call.init.headers.Authorization === "Bearer " + KEY, call.init.headers.Authorization);
  check("en-têtes JSON acceptés", call.init.headers["Content-Type"] === "application/json" && call.init.headers.Accept === "application/json", call.init.headers);
  const sent = JSON.parse(call.init.body);
  check("modèle par défaut lu depuis NACE_DREX_MODEL", sent.model === "drex-test-modele", sent.model);
  check("état du dossier transmis tel quel", JSON.stringify(sent.state) === JSON.stringify(STATE), sent.state);
  check("questions typées transmises avec leurs critères", JSON.stringify(sent.questions) === JSON.stringify(QUESTIONS), sent.questions);
  check("la clé n'apparaît jamais dans le corps", String(call.init.body).indexOf(KEY) === -1);
  check("réponse brute relayée telle quelle", raw.request_id === "req-brut", raw);

  stub(() => response(200, { answers: {} }));
  await systemOne({ state: STATE, questions: QUESTIONS, model: "drex-autre" });
  check("modèle explicite prioritaire sur l'environnement", JSON.parse(calls[0].init.body).model === "drex-autre", JSON.parse(calls[0].init.body).model);

  console.log("\n[3] Lecture de la réponse calibrée");
  const CRITERIA = { auto_validate: "écart net", human_review: "offres proches" };
  stub(() => response(200, {
    model: "drex-test-modele",
    answers: { validation_route: { type: "choice", probabilities: { auto_validate: 0.72, human_review: 0.28 }, confidence: 0.81 } },
    usage: { total_tokens: 120 },
    evaluation_time_ms: 940,
    request_id: "req-choice"
  }));
  const decision = await decide({ questionId: "validation_route", threshold: 0.7, state: STATE, options: CRITERIA });
  check("option la plus probable retenue", decision.option === "auto_validate", decision.option);
  check("probabilité calibrée arrondie au 1/10000", decision.probability === 0.72, decision.probability);
  check("seconde option et écart conservés", decision.runnerUp.option === "human_review" && decision.runnerUp.probability === 0.28 && decision.margin === 0.44, decision.runnerUp);
  check("classement complet par probabilité décroissante", decision.ranked.map((r) => r.option).join(",") === "auto_validate,human_review", decision.ranked);
  check("au-dessus du seuil → validation d'office", decision.routed === "auto" && decision.threshold === 0.7, { routed: decision.routed, threshold: decision.threshold });
  check("confiance, usage, durée et request_id relayés", decision.confidence === 0.81 && decision.usage.total_tokens === 120 && decision.evaluationMs === 940 && decision.requestId === "req-choice", decision);

  stub(() => response(200, { answers: { validation_route: { type: "choice", probabilities: { auto_validate: 0.55, human_review: 0.45 } } } }));
  const below = await decide({ questionId: "validation_route", threshold: 0.7, state: STATE, options: CRITERIA });
  check("sous le seuil → relecture", below.routed === "review", below.routed);
  check("sous le seuil → jamais validé par le routage", routingDecision(below).autoValidate === false);

  stub(() => response(200, { answers: { validation_route: { type: "choice", probabilities: { auto_validate: 0.9, human_review: 0.1 } } } }));
  const withoutThreshold = await decide({ questionId: "validation_route", state: STATE, options: CRITERIA });
  check("seuil par défaut appliqué", withoutThreshold.threshold === DEFAULT_THRESHOLD, withoutThreshold.threshold);

  stub(() => response(200, { answers: { validation_route: { type: "choice", probabilities: { option_inconnue: 0.9, human_review: 0.1 } } } }));
  const unknown = await decide({ questionId: "validation_route", state: STATE, options: CRITERIA });
  check("option hors critères → option null et unknownOption renseigné", unknown.option === null && unknown.unknownOption === "option_inconnue", unknown);
  check("option inconnue → relecture, même à 0,9", unknown.routed === "review", unknown.routed);

  /* rankOptions rend le complément brut (1 - 0,8 = 0,19999999999999996) :
     l'arrondi au 1/10000 est fait par decide()/ask(), pas ici. */
  const noul = rankOptions({ type: "noul", noul: 0.8 });
  check("noul → oui puis non, complémentaires au flottant près",
    noul.length === 2 && noul[0].option === "true" && noul[0].probability === 0.8 &&
    noul[1].option === "false" && Math.abs(noul[1].probability - 0.2) < 1e-9 &&
    Math.abs(noul[0].probability + noul[1].probability - 1) < 1e-9, noul);
  const score = rankOptions({ type: "score", legend: ["faible", "moyenne", "forte"], probabilities: { "0": 0.15, "1": 0.7, "2": 0.15 } });
  check("score → niveaux nommés par la légende", score.map((r) => r.option).join(",") === "moyenne,faible,forte", score);
  const tie = rankOptions({ type: "choice", probabilities: { beta: 0.5, alpha: 0.5 } });
  check("ex æquo → ordre alphabétique stable", tie.map((r) => r.option).join(",") === "alpha,beta", tie);
  check("probabilité non numérique ignorée", rankOptions({ type: "choice", probabilities: { a: "x", b: 0.4 } }).length === 1);
  check("réponse vide → aucun classement", rankOptions(null).length === 0 && rankOptions({}).length === 0);

  stub(() => response(200, {
    model: "drex-test-modele",
    answers: { conforme: { type: "noul", noul: 0.9 }, route: { type: "choice", probabilities: { auto_validate: 0.6, human_review: 0.4 } } }
  }));
  const multi = await ask({ state: STATE, questions: { conforme: { type: "noul" }, route: { type: "choice", criteria: CRITERIA } } });
  check("ask → une seule requête pour deux questions", calls.length === 1, calls.length);
  check("ask → sommet par question", multi.answers.conforme.top.option === "true" && multi.answers.conforme.top.probability === 0.9 && multi.answers.route.top.option === "auto_validate" && multi.answers.route.top.probability === 0.6, multi.answers);

  console.log("\n[4] Réponses inexploitables");
  stub(() => response(200, { model: "drex-test-modele" }));
  err = await failureOf(() => systemOne({ state: STATE, questions: QUESTIONS }));
  check("answers manquant → NACE_BAD_RESPONSE", err.code === "NACE_BAD_RESPONSE", err.code);

  stub(() => response(200, "<html>proxy</html>"));
  err = await failureOf(() => systemOne({ state: STATE, questions: QUESTIONS }));
  check("corps non JSON → NACE_BAD_RESPONSE", err.code === "NACE_BAD_RESPONSE", err.code);

  stub(() => response(200, { answers: { validation_route: { type: "choice", probabilities: {} } } }));
  err = await failureOf(() => decide({ questionId: "validation_route", state: STATE, options: CRITERIA }));
  check("aucune probabilité exploitable → NACE_BAD_RESPONSE", err.code === "NACE_BAD_RESPONSE", err.code);

  console.log("\n[5] Erreurs HTTP");
  stub(() => response(401, { error: "clé invalide" }, { "retry-after": "3", "x-request-id": "req-401" }));
  err = await failureOf(() => systemOne({ state: STATE, questions: QUESTIONS }));
  check("401 → NACE_UNAUTHORIZED", err.code === "NACE_UNAUTHORIZED", err.code);
  check("message repris de l'API", err.message === "clé invalide", err.message);
  check("401 non réessayé", calls.length === 1, calls.length);
  check("retry-after et request-id conservés", err.err && err.err.retryAfterSec === 3 && err.err.requestId === "req-401", err.err && { retryAfterSec: err.err.retryAfterSec, requestId: err.err.requestId });
  check("la clé n'apparaît pas dans l'erreur", String(err.message).indexOf(KEY) === -1, err.message);

  stub(() => response(402, { error: { message: "crédits épuisés" } }));
  err = await failureOf(() => systemOne({ state: STATE, questions: QUESTIONS }));
  check("402 → NACE_CREDIT, sans réessai", err.code === "NACE_CREDIT" && calls.length === 1, { code: err.code, calls: calls.length });

  stub(() => response(429, { message: "trop vite" }));
  err = await failureOf(() => systemOne({ state: STATE, questions: QUESTIONS }));
  check("429 → un seul réessai puis NACE_RATE_LIMITED", err.code === "NACE_RATE_LIMITED" && calls.length === 2, { code: err.code, calls: calls.length });

  stub(() => response(503, { error: { message: "service indisponible" }, request_id: "req-503" }));
  err = await failureOf(() => systemOne({ state: STATE, questions: QUESTIONS }));
  check("503 → un seul réessai puis NACE_UNAVAILABLE", err.code === "NACE_UNAVAILABLE" && calls.length === 2, { code: err.code, calls: calls.length });
  check("request_id repris du corps quand l'en-tête manque", err.err && err.err.requestId === "req-503", err.err && err.err.requestId);

  console.log("\n[6] Repli quand Drex est injoignable");
  stub(() => { throw new TypeError("fetch failed"); });
  err = await failureOf(() => decide({ questionId: "validation_route", state: STATE, options: CRITERIA }));
  check("réseau coupé → NACE_UNREACHABLE", err.code === "NACE_UNREACHABLE", err.code);
  check("deux tentatives avant d'abandonner", calls.length === 2, calls.length);
  check("message explicite", /injoignable/i.test(String(err.message)), err.message);

  /* Même contrat que api/recommendations.js : l'erreur est avalée,
     la décision reste nulle et le routage part en relecture. */
  let drex = null;
  try {
    drex = await decide({ questionId: "validation_route", state: STATE, options: CRITERIA });
  } catch (e) {
    drex = null;
  }
  const fallback = routingDecision(drex);
  check("Drex injoignable → décision nulle", drex === null, drex);
  check("Drex injoignable → relecture humaine", fallback.autoValidate === false && /relecture/i.test(String(fallback.reason)), fallback);

  stub(() => { const e = new Error("aborted"); e.name = "AbortError"; throw e; });
  err = await failureOf(() => systemOne({ state: STATE, questions: QUESTIONS }));
  check("délai dépassé → NACE_TIMEOUT", err.code === "NACE_TIMEOUT", err.code);
  check("timeout → un réessai", calls.length === 2, calls.length);

  stub(() => { const e = new Error("socket hang up"); e.code = "ECONNRESET"; throw e; });
  err = await failureOf(() => systemOne({ state: STATE, questions: QUESTIONS }));
  check("connexion réinitialisée → NACE_UNREACHABLE", err.code === "NACE_UNREACHABLE", err.code);

  reset();
  globalThis.fetch = realFetch;
  delete process.env.NACE_API_KEY;
  delete process.env.NACE_DREX_URL;
  delete process.env.NACE_DREX_MODEL;

  console.log("\n" + pass + " contrôle(s) OK, " + failCount + " échec(s).");
  process.exit(failCount ? 1 : 0);
})().catch((err) => {
  globalThis.fetch = realFetch;
  console.error("Échec inattendu :", err && err.stack ? err.stack : err);
  process.exit(1);
});
