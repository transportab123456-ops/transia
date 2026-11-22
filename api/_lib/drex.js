/* ============================================================
   Transia — api/_lib/drex.js
   Décision assistée (Nace Drex) : envoie l'état d'un dossier et
   des questions typées (noul / choice / score) à l'API de
   décision, puis exploite la probabilité calibrée de CHAQUE
   option — jamais un verdict opaque.

   Règle de routage (Reading answers → « thresholds are a business
   decision ») :
   - option la plus probable >= seuil  → décision automatique
   - sinon                              → relecture humaine
   Toute décision doit être journalisée avec la probabilité brute.

   Clé lue depuis NACE_API_KEY (jamais journalisée, jamais
   renvoyée au client). Sans clé, la plateforme garde son
   comportement actuel : aucune décision n'est inventée.
   ============================================================ */
"use strict";

const DREX_ENDPOINT = process.env.NACE_DREX_URL || "https://console.nace.ai/v1/systemone";
const DREX_MODEL = process.env.NACE_DREX_MODEL || "drex-latest";
const DEFAULT_THRESHOLD = 0.7;    // validation automatique au-dessus
const DEFAULT_TIMEOUT_MS = 15000; // Drex attend la réponse du modèle
const MAX_ATTEMPTS = 2;           // un seul réessai, sur 429 / 5xx

/* La clé ne quitte jamais ce module : elle n'est exposée ni dans
   les erreurs, ni dans les réponses JSON. */
function isConfigured() {
  return String(process.env.NACE_API_KEY || "").trim().length > 0;
}

function describe(payload, status) {
  if (payload && typeof payload === "object") {
    const err = payload.error;
    if (typeof err === "string" && err) return err;
    if (err && typeof err.message === "string") return err.message;
    if (typeof payload.message === "string" && payload.message) return payload.message;
    if (typeof payload.detail === "string" && payload.detail) return payload.detail;
  }
  return "Drex a refusé la requête (HTTP " + status + ").";
}

function codeFor(status) {
  if (status === 401 || status === 403) return "NACE_UNAUTHORIZED";
  if (status === 429) return "NACE_RATE_LIMITED";
  if (status === 402) return "NACE_CREDIT";
  if (status >= 500) return "NACE_UNAVAILABLE";
  return "NACE_HTTP_" + status;
}

function drexError(message, code, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

/* Un appel HTTP à POST /v1/systemone. Une seule tentative de
   réessai, uniquement sur 429 et 5xx (erreurs transitoires). */
async function systemOne(opts) {
  const options = opts || {};
  const key = String(process.env.NACE_API_KEY || "").trim();
  if (!key) {
    throw drexError("NACE_API_KEY absente : décision Drex indisponible.", "NO_NACE_API_KEY");
  }
  if (options.state === undefined) {
    throw drexError("État du dossier (« state ») obligatoire.", "NACE_MISSING_STATE");
  }
  const questions = options.questions;
  if (!questions || typeof questions !== "object" || !Object.keys(questions).length) {
    throw drexError("Au moins une question typée est nécessaire.", "NACE_MISSING_QUESTIONS");
  }

  const model = options.model || DREX_MODEL;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const body = JSON.stringify({ model, state: options.state, questions });

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetch(DREX_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body,
        signal: controller ? controller.signal : undefined
      });

      const raw = await res.text();
      let payload = null;
      try { payload = raw ? JSON.parse(raw) : null; } catch (e) { payload = null; }

      if (!res.ok) {
        const retryAfter = Number(res.headers.get("retry-after")) || null;
        lastError = drexError(describe(payload, res.status), codeFor(res.status), {
          status: res.status,
          retryAfterSec: retryAfter,
          requestId: res.headers.get("x-request-id") || (payload && payload.request_id) || null
        });
        const transient = res.status === 429 || res.status >= 500;
        if (transient && attempt < MAX_ATTEMPTS) {
          const wait = Math.min(retryAfter ? retryAfter * 1000 : 400 * attempt, 3000);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw lastError;
      }

      if (!payload || typeof payload !== "object" || !payload.answers) {
        throw drexError("Réponse Drex illisible (answers manquant).", "NACE_BAD_RESPONSE");
      }
      return payload;
    } catch (err) {
      if (err && (err.name === "AbortError" || err.code === "ABORT_ERR")) {
        lastError = drexError("Drex n'a pas répondu dans le délai imparti.", "NACE_TIMEOUT");
        if (attempt < MAX_ATTEMPTS) continue;
        throw lastError;
      }
      if (err && err.code && String(err.code).startsWith("NACE_")) throw err;
      if (err && err.code === "NO_NACE_API_KEY") throw err;
      /* erreur réseau / fetch indisponible : dernier essai */
      lastError = drexError(
        "Drex injoignable : " + (err && err.message ? err.message : "erreur réseau"),
        "NACE_UNREACHABLE"
      );
      if (attempt < MAX_ATTEMPTS) continue;
      throw lastError;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError || drexError("Échec de l'appel Drex.", "NACE_UNAVAILABLE");
}

/* Probabilité calibrée de chaque option, de la plus probable à la
   moins probable. Gère les trois types de réponse :
   - noul   : oui / non (noul = probabilité de « oui »)
   - choice : une probabilité par libellé envoyé
   - score  : une probabilité par niveau (clés « 0 »..« n-1 ») */
function rankOptions(answer) {
  if (!answer || typeof answer !== "object") return [];
  let entries = [];

  if (answer.type === "noul" || typeof answer.noul === "number") {
    const yes = Number(answer.noul);
    if (Number.isFinite(yes)) entries = [["true", yes], ["false", 1 - yes]];
  } else if (answer.probabilities && typeof answer.probabilities === "object") {
    const legend = Array.isArray(answer.legend) ? answer.legend : null;
    entries = Object.keys(answer.probabilities).map((label) => {
      const idx = Number(label);
      const named = answer.type === "score" && legend && legend[idx] != null ? String(legend[idx]) : label;
      return [named, Number(answer.probabilities[label])];
    });
  }

  return entries
    .filter((e) => Number.isFinite(e[1]))
    .map((e) => ({ option: e[0], probability: e[1] }))
    .sort((a, b) => b.probability - a.probability || String(a.option).localeCompare(String(b.option)));
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

/* Pose une question « choice » et transforme les probabilités en
   décision : option retenue, écart avec la suivante et routage
   automatique ou relecture humaine selon le seuil. */
async function decide(opts) {
  const options = opts || {};
  const criteria = options.options;
  if (!criteria || typeof criteria !== "object" || Object.keys(criteria).length < 2) {
    throw drexError("Une décision demande au moins deux options.", "NACE_INVALID_OPTIONS");
  }
  const questionId = options.questionId || "decision";
  const threshold = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_THRESHOLD;

  const payload = await systemOne({
    state: options.state,
    model: options.model,
    timeoutMs: options.timeoutMs,
    questions: {
      [questionId]: {
        type: "choice",
        instructions: options.instructions,
        criteria
      }
    }
  });

  const answer = payload.answers[questionId];
  const ranked = rankOptions(answer);
  if (!ranked.length) {
    throw drexError("Réponse Drex sans probabilité exploitable.", "NACE_BAD_RESPONSE");
  }

  const top = ranked[0];
  const second = ranked[1] || null;
  const known = criteria[top.option] !== undefined;

  return {
    question: questionId,
    model: payload.model || options.model || DREX_MODEL,
    option: known ? top.option : null,
    unknownOption: known ? null : top.option,
    probability: round4(top.probability),
    runnerUp: second ? { option: second.option, probability: round4(second.probability) } : null,
    margin: second ? round4(top.probability - second.probability) : round4(top.probability),
    ranked: ranked.map((r) => ({ option: r.option, probability: round4(r.probability) })),
    confidence: typeof answer.confidence === "number" ? round4(answer.confidence) : null,
    threshold,
    routed: known && top.probability >= threshold ? "auto" : "review",
    usage: payload.usage || null,
    evaluationMs: typeof payload.evaluation_time_ms === "number" ? payload.evaluation_time_ms : null,
    requestId: payload.request_id || null
  };
}

/* Plusieurs questions typées en un seul appel (recommandé par Drex :
   l'état est facturé une seule fois). Renvoie, pour chaque question,
   les options classées par probabilité décroissante. */
async function ask(opts) {
  const options = opts || {};
  const payload = await systemOne({
    state: options.state,
    model: options.model,
    timeoutMs: options.timeoutMs,
    questions: options.questions
  });

  const answers = {};
  Object.keys(options.questions).forEach((id) => {
    const ranked = rankOptions(payload.answers[id]);
    answers[id] = {
      ranked: ranked.map((r) => ({ option: r.option, probability: round4(r.probability) })),
      top: ranked.length ? { option: ranked[0].option, probability: round4(ranked[0].probability) } : null
    };
  });

  return {
    model: payload.model || options.model || DREX_MODEL,
    answers,
    usage: payload.usage || null,
    evaluationMs: typeof payload.evaluation_time_ms === "number" ? payload.evaluation_time_ms : null,
    requestId: payload.request_id || null
  };
}

module.exports = { systemOne, ask, decide, rankOptions, isConfigured, DREX_MODEL, DEFAULT_THRESHOLD };
