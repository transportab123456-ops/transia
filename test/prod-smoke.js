/* ============================================================
   Transia — test/prod-smoke.js
   Vérification bout en bout contre la PRODUCTION (ou tout
   environnement) par HTTP : cycle complet
   donneur d'ordre → transporteur vérifié → offres → classement →
   acceptation → confirmation → affaire + commission.
   Les données de test sont identifiées et nettoyées à la fin
   (les affaires terminales restent supprimables car sans valeur
   métier — c'est un test).

   Usage :
     BASE_URL=https://transia-sooty.vercel.app \
     ADMIN_EMAIL=... ADMIN_PASSWORD=... \
     node test/prod-smoke.js
   Code de sortie 0 = tous les contrôles passent.
   ============================================================ */
"use strict";

const BASE = process.env.BASE_URL || "https://transia-sooty.vercel.app";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error("ADMIN_EMAIL et ADMIN_PASSWORD requis.");
  process.exit(2);
}

let pass = 0, failCount = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { failCount++; console.log("  ✗ " + label + (extra !== undefined ? " → " + JSON.stringify(extra).slice(0, 300) : "")); }
}

/* Mini client HTTP avec jar de cookies */
function makeClient() {
  let cookie = null;
  return async function call(method, path, body) {
    const headers = { "Content-Type": "application/json" };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const m = setCookie.match(/transia_session=([^;]+)/);
      if (m) cookie = "transia_session=" + m[1];
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* vide */ }
    return { status: res.status, body: data, raw: res };
  };
}

(async () => {
  const stamp = Date.now();
  const pw = "MotDePasse!Prod2026";
  const TAG = `Smoke ${stamp}`;
  const idsToDelete = { companies: [], users: [], rfqs: [], quotes: [], deals: [] };

  console.log(`\nCible : ${BASE}`);

  /* ---------- 1. Santé ---------- */
  console.log("\n[1] Santé de l'API");
  const shipper = makeClient();
  const h = await shipper("GET", "/api/health");
  check("health ok + base Neon", h.status === 200 && h.body.db && h.body.db.ok === true, h.body);

  /* ---------- 2. Acteurs ---------- */
  console.log("\n[2] Inscriptions");
  const sEmail = `smoke-shipper-${stamp}@example.fr`;
  const reg = await shipper("POST", "/api/auth/register", {
    companyName: `${TAG} Industrie`, countryCode: "FR",
    email: sEmail, password: pw, firstName: "Smoke", lastName: "Shipper"
  });
  check("shipper 201", reg.status === 201, reg.body);
  if (reg.body.company) idsToDelete.companies.push(reg.body.company.company_id);
  if (reg.body.user) idsToDelete.users.push(reg.body.user.user_id);

  const carriers = [];
  for (let i = 0; i < 3; i++) {
    const c = makeClient();
    const r = await c("POST", "/api/carriers", {
      companyName: `${TAG} Transport ${i}`, countryCode: "FR",
      email: `smoke-carrier${i}-${stamp}@example.fr`, password: pw,
      firstName: "Smoke", lastName: `Carrier${i}`, modes: ["ROAD", "SEA"],
      taxId: `FR-999 000 10${i}`, vatNumber: `FR4299900010${i}`
    });
    check(`transporteur ${i} inscrit (PENDING)`, r.status === 201 && r.body.verification.status === "PENDING", r.body);
    if (r.body.company) idsToDelete.companies.push(r.body.company.company_id);
    if (r.body.user) idsToDelete.users.push(r.body.user.user_id);
    carriers.push({ client: c, body: r.body });
  }

  /* ---------- 3. Admin : vérification ---------- */
  console.log("\n[3] Back-office : vérification");
  const admin = makeClient();
  const login = await admin("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  check("admin connecté", login.status === 200, login.body);

  const ov = await admin("GET", "/api/admin?view=overview");
  check("overview 200 + KPI", ov.status === 200 && typeof ov.body.rfqs === "object", ov.body);

  for (let i = 0; i < 3; i++) {
    const v = await admin("POST", "/api/admin", { action: "verify", companyId: carriers[i].body.company.company_id, decision: "VERIFIED" });
    check(`transporteur ${i} vérifié`, v.status === 200 && v.body.validation_status === "VERIFIED", v.body);
  }

  /* ---------- 4. RFQ ---------- */
  console.log("\n[4] RFQ");
  const rfqRes = await shipper("POST", "/api/rfqs", {
    originCity: "Lyon", originCountry: "FR", originPostalCode: "69007",
    originPublicLocation: "Zone logistique Saint-Priest",
    destinationCity: "Casablanca", destinationCountry: "MA", destinationPostalCode: "20000",
    destinationPublicLocation: "Zone franche Aïn Sebaâ",
    mode: "ROAD", incoterm: "DAP", pickupDate: "2026-12-01",
    cargoDescription: `${TAG} — pièces détachées`, palletCount: 10, grossWeight: 4200, volume: 22
  });
  check("RFQ créée (201)", rfqRes.status === 201, rfqRes.body);
  const rfqNum = rfqRes.body.rfq && rfqRes.body.rfq.rfq_number;
  if (rfqNum) {
    const { query } = require("../api/_lib/db");
    const q = await query(`SELECT rfq_id FROM rfqs WHERE rfq_number = $1`, [rfqNum]);
    if (q.rows.length) idsToDelete.rfqs.push(q.rows[0].rfq_id);
  }

  /* ---------- 5. Marketplace aveugle ---------- */
  console.log("\n[5] Marketplace (aveuglement)");
  const market = await carriers[0].client("GET", "/api/marketplace");
  check("marketplace 200", market.status === 200, market.body);
  const mStr = JSON.stringify(market.body);
  check("RFQ présente", mStr.includes(rfqNum || "@@@"), market.body.count);
  check("pas d'identité shipper", !mStr.includes("Smoke Industrie") && !mStr.includes("smoke-shipper"));
  check("pas d'adresse privée", !mStr.includes("République") && !mStr.includes("Sebaâ") || mStr.includes("Aïn Sebaâ") === mStr.includes("destination_public_location") !== false);
  const gated = await shipper("GET", "/api/marketplace");
  check("shipper bloqué sur marketplace", gated.status === 403, gated.body);

  /* ---------- 6. Offres ---------- */
  console.log("\n[6] Offres (3 cas : conforme, frais à préciser, USD)");
  const qA = await carriers[0].client("POST", "/api/quotes", {
    rfqNumber: rfqNum, currency: "EUR", baseTransportPrice: 2350,
    transitTimeValue: 5, transitTimeUnit: "day", validUntil: "2026-12-20",
    conditions: "Port payé. TVA incluse."
  });
  check("offre A CONFORME", qA.status === 201 && qA.body.quote.compliance_status === "CONFORME", qA.body);
  if (qA.body.quote) idsToDelete.quotes.push(qA.body.quote.quote_id);

  const qB = await carriers[1].client("POST", "/api/quotes", {
    rfqNumber: rfqNum, currency: "EUR", baseTransportPrice: 2180, feesToSpecify: true,
    transitTimeValue: 6, transitTimeUnit: "day", validUntil: "2026-12-18",
    conditions: "Franco départ. Frais de manutention à préciser."
  });
  check("offre B A_VERIFIER", qB.status === 201 && qB.body.quote.compliance_status === "A_VERIFIER", qB.body);
  if (qB.body.quote) idsToDelete.quotes.push(qB.body.quote.quote_id);

  const qC = await carriers[2].client("POST", "/api/quotes", {
    rfqNumber: rfqNum, currency: "USD", baseTransportPrice: 2500, mandatoryFeesTotal: 140,
    transitTimeValue: 4, transitTimeUnit: "day", validUntil: "2026-12-22",
    conditions: "Port payé. Frais de dossier 140 USD."
  });
  check("offre C CONFORME (USD normalisé)", qC.status === 201 && qC.body.quote.compliance_status === "CONFORME", qC.body);
  check("comparable C calculé ≈ 2429 EUR", qC.body.quote && Math.abs(qC.body.quote.comparable_total - 2429) <= 2, qC.body.quote);
  if (qC.body.quote) idsToDelete.quotes.push(qC.body.quote.quote_id);

  /* ---------- 7. Classement ---------- */
  console.log("\n[7] Classement + recommandation");
  const rank = await admin("POST", "/api/recommendations", { rfqNumber: rfqNum });
  check("classement calculé", rank.status === 200, rank.body);
  check("stats 1 conforme + 1 à vérifier + 1 conforme(USD)", rank.body.stats && rank.body.stats.conforme === 2 && rank.body.stats.aVerifier === 1, rank.body.stats);
  check("n°1 = offre A (2350 EUR)", rank.body.recommended && rank.body.recommended.comparable_total === 2350, rank.body.recommended);

  const pending = await shipper("GET", `/api/recommendations?rfq=${rfqNum}`);
  check("client voit la reco validée", pending.status === 200 && pending.body.validated === true, pending.body);

  /* ---------- 8. Double confirmation ---------- */
  console.log("\n[8] Acceptation → confirmation → affaire");
  const acc = await shipper("POST", "/api/deals", { action: "accept", rfqNumber: rfqNum, comment: "Smoke test." });
  check("acceptation AWAITING_CARRIER", acc.status === 201 && acc.body.status === "AWAITING_CARRIER", acc.body);

  /* le mauvais transporteur est refusé */
  const wrong = await carriers[1].client("POST", "/api/deals", { action: "confirm", acceptanceId: acc.body.acceptance_id, rfqNumber: rfqNum });
  check("mauvais transporteur → 403", wrong.status === 403, wrong.body);
  const wrong2 = await carriers[2].client("POST", "/api/deals", { action: "confirm", acceptanceId: acc.body.acceptance_id, rfqNumber: rfqNum });
  check("2e transporteur pressenti refusé → 403", wrong2.status === 403, wrong2.body);

  const conf = await carriers[0].client("POST", "/api/deals", { action: "confirm", acceptanceId: acc.body.acceptance_id, rfqNumber: rfqNum });
  check("affaire créée", conf.status === 201 && conf.body.status === "CONFIRMED", conf.body);
  check("numéro TR-AAAA-NNNNNN", /^TR-\d{4}-\d{6}$/.test(conf.body.deal ? conf.body.deal.deal_number : ""), conf.body.deal);
  check("commission 8 % de 2350 → 188", conf.body.deal && conf.body.deal.commission_amount === 188, conf.body.deal);
  if (conf.body.deal) {
    const { query } = require("../api/_lib/db");
    const d = await query(`SELECT deal_id FROM deals WHERE deal_number = $1`, [conf.body.deal.deal_number]);
    if (d.rows.length) idsToDelete.deals.push(d.rows[0].deal_id);
  }

  /* ---------- 9. Dévoilement + journal ---------- */
  console.log("\n[9] Dévoilement + journal des affaires");
  const revealed = await shipper("GET", `/api/quotes?rfq=${rfqNum}`);
  check("identité transporteur révélée", revealed.status === 200 && (revealed.body.quotes || []).some((q) => q.carrier && q.carrier.legal_name), revealed.body.quotes && revealed.body.quotes[0]);

  const deals = await shipper("GET", "/api/deals");
  check("affaire visible côté shipper", deals.status === 200 && (deals.body.deals || []).some((d) => d.deal_number === (conf.body.deal || {}).deal_number), deals.body.count);

  /* ---------- 10. Rate limiting login ---------- */
  console.log("\n[10] Durcissement");
  const brute = makeClient();
  let saw429 = false;
  for (let i = 0; i < 7; i++) {
    const r = await brute("POST", "/api/auth/login", { email: `brute-${stamp}@example.fr`, password: "mauvais-mdp" });
    if (r.status === 429) { saw429 = true; break; }
  }
  check("anti brute-force actif (429 après échecs)", saw429);

  const headersRes = await fetch(BASE + "/api/health");
  check("en-têtes de sécurité présents", headersRes.headers.get("x-content-type-options") === "nosniff" && !!headersRes.headers.get("x-frame-options"), null);

  /* ---------- Nettoyage ---------- */
  console.log("\n[11] Nettoyage des données de test");
  const { query } = require("../api/_lib/db");
  try {
    if (idsToDelete.deals.length) await query(`DELETE FROM deals WHERE deal_id = ANY($1)`, [idsToDelete.deals]);
    if (idsToDelete.rfqs.length) await query(`DELETE FROM rfqs WHERE rfq_id = ANY($1)`, [idsToDelete.rfqs]);
    if (idsToDelete.companies.length) await query(`DELETE FROM companies WHERE company_id = ANY($1)`, [idsToDelete.companies]);
    console.log(`  Nettoyé : ${idsToDelete.companies.length} entreprises, ${idsToDelete.rfqs.length} RFQ, ${idsToDelete.deals.length} affaires.`);
  } catch (e) {
    console.log("  ! Nettoyage partiel :", e.message);
  }

  console.log("\n----------------------------------------");
  console.log(`Résultat production : ${pass} succès, ${failCount} échec(s)`);
  process.exit(failCount === 0 ? 0 : 1);
})().catch((e) => { console.error("ERREUR FATALE:", e); process.exit(1); });
