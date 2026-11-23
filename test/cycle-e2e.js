/* ============================================================
   Transia — test/cycle-e2e.js
   Test end-to-end du CYCLE MÉTIER COMPLETE contre la vraie
   PostgreSQL locale (Docker) :

   donneur d'ordre crée une RFQ → transporteur (non vérifié) est
   bloqué → l'admin le vérifie → 3 offres (dont 2 cas limites) →
   classement normalisé + recommandation validée (avec écart
   motivé) → acceptation → confirmation → affaire + commission
   →RBAC + aveuglement vérifiés.

   Usage : DATABASE_URL=... node test/cycle-e2e.js
   ============================================================ */
"use strict";

const { PassThrough, Writable } = require("stream");

require("../db/env").requireDatabaseUrl();

function makeReq(method, body, headers = {}, query = {}) {
  const req = new PassThrough();
  req.method = method;
  req.headers = { "content-type": "application/json", ...headers };
  req.query = query;
  process.nextTick(() => {
    if (body !== undefined && body !== null) {
      req.end(typeof body === "string" ? body : JSON.stringify(body));
    } else {
      req.end();
    }
  });
  return req;
}

function makeRes() {
  const res = new Writable({
    write(chunk, enc, cb) { this._raw += chunk.toString(); cb(); }
  });
  res._raw = "";
  res.statusCode = 200;
  res._headers = {};
  res.setHeader = (k, v) => { res._headers[k.toLowerCase()] = v; };
  res.getHeader = (k) => res._headers[k.toLowerCase()];
  res._done = new Promise((resolve) => res.on("finish", resolve));
  res.body = () => { try { return JSON.parse(res._raw || "{}"); } catch (e) { return { _parseError: true, raw: res._raw }; } };
  return res;
}

async function call(handler, method, body, headers, query) {
  /* GET : le 3e argument sert de paramètres d'URL (?rfq=…) */
  const q = method === "GET" && body && typeof body === "object" ? body : (query || {});
  const b = method === "GET" && body && typeof body === "object" ? undefined : body;
  const req = makeReq(method, b, headers, q);
  const res = makeRes();
  await handler(req, res);
  await res._done;
  return { status: res.statusCode, headers: res._headers, body: res.body() };
}

let pass = 0, failCount = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { failCount++; console.log("  ✗ " + label + (extra !== undefined ? " → " + JSON.stringify(extra) : "")); }
}

function extractCookie(resHeaders) {
  const set = resHeaders["set-cookie"];
  if (!set) return null;
  const arr = Array.isArray(set) ? set : [set];
  const m = arr.join("; ").match(/transia_session=([^;]+)/);
  return m ? "transia_session=" + m[1] : null;
}

const register = require("../api/auth/register");
const login = require("../api/auth/login");
const carriers = require("../api/carriers");
const rfqs = require("../api/rfqs");
const marketplace = require("../api/marketplace");
const quotes = require("../api/quotes");
const recommendations = require("../api/recommendations");
const deals = require("../api/deals");
const admin = require("../api/admin");

(async () => {
  const stamp = Date.now();
  const pw = "motdepasse-test-2026";

  /* ---------- Acteurs ---------- */
  console.log("\n[1] Création des acteurs");

  const shipper = await call(register, "POST", {
    email: `cycle-shipper-${stamp}@example.fr`, password: pw,
    firstName: "Karine", lastName: "Lopez", companyName: `Industrie Cycle ${stamp}`, countryCode: "FR",
    termsAccepted: true, termsVersion: "1.0"
  });
  check("shipper créé", shipper.status === 201, shipper.body);
  const shipperCookie = extractCookie(shipper.headers);

  const shipperB = await call(register, "POST", {
    email: `cycle-shipper-b-${stamp}@example.fr`, password: pw,
    firstName: "Autre", lastName: "Client", companyName: `Autre Client ${stamp}`, countryCode: "FR",
    termsAccepted: true, termsVersion: "1.0"
  });
  const shipperBCookie = extractCookie(shipperB.headers);

  /* 3 transporteurs */
  const carrierCookies = [];
  const carrierCompanyIds = [];
  for (let i = 0; i < 3; i++) {
    const c = await call(carriers, "POST", {
      companyName: `Transporteur Cycle ${i} ${stamp}`, countryCode: "FR",
      email: `cycle-carrier${i}-${stamp}@example.fr`, password: pw,
      firstName: "Carl", lastName: `Carrier${i}`, modes: ["ROAD"],
      taxId: `FR-812 449 3${i}0`, vatNumber: `FR4281244930${i}`,
      termsAccepted: true, termsVersion: "1.0"
    });
    check(`transporteur ${i} inscrit (201, PENDING)`, c.status === 201 && c.body.verification.status === "PENDING", c.body);
    carrierCookies.push(extractCookie(c.headers));
    carrierCompanyIds.push(c.body.company.company_id);
  }

  /* Admin plateforme : directement en base (bootstrap) */
  const { query } = require("../api/_lib/db");
  const { hashPassword } = require("../api/_lib/auth");
  const adminEmail = `cycle-admin-${stamp}@example.fr`;
  const adminHash = await hashPassword(pw);
  const adminCo = await query(
    `INSERT INTO companies (legal_name, status) VALUES ('Transia Platform Cycle', 'ACTIVE') RETURNING company_id`
  );
  const adminUser = await query(
    `INSERT INTO users (company_id, first_name, last_name, email, password_hash, role, status)
     VALUES ($1,'Admin','Cycle',$2,$3,'SUPER_ADMIN','ACTIVE') RETURNING user_id`,
    [adminCo.rows[0].company_id, adminEmail, adminHash]
  );
  const adminLogin = await call(login, "POST", { email: adminEmail, password: pw });
  check("admin connecté", adminLogin.status === 200, adminLogin.body);
  const adminCookie = extractCookie(adminLogin.headers);

  /* ---------- Marketplace : gate de vérification ---------- */
  console.log("\n[2] Marketplace : transporteur non vérifié bloqué");
  const gated = await call(marketplace, "GET", null, { cookie: carrierCookies[0] });
  check("non vérifié → 403 CARRIER_NOT_VERIFIED", gated.status === 403 && gated.body.code === "CARRIER_NOT_VERIFIED", gated.body);
  const gatedQuotes = await call(quotes, "POST", { rfqNumber: "RFQ-X", baseTransportPrice: 100, currency: "EUR" }, { cookie: carrierCookies[0] });
  check("dépôt d'offre bloqué aussi", gatedQuotes.status === 403, gatedQuotes.body);

  /* ---------- Vérification admin ---------- */
  console.log("\n[3] Back-office : vérification des transporteurs");
  const carriersView = await call(admin, "GET", null, { cookie: adminCookie, ...{} });
  /* GET admin utilise req.query — simulé via handler sans query : view=overview par défaut */
  check("admin overview 200", carriersView.status === 200 && typeof carriersView.body.rfqs === "object", carriersView.body);

  for (let i = 0; i < 3; i++) {
    const v = await call(admin, "POST", { action: "verify", companyId: carrierCompanyIds[i], decision: "VERIFIED" }, { cookie: adminCookie });
    check(`transporteur ${i} vérifié`, v.status === 200 && v.body.validation_status === "VERIFIED" && v.body.company_status === "ACTIVE", v.body);
  }
  /* Motif exigé pour une suspension */
  const noMotif = await call(admin, "POST", { action: "verify", companyId: carrierCompanyIds[2], decision: "SUSPENDED" }, { cookie: adminCookie });
  check("suspension sans motif → 400", noMotif.status === 400 && noMotif.body.code === "REASON_REQUIRED", noMotif.body);
  const badDecision = await call(admin, "POST", { action: "verify", companyId: carrierCompanyIds[2], decision: "TUTUTU" }, { cookie: adminCookie });
  check("décision invalide → 400", badDecision.status === 400, badDecision.body);
  /* Le shipper ne peut pas valider */
  const notAdmin = await call(admin, "POST", { action: "verify", companyId: carrierCompanyIds[0], decision: "SUSPENDED", reason: "test" }, { cookie: shipperCookie });
  check("shipper → 403 sur back-office", notAdmin.status === 403, notAdmin.body);

  /* ---------- RFQ ---------- */
  console.log("\n[4] RFQ du donneur d'ordre");
  const rfqRes = await call(rfqs, "POST", {
    originCity: "Lyon", originCountry: "FR", originPostalCode: "69007",
    originPrivateAddress: "12 rue de la République, 69007 Lyon",
    destinationCity: "Casablanca", destinationCountry: "MA", destinationPostalCode: "20000",
    destinationPrivateAddress: "Zone franche Aïn Sebaâ",
    mode: "ROAD", incoterm: "DAP", pickupDate: "2026-12-01",
    cargoDescription: "Pièces détachées automobiles", palletCount: 12, grossWeight: 4800, volume: 26
  }, { cookie: shipperCookie });
  check("RFQ créée", rfqRes.status === 201, rfqRes.body);
  const rfqNum = rfqRes.body.rfq.rfq_number;

  /* ---------- Marketplace : aveuglement ---------- */
  console.log("\n[5] Marketplace : vue transporteur (aveugle)");
  const market = await call(marketplace, "GET", null, { cookie: carrierCookies[0] });
  check("marketplace 200", market.status === 200, market.body);
  const listed = (market.body.rfqs || []).find((r) => r.rfq_number === rfqNum);
  check("RFQ présente", !!listed, market.body.count);
  const marketStr = JSON.stringify(market.body);
  check("aucune adresse privée exposée", !marketStr.includes("République") && !marketStr.includes("Aïn Sebaâ"));
  check("aucun nom de donneur d'ordre", !marketStr.includes(`Industrie Cycle ${stamp}`));
  check("aucun e-mail de donneur d'ordre", !marketStr.includes("cycle-shipper"));

  const detail = await call(marketplace, "GET", { rfq: rfqNum }, { cookie: carrierCookies[0] });
  check("détail RFQ 200", detail.status === 200 && detail.body.rfq && detail.body.rfq.rfq_number === rfqNum, detail.body);
  check("détail : adresse publique seulement", JSON.stringify(detail.body).includes("Lyon") && !JSON.stringify(detail.body).includes("République"), detail.body);

  /* Shipper ne voit PAS la marketplace */
  const shipperMarket = await call(marketplace, "GET", null, { cookie: shipperCookie });
  check("shipper → 403 marketplace", shipperMarket.status === 403, shipperMarket.body);

  /* ---------- Offres ---------- */
  console.log("\n[6] Dépôt des 3 offres (dont cas limites)");
  const qA = await call(quotes, "POST", {
    rfqNumber: rfqNum, currency: "EUR", baseTransportPrice: 2350, mandatoryFeesTotal: 0,
    transitTimeValue: 5, transitTimeUnit: "day", validUntil: "2026-12-20",
    conditions: "Port payé. TVA incluse."
  }, { cookie: carrierCookies[0] });
  check("offre A déposée (CONFORME)", qA.status === 201 && qA.body.quote.compliance_status === "CONFORME", qA.body);

  const qB = await call(quotes, "POST", {
    rfqNumber: rfqNum, currency: "EUR", baseTransportPrice: 2180, feesToSpecify: true,
    transitTimeValue: 6, transitTimeUnit: "day", validUntil: "2026-12-18",
    conditions: "Franco départ. Frais de manutention à préciser."
  }, { cookie: carrierCookies[1] });
  check("offre B déposée (A_VERIFIER, frais à préciser)", qB.status === 201 && qB.body.quote.compliance_status === "A_VERIFIER", qB.body);

  const qC = await call(quotes, "POST", {
    rfqNumber: rfqNum, currency: "USD", baseTransportPrice: 2500, mandatoryFeesTotal: 140,
    transitTimeValue: 4, transitTimeUnit: "day", validUntil: "2026-12-22",
    conditions: "Port payé. Frais de dossier 140 USD."
  }, { cookie: carrierCookies[2] });
  check("offre C déposée (USD, frais obligatoires)", qC.status === 201 && qC.body.quote.compliance_status === "CONFORME", qC.body);

  /* Versionning : re-dépôt d'une offre crée la version 2 */
  const qA2 = await call(quotes, "POST", {
    rfqNumber: rfqNum, currency: "EUR", baseTransportPrice: 2290,
    transitTimeValue: 5, transitTimeUnit: "day", validUntil: "2026-12-20",
    conditions: "Port payé. Révisé."
  }, { cookie: carrierCookies[0] });
  check("re-dépôt → version 2 (historique non écrasé)", qA2.status === 201 && qA2.body.quote.version === 2, qA2.body);

  /* ---------- Aveuglement des offres ---------- */
  console.log("\n[7] Aveuglement des offres");
  const carrierView = await call(quotes, "GET", { rfq: rfqNum }, { cookie: carrierCookies[1] });
  check("transporteur B ne voit QUE sa propre offre", carrierView.status === 200 && carrierView.body.count === 1, carrierView.body);
  check("pas de classement pour le transporteur", carrierView.body.ranking === undefined, carrierView.body.ranking);

  const shipperView = await call(quotes, "GET", { rfq: rfqNum }, { cookie: shipperCookie });
  check("shipper voit 3 offres (dernières versions)", shipperView.status === 200 && shipperView.body.count === 3, shipperView.body);
  const shipperStr = JSON.stringify(shipperView.body);
  check("aucune identité transporteur côté shipper", !shipperStr.includes("cycle-carrier") && !shipperStr.includes("Transporteur Cycle"), shipperStr.slice(0, 300));
  check("lettres anonymes présentes", shipperView.body.quotes.every((q) => /^[A-C]$/.test(q.letter)), shipperView.body.quotes.map((q) => q.letter));

  const otherShipper = await call(quotes, "GET", { rfq: rfqNum }, { cookie: shipperBCookie });
  check("autre shipper → 403", otherShipper.status === 403, otherShipper.body);

  /* ---------- Classement ---------- */
  console.log("\n[8] Classement + recommandation");
  /* Le client ne voit rien tant que l'admin n'a pas validé */
  const pending = await call(recommendations, "GET", { rfq: rfqNum }, { cookie: shipperCookie });
  check("shipper avant validation → PENDING_ADMIN", pending.status === 200 && pending.body.status === "PENDING_ADMIN", pending.body);

  const rank = await call(recommendations, "POST", { rfqNumber: rfqNum }, { cookie: adminCookie });
  check("classement calculé", rank.status === 200, rank.body);
  check("sans Drex → relecture humaine, rien n'est validé", rank.body.status === "PENDING_ADMIN", rank.body);
  check("3 conformes? non : 2 conformes + 1 à vérifier", rank.body.stats.conforme === 2 && rank.body.stats.aVerifier === 1, rank.body.stats);
  /* Normalisation : offre C (USD 2500 + 140 USD de frais) ≈ 2434 EUR
     vs offre A v2 (2290 EUR) → A v2 doit être n°1 */
  check("n°1 = offre A v2 (2290 EUR, moins cher converti)",
    rank.body.recommended && rank.body.recommended.comparable_total === 2290, rank.body.recommended);
  check("commissionnable = transport seul", rank.body.recommended.commissionable_amount === 2290, rank.body.recommended);

  /* Toujours rien côté client : la relecture n'a pas encore eu lieu */
  const stillPending = await call(recommendations, "GET", { rfq: rfqNum }, { cookie: shipperCookie });
  check("shipper : toujours PENDING_ADMIN avant relecture",
    stillPending.status === 200 && stillPending.body.status === "PENDING_ADMIN", stillPending.body);

  /* Relecture humaine : l'opérateur valide explicitement la proposition */
  const approve = await call(recommendations, "POST", { rfqNumber: rfqNum, approve: true }, { cookie: adminCookie });
  check("validation explicite → VALIDATED", approve.status === 200 && approve.body.status === "VALIDATED", approve.body);

  /* Après validation, le client voit le classement */
  const validated = await call(recommendations, "GET", { rfq: rfqNum }, { cookie: shipperCookie });
  check("shipper voit la recommandation validée", validated.status === 200 && validated.body.validated === true && validated.body.recommended, validated.body);

  /* Écart motivé : retenir l'offre C au lieu de A (motif obligatoire) */
  const overrideNoReason = await call(recommendations, "POST", {
    rfqNumber: rfqNum, overrideQuoteId: qC.body.quote.quote_id, overrideReason: ""
  }, { cookie: adminCookie });
  check("override sans motif → 400", overrideNoReason.status === 400 && overrideNoReason.body.code === "OVERRIDE_REASON_REQUIRED", overrideNoReason.body);

  const overrideBadTarget = await call(recommendations, "POST", {
    rfqNumber: rfqNum, overrideQuoteId: qB.body.quote.quote_id, overrideReason: "Test refusé : non conforme"
  }, { cookie: adminCookie });
  check("override vers offre NON conforme → 400", overrideBadTarget.status === 400 && overrideBadTarget.body.code === "INVALID_OVERRIDE", overrideBadTarget.body);

  /* Retour à la proposition du moteur pour la suite */
  const rankAgain = await call(recommendations, "POST", { rfqNumber: rfqNum }, { cookie: adminCookie });
  check("recalcul après validation → PENDING_ADMIN",
    rankAgain.status === 200 && rankAgain.body.status === "PENDING_ADMIN", rankAgain.body);
  const reApprove = await call(recommendations, "POST", { rfqNumber: rfqNum, approve: true }, { cookie: adminCookie });
  check("revalidation du n°1 moteur", reApprove.status === 200 && reApprove.body.status === "VALIDATED", reApprove.body);
  check("validation : montant relu conservé (2290 EUR)",
    reApprove.body.recommended && reApprove.body.recommended.comparable_total === 2290, reApprove.body.recommended);

  /* Le recalcul a remplacé le classement : une seule ligne par offre,
     y compris pour l'offre validée lors du calcul précédent. */
  const rankingRows = await query(
    `SELECT count(*)::int AS total, count(DISTINCT quote_id)::int AS offres
       FROM quote_rankings
      WHERE rfq_id = (SELECT rfq_id FROM rfqs WHERE rfq_number = $1)`,
    [rfqNum]
  );
  check("classement persisté sans doublon après recalcul",
    rankingRows.rows[0].total === rankingRows.rows[0].offres, rankingRows.rows[0]);
  const recoView = await call(recommendations, "GET", { rfq: rfqNum }, { cookie: adminCookie });
  const recoLetters = (recoView.body.rankings || []).map((r) => r.letter);
  check("GET classement : une ligne par offre",
    recoLetters.length === new Set(recoLetters).size, recoLetters);

  /* Une recommandation déjà validée ne peut pas être revalidée */
  const approveAgain = await call(recommendations, "POST", { rfqNumber: rfqNum, approve: true }, { cookie: adminCookie });
  check("aucune recommandation en attente → 409",
    approveAgain.status === 409 && approveAgain.body.code === "NO_PENDING_RECOMMENDATION", approveAgain.body);

  /* ---------- Validation d'une relecture devenue obsolète ----------
     Sur une RFQ encore ouverte, une nouvelle version d'offre arrive
     entre le calcul et la validation : la validation est refusée et
     rien n'est présenté au client. */
  console.log("\n[8bis] Validation refusée si le classement a changé");
  const staleRfq = await call(rfqs, "POST", {
    originCity: "Lille", originCountry: "FR", destinationCity: "Tunis", destinationCountry: "TN",
    mode: "ROAD", cargoDescription: "Charge relecture obsolète", palletCount: 2
  }, { cookie: shipperCookie });
  check("RFQ dédiée créée", staleRfq.status === 201, staleRfq.body);
  const staleNum = staleRfq.body.rfq.rfq_number;

  const sA = await call(quotes, "POST", {
    rfqNumber: staleNum, currency: "EUR", baseTransportPrice: 1800,
    transitTimeValue: 4, transitTimeUnit: "day", validUntil: "2026-12-20"
  }, { cookie: carrierCookies[0] });
  const sB = await call(quotes, "POST", {
    rfqNumber: staleNum, currency: "EUR", baseTransportPrice: 1900,
    transitTimeValue: 5, transitTimeUnit: "day", validUntil: "2026-12-20"
  }, { cookie: carrierCookies[1] });
  check("deux offres déposées", sA.status === 201 && sB.status === 201, [sA.body, sB.body]);

  const sRank = await call(recommendations, "POST", { rfqNumber: staleNum }, { cookie: adminCookie });
  check("classement en relecture", sRank.status === 200 && sRank.body.status === "PENDING_ADMIN", sRank.body);
  check("n°1 = 1800 EUR", sRank.body.recommended && sRank.body.recommended.comparable_total === 1800, sRank.body.recommended);

  const sB2 = await call(quotes, "POST", {
    rfqNumber: staleNum, currency: "EUR", baseTransportPrice: 1700,
    transitTimeValue: 5, transitTimeUnit: "day", validUntil: "2026-12-20"
  }, { cookie: carrierCookies[1] });
  check("nouvelle version d'offre déposée", sB2.status === 201, sB2.body);

  const sStale = await call(recommendations, "POST", { rfqNumber: staleNum, approve: true }, { cookie: adminCookie });
  check("classement modifié depuis la relecture → 409 RANKING_CHANGED",
    sStale.status === 409 && sStale.body.code === "RANKING_CHANGED", sStale.body);
  const sStaleOverride = await call(recommendations, "POST", {
    rfqNumber: staleNum, approve: true,
    overrideQuoteId: sA.body.quote.quote_id, overrideReason: "Écart sur un classement obsolète"
  }, { cookie: adminCookie });
  check("écart motivé sur un classement obsolète → 409 RANKING_CHANGED",
    sStaleOverride.status === 409 && sStaleOverride.body.code === "RANKING_CHANGED", sStaleOverride.body);
  const sShipper = await call(recommendations, "GET", { rfq: staleNum }, { cookie: shipperCookie });
  check("validation refusée : le client ne voit rien",
    sShipper.status === 200 && sShipper.body.status === "PENDING_ADMIN", sShipper.body);

  const sRecalc = await call(recommendations, "POST", { rfqNumber: staleNum }, { cookie: adminCookie });
  check("recalcul → PENDING_ADMIN sur le nouveau classement",
    sRecalc.status === 200 && sRecalc.body.status === "PENDING_ADMIN", sRecalc.body);
  check("nouveau n°1 = 1700 EUR", sRecalc.body.recommended && sRecalc.body.recommended.comparable_total === 1700, sRecalc.body.recommended);
  const sApprove = await call(recommendations, "POST", { rfqNumber: staleNum, approve: true }, { cookie: adminCookie });
  check("validation de la relecture à jour → VALIDATED",
    sApprove.status === 200 && sApprove.body.status === "VALIDATED", sApprove.body);

  /* Shipper ne peut pas valider */
  const shipperRank = await call(recommendations, "POST", { rfqNumber: rfqNum }, { cookie: shipperCookie });
  check("shipper → 403 validation", shipperRank.status === 403, shipperRank.body);

  /* ---------- Écart motivé à la validation ----------
     L'opérateur retient une autre offre du classement relu : le motif
     est obligatoire, l'offre doit figurer dans ce classement, et la
     validation ne recalcule rien. */
  console.log("\n[8ter] Écart motivé à la validation");
  const altRfq = await call(rfqs, "POST", {
    originCity: "Nantes", originCountry: "FR", destinationCity: "Alger", destinationCountry: "DZ",
    mode: "ROAD", cargoDescription: "Charge écart motivé", palletCount: 3
  }, { cookie: shipperCookie });
  check("RFQ d'écart motivé créée", altRfq.status === 201, altRfq.body);
  const altNum = altRfq.body.rfq.rfq_number;

  const altA = await call(quotes, "POST", {
    rfqNumber: altNum, currency: "EUR", baseTransportPrice: 2000,
    transitTimeValue: 6, transitTimeUnit: "day", validUntil: "2026-12-20",
    conditions: "Port payé."
  }, { cookie: carrierCookies[0] });
  const altB = await call(quotes, "POST", {
    rfqNumber: altNum, currency: "EUR", baseTransportPrice: 2100,
    transitTimeValue: 3, transitTimeUnit: "day", validUntil: "2026-12-20",
    conditions: "Franco départ."
  }, { cookie: carrierCookies[1] });
  check("deux offres conformes déposées",
    altA.status === 201 && altA.body.quote.compliance_status === "CONFORME" &&
    altB.status === 201 && altB.body.quote.compliance_status === "CONFORME", [altA.body, altB.body]);

  const altRank = await call(recommendations, "POST", { rfqNumber: altNum }, { cookie: adminCookie });
  check("classement en relecture", altRank.status === 200 && altRank.body.status === "PENDING_ADMIN", altRank.body);
  check("n°1 = 2000 EUR", altRank.body.recommended && altRank.body.recommended.comparable_total === 2000, altRank.body.recommended);

  const altView = await call(recommendations, "GET", { rfq: altNum }, { cookie: adminCookie });
  const altRow = (altView.body.rankings || []).find((r) => r.quote_id === altB.body.quote.quote_id);
  check("le classement exposé porte l'identifiant de l'offre", !!altRow && altRow.rank === 2, altView.body.rankings);

  const overrideNoMotif = await call(recommendations, "POST", {
    rfqNumber: altNum, approve: true,
    overrideQuoteId: altB.body.quote.quote_id, overrideReason: "  "
  }, { cookie: adminCookie });
  check("écart sans motif → 400 OVERRIDE_REASON_REQUIRED",
    overrideNoMotif.status === 400 && overrideNoMotif.body.code === "OVERRIDE_REASON_REQUIRED", overrideNoMotif.body);

  const badAlt = await call(recommendations, "POST", {
    rfqNumber: altNum, approve: true,
    overrideQuoteId: "00000000-0000-0000-0000-000000000000",
    overrideReason: "Offre absente du classement relu"
  }, { cookie: adminCookie });
  check("offre hors classement → 400 INVALID_OVERRIDE",
    badAlt.status === 400 && badAlt.body.code === "INVALID_OVERRIDE", badAlt.body);

  const altStillPending = await call(recommendations, "GET", { rfq: altNum }, { cookie: adminCookie });
  check("refus d'écart : la relecture reste en attente",
    altStillPending.body.status === "PENDING_ADMIN" && altStillPending.body.validated === false, altStillPending.body);

  const override = await call(recommendations, "POST", {
    rfqNumber: altNum, approve: true,
    overrideQuoteId: altB.body.quote.quote_id,
    overrideReason: "Délai de 3 jours exigé par le client"
  }, { cookie: adminCookie });
  check("écart motivé → offre retenue validée",
    override.status === 200 && override.body.status === "VALIDATED" &&
    override.body.recommended.quote_id === altB.body.quote.quote_id &&
    override.body.recommended.rank === 2, override.body);
  check("écart : offre d'origine et motif renvoyés",
    override.body.override && override.body.override.from === altA.body.quote.quote_id &&
    override.body.override.reason === "Délai de 3 jours exigé par le client", override.body.override);

  const altAfter = await call(recommendations, "GET", { rfq: altNum }, { cookie: shipperCookie });
  const chosenRow = (altAfter.body.rankings || []).find((r) => r.quote_id === altB.body.quote.quote_id);
  check("shipper voit l'offre retenue validée, motif journalisé",
    altAfter.body.validated === true && !!chosenRow && chosenRow.admin_validated === true &&
    /Délai de 3 jours/.test(chosenRow.admin_reason || ""), altAfter.body);
  check("écart : seule l'offre retenue est validée",
    (altAfter.body.rankings || []).every((r) => r.quote_id === altB.body.quote.quote_id || r.admin_validated === false),
    altAfter.body.rankings);

  const altMail = await query(
    `SELECT count(*)::int AS n FROM outbox_emails
      WHERE event_type = 'recommendation_ready'
        AND entity_id = (SELECT rfq_id FROM rfqs WHERE rfq_number = $1)`,
    [altNum]
  );
  check("écart motivé : un seul e-mail recommendation_ready", altMail.rows[0].n === 1, altMail.rows[0]);

  /* Journal d'audit : l'écart doit laisser une trace unique portant
     l'offre proposée par le moteur, l'offre réellement retenue et le
     motif — c'est cette ligne qui sert de preuve en cas de litige. */
  const altAudit = await query(
    `SELECT old_value, new_value, reason FROM audit_log
      WHERE action_type = 'RECOMMENDATION_VALIDATED'
        AND entity_type = 'rfqs'
        AND entity_id = (SELECT rfq_id FROM rfqs WHERE rfq_number = $1)`,
    [altNum]
  );
  check("audit_log : une seule validation journalisée", altAudit.rows.length === 1, altAudit.rows.length);
  const trace = altAudit.rows[0] || {};
  check("audit_log : offre du moteur conservée en old_value",
    trace.old_value && trace.old_value.quote_id === altA.body.quote.quote_id, trace.old_value);
  check("audit_log : offre retenue et motif en new_value",
    trace.new_value && trace.new_value.chosen === altB.body.quote.quote_id &&
    trace.new_value.override === "Délai de 3 jours exigé par le client" &&
    trace.new_value.ranking === "relu", trace.new_value);
  check("audit_log : motif inscrit dans reason",
    trace.reason === "Écart motivé : Délai de 3 jours exigé par le client", trace.reason);

  /* ---------- Double confirmation ---------- */
  console.log("\n[9] Acceptation → confirmation → affaire");
  const wrongCarrier = await call(deals, "POST", { action: "confirm", acceptanceId: "00000000-0000-0000-0000-000000000000", rfqNumber: rfqNum }, { cookie: carrierCookies[1] });
  check("mauvaise acceptation → 404", wrongCarrier.status === 404, wrongCarrier.body);

  const accept = await call(deals, "POST", { action: "accept", rfqNumber: rfqNum, comment: "Offre retenue après analyse." }, { cookie: shipperCookie });
  check("acceptation → AWAITING_CARRIER", accept.status === 201 && accept.body.status === "AWAITING_CARRIER", accept.body);

  const acceptAgain = await call(deals, "POST", { action: "accept", rfqNumber: rfqNum }, { cookie: shipperCookie });
  check("double acceptation → 409", acceptAgain.status === 409 && acceptAgain.body.code === "ALREADY_ACCEPTED", acceptAgain.body);

  /* Seul le transporteur de l'offre pressentie peut confirmer */
  const accId = accept.body.acceptance_id;
  const notSelected = await call(deals, "POST", { action: "confirm", acceptanceId: accId, rfqNumber: rfqNum }, { cookie: carrierCookies[1] });
  check("mauvais transporteur → 403", notSelected.status === 403, notSelected.body);

  const confirm = await call(deals, "POST", { action: "confirm", acceptanceId: accId, rfqNumber: rfqNum }, { cookie: carrierCookies[0] });
  check("confirmation → affaire créée", confirm.status === 201 && confirm.body.status === "CONFIRMED", confirm.body);
  check("numéro d'affaire TR-AAAA-NNNNNN", /^TR-\d{4}-\d{6}$/.test(confirm.body.deal.deal_number || ""), confirm.body.deal);
  check("taux effectif figé (2290 → 7,75 %)", confirm.body.deal.commission_rate === 0.0775, confirm.body.deal);
  check("commission = barème dégressif (2290 → 177,40)", confirm.body.deal.commission_amount === 177.4, confirm.body.deal);

  const confirmAgain = await call(deals, "POST", { action: "confirm", acceptanceId: accId, rfqNumber: rfqNum }, { cookie: carrierCookies[0] });
  check("double confirmation → 409", confirmAgain.status === 409 && confirmAgain.body.code === "INVALID_STATE", confirmAgain.body);

  /* ---------- Journal des affaires ---------- */
  console.log("\n[10] Journal des affaires + RBAC");
  const dealsShipper = await call(deals, "GET", null, { cookie: shipperCookie });
  check("shipper voit son affaire", dealsShipper.status === 200 && dealsShipper.body.count >= 1, dealsShipper.body);
  check("stats commission présentes", parseFloat(dealsShipper.body.stats.commission) > 0, dealsShipper.body.stats);

  const dealsCarrier = await call(deals, "GET", null, { cookie: carrierCookies[1] });
  const ownDeal = (dealsCarrier.body.deals || []).find((d) => d.deal_number === confirm.body.deal.deal_number);
  check("transporteur B ne voit PAS l'affaire du transporteur A", !ownDeal, dealsCarrier.body);

  const dealsOther = await call(deals, "GET", null, { cookie: shipperBCookie });
  check("autre shipper : 0 affaire", dealsOther.status === 200 && dealsOther.body.count === 0, dealsOther.body);

  const dealsAdmin = await call(deals, "GET", null, { cookie: adminCookie });
  check("admin voit toutes les affaires", dealsAdmin.status === 200 && dealsAdmin.body.count >= 1, dealsAdmin.body);

  /* Après confirmation, identités révélées au shipper */
  const revealed = await call(quotes, "GET", { rfq: rfqNum }, { cookie: shipperCookie });
  check("RFQ confirmée → identités révélées", revealed.body.quotes.some((q) => !!q.carrier_company_id), revealed.body.quotes[0]);

  /* ---------- Refus motivé ---------- */
  console.log("\n[11] Refus motivé sur une 2e RFQ");
  const rfq2 = await call(rfqs, "POST", {
    originCity: "Paris", originCountry: "FR", destinationCity: "Dubaï", destinationCountry: "AE",
    mode: "AIR", cargoDescription: "Échantillons", packageCount: 6, grossWeight: 450
  }, { cookie: shipperCookie });
  const rfq2Num = rfq2.body.rfq.rfq_number;

  const noMotifRefus = await call(deals, "POST", { action: "refuse", rfqNumber: rfq2Num }, { cookie: shipperCookie });
  check("refus sans motif → 400", noMotifRefus.status === 400 && noMotifRefus.body.code === "MISSING_MOTIF", noMotifRefus.body);

  const refuse = await call(deals, "POST", { action: "refuse", rfqNumber: rfq2Num, motif: "Prix trop élevé", closeRfq: true }, { cookie: shipperCookie });
  check("refus enregistré + clôture", refuse.status === 200 && refuse.body.status === "REFUSED_CLOSED", refuse.body);

  /* RFQ clôtée : plus d'offres acceptées */
  const quoteOnClosed = await call(quotes, "POST", { rfqNumber: rfq2Num, currency: "EUR", baseTransportPrice: 100 }, { cookie: carrierCookies[0] });
  check("offre sur RFQ clôturée → 409", quoteOnClosed.status === 409 && quoteOnClosed.body.code === "RFQ_CLOSED", quoteOnClosed.body);

  console.log("\n----------------------------------------");
  console.log(`Résultat : ${pass} succès, ${failCount} échec(s)`);
  process.exit(failCount === 0 ? 0 : 1);
})().catch((e) => { console.error("ERREUR FATALE:", e); process.exit(1); });
