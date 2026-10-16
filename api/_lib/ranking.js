/* ============================================================
   Transia — api/_lib/ranking.js
   Moteur de comparaison côté serveur (miroir de assets/js/moteur.js,
   mais alimenté par la table fx_rates et les lignes de prix réelles).

   Règles du cahier des charges :
   - prix comparable = transport + FRAIS OBLIGATOIRES (options exclues)
   - converti dans la devise de comparaison (devise du quote_currency
     de la RFQ, EUR par défaut)
   - l'assiette de commission reste la SEULE partie transport
   - 3 statuts : CONFORME / A_VERIFIER / NON_CONFORME
   - seules les offres CONFORME peuvent être recommandées
   ============================================================ */
"use strict";

const { query } = require("./db");

/* Taux : table fx_rates, dernier snapshot (1 unité de la devise
   cotée = rate unités de la base EUR — cf. db/seed.js). */
async function loadFx() {
  const r = await query(
    `SELECT base_currency, quote_currency, rate
       FROM fx_rates
      WHERE rate_date = (SELECT max(rate_date) FROM fx_rates)`
  );
  const map = { EUR: 1 };
  r.rows.forEach((row) => {
    /* on stocke « vaut combien en base EUR » : inverse si besoin */
    if (row.base_currency === "EUR") map[row.quote_currency] = parseFloat(row.rate);
  });
  return map;
}

function toEur(amount, currency, fx) {
  const rate = fx[currency];
  if (rate == null) return null; // devise inconnue : à clarifier
  return amount * rate;
}

/* Normalise une offre (ligne quotes + lignes de prix) et renvoie
   les valeurs de comparaison. */
function normalizeQuote(quote, fx, comparisonCurrency) {
  const target = comparisonCurrency || "EUR";
  const targetRate = fx[target] != null ? fx[target] : 1;

  const transportLocal = parseFloat(quote.base_transport_price);
  const transportEur = toEur(transportLocal, quote.currency, fx);

  let feesLocal = parseFloat(quote.mandatory_fees_total || 0);
  const transportConv = transportEur == null ? null : transportEur / targetRate;
  const feesConv = toEur(feesLocal, quote.currency, fx);
  const feesConvTarget = feesConv == null ? null : feesConv / targetRate;

  let statut;
  let comparable = null;
  if (!quote.scope_comparable) {
    statut = "NON_CONFORME";
  } else if (quote.fees_to_specify || transportConv == null) {
    statut = "A_VERIFIER";
  } else {
    statut = "CONFORME";
    comparable = Math.round(transportConv + (feesConvTarget || 0));
  }

  return {
    quote_id: quote.quote_id,
    rfq_id: quote.rfq_id,
    carrier_company_id: quote.carrier_company_id,
    submitted_at: quote.submitted_at,
    currency: quote.currency,
    base_transport_price: transportLocal,
    mandatory_fees_total: feesLocal,
    transit_time_value: quote.transit_time_value,
    transit_time_unit: quote.transit_time_unit,
    valid_until: quote.valid_until,
    conditions: quote.conditions || null,
    transportConv: transportConv == null ? null : Math.round(transportConv),
    feesConv: feesConvTarget == null ? null : Math.round(feesConvTarget),
    prixComparable: comparable,
    assietteCommission: transportConv == null ? null : Math.round(transportConv),
    statutTechnique: statut,
    motifNonConformite: quote.non_compliance_reason || null,
    conversionRate: fx[quote.currency] != null ? +fx[quote.currency].toFixed(4) : null
  };
}

/* Classement complet d'une RFQ. */
function classify(normalized) {
  const ecartees = normalized.filter((o) => o.statutTechnique === "NON_CONFORME");
  const aVerifier = normalized.filter((o) => o.statutTechnique === "A_VERIFIER");
  const conformes = normalized
    .filter((o) => o.statutTechnique === "CONFORME")
    .sort((a, b) => a.prixComparable - b.prixComparable || String(a.submitted_at).localeCompare(String(b.submitted_at)));

  /* rangs : position parmi les conformes seulement */
  conformes.forEach((o, i) => { o.rank = i + 1; });
  aVerifier.forEach((o) => { o.rank = null; });
  ecartees.forEach((o) => { o.rank = null; });

  return {
    conforme: conformes,
    aVerifier,
    ecartees,
    recommandee: conformes[0] || null,
    secours: conformes.slice(1, 3)
  };
}

module.exports = { loadFx, toEur, normalizeQuote, classify };
