/* ============================================================
   Transia — test/isolation-check.js
   Isolation multi-tenant : chaque endpoint qui lit ou modifie une
   ressource par référence (RFQ, offre, acceptation, affaire) doit
   refuser l'accès à une entreprise qui n'y a pas droit.

   Deux donneurs d'ordre, deux transporteurs et un administrateur
   plateforme sont créés ; chaque entreprise possède sa RFQ et son
   offre, puis chaque acteur tente d'atteindre les ressources de
   l'autre.

   Usage : DATABASE_URL=... node test/isolation-check.js
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
const { query } = require("../api/_lib/db");
const { hashPassword } = require("../api/_lib/auth");

(async () => {
  const stamp = Date.now();
  const pw = "motdepasse-test-2026";
  const terms = { termsAccepted: true, termsVersion: "1.0" };

  /* ---------- Acteurs ---------- */
  console.log("\n[1] Acteurs : 2 donneurs d'ordre, 2 transporteurs, 1 admin");

  const shipperA = await call(register, "POST", {
    email: `iso-a-${stamp}@example.fr`, password: pw, firstName: "Alice", lastName: "A",
    companyName: `Iso Shippeur A ${stamp}`, countryCode: "FR", ...terms
  });
  const shipperB = await call(register, "POST", {
    email: `iso-b-${stamp}@example.fr`, password: pw, firstName: "Bruno", lastName: "B",
    companyName: `Iso Shippeur B ${stamp}`, countryCode: "BE", ...terms
  });
  check("shipper A créé", shipperA.status === 201, shipperA.body);
  check("shipper B créé", shipperB.status === 201, shipperB.body);
  const cookieA = extractCookie(shipperA.headers);
  const cookieB = extractCookie(shipperB.headers);
  check("entreprises distinctes", shipperA.body.company.company_id !== shipperB.body.company.company_id);

  const carrierCookies = [];
  const carrierIds = [];
  for (const i of [1, 2]) {
    const c = await call(carriers, "POST", {
      companyName: `Iso Transporteur ${i} ${stamp}`, countryCode: "FR",
      email: `iso-carrier${i}-${stamp}@example.fr`, password: pw,
      firstName: "Carl", lastName: `C${i}`, modes: ["ROAD"], ...terms
    });
    check(`transporteur ${i} inscrit`, c.status === 201 && c.body.verification.status === "PENDING", c.body);
    carrierCookies.push(extractCookie(c.headers));
    carrierIds.push(c.body.company.company_id);
  }

  const adminCo = await query(
    `INSERT INTO companies (legal_name, status) VALUES ($1,'ACTIVE') RETURNING company_id`,
    [`Iso Platform ${stamp}`]
  );
  await query(
    `INSERT INTO users (company_id, first_name, last_name, email, password_hash, role, status)
     VALUES ($1,'Admin','Iso',$2,$3,'SUPER_ADMIN','ACTIVE')`,
    [adminCo.rows[0].company_id, `iso-admin-${stamp}@example.fr`, await hashPassword(pw)]
  );
  const adminLogin = await call(login, "POST", { email: `iso-admin-${stamp}@example.fr`, password: pw });
  const adminCookie = extractCookie(adminLogin.headers);
  check("admin connecté", adminLogin.status === 200 && !!adminCookie, adminLogin.body);

  for (let i = 0; i < 2; i++) {
    const v = await call(admin, "POST", { action: "verify", companyId: carrierIds[i], decision: "VERIFIED" }, { cookie: adminCookie });
    check(`transporteur ${i + 1} vérifié`, v.status === 200 && v.body.validation_status === "VERIFIED", v.body);
  }

  /* ---------- Une ressource par entreprise ---------- */
  console.log("\n[2] Chaque entreprise possède sa RFQ et son offre");

  const rfqA = await call(rfqs, "POST", {
    originCity: "Lyon", originCountry: "FR", originPrivateAddress: "1 rue Privée A",
    destinationCity: "Casablanca", destinationCountry: "MA", destinationPrivateAddress: "Zone Privée A",
    mode: "ROAD", cargoDescription: "Lot A", palletCount: 4
  }, { cookie: cookieA });
  const rfqB = await call(rfqs, "POST", {
    originCity: "Lille", originCountry: "FR", originPrivateAddress: "2 rue Privée B",
    destinationCity: "Tanger", destinationCountry: "MA", destinationPrivateAddress: "Zone Privée B",
    mode: "SEA", cargoDescription: "Lot B", palletCount: 6
  }, { cookie: cookieB });
  check("RFQ A créée", rfqA.status === 201, rfqA.body);
  check("RFQ B créée", rfqB.status === 201, rfqB.body);
  const numA = rfqA.body.rfq.rfq_number;
  const numB = rfqB.body.rfq.rfq_number;

  const quoteA = await call(quotes, "POST", {
    rfqNumber: numA, currency: "EUR", baseTransportPrice: 2100, transitTimeValue: 5
  }, { cookie: carrierCookies[0] });
  const quoteB = await call(quotes, "POST", {
    rfqNumber: numB, currency: "EUR", baseTransportPrice: 3200, transitTimeValue: 7
  }, { cookie: carrierCookies[1] });
  check("offre C1 sur RFQ A", quoteA.status === 201, quoteA.body);
  check("offre C2 sur RFQ B", quoteB.status === 201, quoteB.body);
  const quoteAId = quoteA.body.quote.quote_id;

  /* ---------- Lectures croisées ---------- */
  console.log("\n[3] Lectures : chaque entreprise ne voit que son périmètre");

  const listA = await call(rfqs, "GET", null, { cookie: cookieA });
  const listB = await call(rfqs, "GET", null, { cookie: cookieB });
  check("A ne voit que sa RFQ", listA.status === 200 && listA.body.rfqs.every((r) => r.rfq_number === numA), listA.body);
  check("B ne voit que sa RFQ", listB.status === 200 && listB.body.rfqs.every((r) => r.rfq_number === numB), listB.body);

  const bOnA = await call(quotes, "GET", { rfq: numA }, { cookie: cookieB });
  check("B → offres de A : 403", bOnA.status === 403 && bOnA.body.code === "FORBIDDEN", bOnA.body);
  const aOnB = await call(quotes, "GET", { rfq: numB }, { cookie: cookieA });
  check("A → offres de B : 403", aOnB.status === 403 && aOnB.body.code === "FORBIDDEN", aOnB.body);

  const bReco = await call(recommendations, "GET", { rfq: numA }, { cookie: cookieB });
  check("B → classement de A : 403", bReco.status === 403, bReco.body);
  const c1Reco = await call(recommendations, "GET", { rfq: numA }, { cookie: carrierCookies[0] });
  check("transporteur → classement : 403", c1Reco.status === 403, c1Reco.body);

  const c2OnA = await call(quotes, "GET", { rfq: numA }, { cookie: carrierCookies[1] });
  check("C2 sur RFQ A : 200 mais aucune offre d'autrui", c2OnA.status === 200 && c2OnA.body.count === 0, c2OnA.body);
  const c1OnB = await call(quotes, "GET", { rfq: numB }, { cookie: carrierCookies[0] });
  check("C1 sur RFQ B : aucune offre d'autrui", c1OnB.status === 200 && c1OnB.body.count === 0, c1OnB.body);

  const bDeals = await call(deals, "GET", null, { cookie: cookieB });
  check("B → journal d'affaires vide", bDeals.status === 200 && bDeals.body.count === 0, bDeals.body);

  /* ---------- Mutations croisées ---------- */
  console.log("\n[4] Mutations : refus des actions sur la ressource d'autrui");

  const bAccept = await call(deals, "POST", { action: "accept", rfqNumber: numA }, { cookie: cookieB });
  check("B ne peut pas accepter sur RFQ A", bAccept.status === 403, bAccept.body);
  const bAcceptQuote = await call(deals, "POST", { action: "accept", rfqNumber: numA, quoteId: quoteAId }, { cookie: cookieB });
  check("B ne peut pas accepter l'offre de C1", bAcceptQuote.status === 403, bAcceptQuote.body);
  const bRefuseA = await call(deals, "POST", { action: "refuse", rfqNumber: numA, motif: "test" }, { cookie: cookieB });
  check("B ne peut pas refuser sur RFQ A", bRefuseA.status === 403, bRefuseA.body);
  const aRefuseB = await call(deals, "POST", { action: "refuse", rfqNumber: numB, motif: "test" }, { cookie: cookieA });
  check("A ne peut pas refuser sur RFQ B", aRefuseB.status === 403, aRefuseB.body);

  /* Référence croisée : l'offre citée doit appartenir à la demande. */
  const crossQuote = await call(deals, "POST", {
    action: "refuse", rfqNumber: numB, quoteId: quoteAId, motif: "offre d'une autre demande"
  }, { cookie: cookieB });
  check("refus avec une offre d'une autre RFQ → 404", crossQuote.status === 404, crossQuote.body);
  const foreignRefusal = await query(
    `SELECT count(*)::int AS n FROM rfq_refusals WHERE quote_id = $1`, [quoteAId]
  );
  check("aucune trace de l'offre étrangère en base", foreignRefusal.rows[0].n === 0, foreignRefusal.rows[0]);

  /* ---------- Identifiants malformés ---------- */
  console.log("\n[4bis] Identifiants malformés : 400, jamais 500");

  const badRefuse = await call(deals, "POST", {
    action: "refuse", rfqNumber: numB, quoteId: "pas-un-uuid", motif: "test"
  }, { cookie: cookieB });
  check("quoteId malformé (refus) → 400", badRefuse.status === 400 && badRefuse.body.code === "INVALID_QUOTE_ID", badRefuse.body);

  const badAccept = await call(deals, "POST", {
    action: "accept", rfqNumber: numA, quoteId: "123"
  }, { cookie: cookieA });
  check("quoteId malformé (acceptation) → 400", badAccept.status === 400 && badAccept.body.code === "INVALID_QUOTE_ID", badAccept.body);

  const badConfirm = await call(deals, "POST", {
    action: "confirm", rfqNumber: numA, acceptanceId: "pas-un-uuid"
  }, { cookie: carrierCookies[0] });
  check("acceptanceId malformé → 400", badConfirm.status === 400 && badConfirm.body.code === "INVALID_ACCEPTANCE_ID", badConfirm.body);

  const unknownConfirm = await call(deals, "POST", {
    action: "confirm", rfqNumber: numA, acceptanceId: "00000000-0000-0000-0000-000000000000"
  }, { cookie: carrierCookies[0] });
  check("acceptanceId bien formé mais inconnu → 404", unknownConfirm.status === 404, unknownConfirm.body);

  const missingConfirm = await call(deals, "POST", { action: "confirm", rfqNumber: numA }, { cookie: carrierCookies[0] });
  check("acceptanceId absent → 400", missingConfirm.status === 400 && missingConfirm.body.code === "MISSING_ACCEPTANCE", missingConfirm.body);

  const badCompany = await call(admin, "POST", {
    action: "verify", companyId: "pas-un-uuid", decision: "VERIFIED"
  }, { cookie: adminCookie });
  check("companyId malformé → 400", badCompany.status === 400 && badCompany.body.code === "INVALID_COMPANY_ID", badCompany.body);

  const unknownCompany = await call(admin, "POST", {
    action: "verify", companyId: "00000000-0000-0000-0000-000000000000", decision: "VERIFIED"
  }, { cookie: adminCookie });
  check("companyId bien formé mais inconnu → 404", unknownCompany.status === 404, unknownCompany.body);

  const noCompany = await call(admin, "POST", { action: "verify", decision: "VERIFIED" }, { cookie: adminCookie });
  check("companyId absent → 400", noCompany.status === 400 && noCompany.body.code === "MISSING_COMPANY", noCompany.body);

  const badOverride = await call(recommendations, "POST", {
    rfqNumber: numA, overrideQuoteId: "pas-un-uuid"
  }, { cookie: adminCookie });
  check("overrideQuoteId malformé → 400, jamais 500", badOverride.status === 400 && badOverride.body.code === "INVALID_OVERRIDE", badOverride.body);

  /* ---------- Affaire : confidentialité financière ---------- */
  console.log("\n[5] Après confirmation : commission invisible aux tiers");

  const rank = await call(recommendations, "POST", { rfqNumber: numA }, { cookie: adminCookie });
  check("classement de RFQ A calculé", rank.status === 200, rank.body);
  const accept = await call(deals, "POST", { action: "accept", rfqNumber: numA }, { cookie: cookieA });
  check("A accepte l'offre de C1", accept.status === 201, accept.body);
  const confirm = await call(deals, "POST", {
    action: "confirm", rfqNumber: numA, acceptanceId: accept.body.acceptance_id
  }, { cookie: carrierCookies[0] });
  check("C1 confirme → affaire créée", confirm.status === 201 && /^TR-\d{4}-\d{6}$/.test(confirm.body.deal.deal_number), confirm.body);

  const c1View = await call(quotes, "GET", { rfq: numA }, { cookie: carrierCookies[0] });
  check("C1 (partie) voit l'affaire", c1View.body.deal && c1View.body.deal.deal_number === confirm.body.deal.deal_number, c1View.body.deal);
  const c2View = await call(quotes, "GET", { rfq: numA }, { cookie: carrierCookies[1] });
  check("C2 (tiers) ne voit aucune affaire", c2View.status === 200 && c2View.body.deal === null, c2View.body);
  check("C2 ne voit ni commission ni montant d'affaire", !/commission|transport_amount/.test(JSON.stringify(c2View.body)), c2View.body);
  const bView = await call(quotes, "GET", { rfq: numA }, { cookie: cookieB });
  check("B n'obtient pas l'affaire de A", bView.status === 403, bView.body);

  const c2Deals = await call(deals, "GET", null, { cookie: carrierCookies[1] });
  check("C2 → journal d'affaires vide", c2Deals.status === 200 && c2Deals.body.count === 0, c2Deals.body);
  const aDeals = await call(deals, "GET", null, { cookie: cookieA });
  check("A voit son affaire", aDeals.status === 200 && aDeals.body.count === 1, aDeals.body);

  /* ---------- Back-office et marketplace ---------- */
  console.log("\n[6] Back-office et marketplace : rôles et périmètres");

  const aAdminGet = await call(admin, "GET", null, { cookie: cookieA });
  check("donneur d'ordre → back-office 403", aAdminGet.status === 403, aAdminGet.body);
  const cAdminPost = await call(admin, "POST", { action: "verify", companyId: carrierIds[1], decision: "SUSPENDED", reason: "test" }, { cookie: carrierCookies[1] });
  check("transporteur → décision back-office 403", cAdminPost.status === 403, cAdminPost.body);
  const aMarket = await call(marketplace, "GET", null, { cookie: cookieA });
  check("donneur d'ordre → marketplace 403", aMarket.status === 403, aMarket.body);

  const market = await call(marketplace, "GET", null, { cookie: carrierCookies[1] });
  const marketStr = JSON.stringify(market.body);
  check("marketplace ne fuit aucune adresse privée", !marketStr.includes("Privée A") && !marketStr.includes("Privée B"), marketStr.slice(0, 300));
  check("marketplace ne fuit aucun nom de donneur d'ordre", !marketStr.includes(`Iso Shippeur A ${stamp}`) && !marketStr.includes(`Iso Shippeur B ${stamp}`));

  console.log("\n----------------------------------------");
  console.log(`Résultat : ${pass} succès, ${failCount} échec(s)`);
  process.exit(failCount === 0 ? 0 : 1);
})().catch((e) => { console.error("ERREUR FATALE:", e); process.exit(1); });
