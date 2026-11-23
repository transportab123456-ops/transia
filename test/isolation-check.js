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

const crypto = require("crypto");
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

/* Attend que `expected` sessions soient bloquées sur une requête dont
   le texte contient `pattern` ; renvoie le nombre observé (0 si rien
   ne s'est bloqué dans le délai). */
async function waitForBlocked(pattern, expected) {
  let waiting = 0;
  for (let i = 0; i < 250 && waiting < expected; i++) {
    const w = await query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE $1`,
      ["%" + pattern + "%"]
    );
    waiting = w.rows[0].n;
    if (waiting < expected) await new Promise((r) => setTimeout(r, 20));
  }
  return waiting;
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
const tokens = require("../api/auth/tokens");
const { getPool, query } = require("../api/_lib/db");
const { hashPassword } = require("../api/_lib/auth");

(async () => {
  const stamp = Date.now();
  const pw = "motdepasse-test-2026";
  const terms = { termsAccepted: true, termsVersion: "1.0" };

  async function registerCarrier(i) {
    const res = await call(carriers, "POST", {
      companyName: `Iso Transporteur ${i} ${stamp}`, countryCode: "FR",
      email: `iso-carrier${i}-${stamp}@example.fr`, password: pw,
      firstName: "Carl", lastName: `C${i}`, modes: ["ROAD"], ...terms
    });
    return { res, cookie: extractCookie(res.headers) };
  }

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
    const { res, cookie } = await registerCarrier(i);
    check(`transporteur ${i} inscrit`, res.status === 201 && res.body.verification.status === "PENDING", res.body);
    carrierCookies.push(cookie);
    carrierIds.push(res.body.company.company_id);
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

  /* ---------- Valeurs hors limites PostgreSQL ---------- */
  console.log("\n[4ter] Valeurs hors limites : 400, jamais 500");

  const hugePackage = await call(rfqs, "POST", {
    originCity: "Lyon", originCountry: "FR", destinationCity: "Tanger", destinationCountry: "MA",
    mode: "ROAD", packageCount: 1e15
  }, { cookie: cookieB });
  check("packageCount hors capacité int → 400", hugePackage.status === 400 && hugePackage.body.code === "INVALID_DATA", hugePackage.body);

  const impossibleDate = await call(rfqs, "POST", {
    originCity: "Lyon", originCountry: "FR", destinationCity: "Tanger", destinationCountry: "MA",
    mode: "ROAD", pickupDate: "2026-02-31"
  }, { cookie: cookieB });
  check("date de chargement inexistante → 400", impossibleDate.status === 400 && impossibleDate.body.code === "INVALID_DATA", impossibleDate.body);

  const hugePrice = await call(quotes, "POST", {
    rfqNumber: numB, currency: "EUR", baseTransportPrice: 1e15
  }, { cookie: carrierCookies[1] });
  check("prix hors capacité numeric(14,2) → 400", hugePrice.status === 400 && hugePrice.body.code === "INVALID_DATA", hugePrice.body);

  const badValidity = await call(quotes, "POST", {
    rfqNumber: numB, currency: "EUR", baseTransportPrice: 2000, validUntil: "2026-02-31"
  }, { cookie: carrierCookies[1] });
  check("validité inexistante → 400", badValidity.status === 400 && badValidity.body.code === "INVALID_DATA", badValidity.body);

  /* Aucune de ces requêtes n'a laissé de trace. */
  const leftover = await query(
    `SELECT count(*)::int AS n FROM quotes WHERE rfq_id = (SELECT rfq_id FROM rfqs WHERE rfq_number = $1)`, [numB]
  );
  check("aucune offre partielle écrite", leftover.rows[0].n === 1, leftover.rows[0]);

  /* ---------- Affaire : confidentialité financière ---------- */
  console.log("\n[5] Après confirmation : commission invisible aux tiers");

  const rank = await call(recommendations, "POST", { rfqNumber: numA }, { cookie: adminCookie });
  check("classement de RFQ A calculé", rank.status === 200, rank.body);
  check("sans Drex → relecture humaine", rank.body.status === "PENDING_ADMIN", rank.body);
  const approveA = await call(recommendations, "POST", { rfqNumber: numA, approve: true }, { cookie: adminCookie });
  check("validation explicite → VALIDATED", approveA.status === 200 && approveA.body.status === "VALIDATED", approveA.body);
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

  /* ---------- Filet de sécurité du wrapper ---------- */
  console.log("\n[7] Filet de sécurité : erreur PostgreSQL 22P02 → 400");

  const { handler } = require("../api/_lib/respond");
  const uuidCrash = handler(async () => {
    const err = new Error("invalid input syntax for type uuid");
    err.code = "22P02";
    throw err;
  });
  const net = await call(uuidCrash, "POST", {});
  check("22P02 → 400 INVALID_IDENTIFIER", net.status === 400 && net.body.code === "INVALID_IDENTIFIER", net.body);

  const overflowCrash = handler(async () => {
    const err = new Error("numeric field overflow");
    err.code = "22003";
    throw err;
  });
  const overflow = await call(overflowCrash, "POST", {});
  check("22003 (capacité) → 400 INVALID_DATA", overflow.status === 400 && overflow.body.code === "INVALID_DATA", overflow.body);

  const conflictCrash = handler(async () => {
    const err = new Error("duplicate key value violates unique constraint");
    err.code = "23505";
    err.constraint = "users_email_key";
    throw err;
  });
  const conflict = await call(conflictCrash, "POST", {});
  check("23505 (unicité) → 409 CONFLICT", conflict.status === 409 && conflict.body.code === "CONFLICT", conflict.body);

  const otherCrash = handler(async () => {
    const err = new Error('relation "rfqs" does not exist');
    err.code = "42P01";
    throw err;
  });
  const stillFiveHundred = await call(otherCrash, "POST", {});
  check("erreur serveur (42P01) → toujours 500", stillFiveHundred.status === 500 && stillFiveHundred.body.code === "INTERNAL", stillFiveHundred.body);

  /* ---------- Concurrence réelle ---------- */
  console.log("\n[8] Concurrence réelle : violation d'unicité → 409");

  /* Une transaction concurrente insère l'e-mail sans le valider :
     le contrôle préalable de l'inscription ne peut pas la voir, et
     l'INSERT concurrent attend l'index unique. On valide seulement
     quand cette attente est observée, donc sans dépendre du hasard. */
  const raceEmail = `iso-race-${stamp}@example.fr`;
  const holder = await getPool().connect();
  try {
    await holder.query("BEGIN");
    const raceCo = await holder.query(
      `INSERT INTO companies (legal_name) VALUES ($1) RETURNING company_id`,
      [`Iso Race ${stamp}`]
    );
    await holder.query(
      `INSERT INTO users (company_id, first_name, last_name, email, password_hash, role, status)
       VALUES ($1,'Race','Test',$2,'x','SHIPPER_USER','ACTIVE')`,
      [raceCo.rows[0].company_id, raceEmail]
    );

    const pending = call(register, "POST", {
      email: raceEmail, password: pw, firstName: "Race", lastName: "Test",
      companyName: `Iso Race Client ${stamp}`, countryCode: "FR", ...terms
    });

    const blocked = await waitForBlocked("INSERT INTO users", 1);
    check("l'INSERT concurrent attend l'index unique", blocked >= 1, blocked);

    await holder.query("COMMIT");
    const raced = await pending;
    check("course d'inscription → 409 CONFLICT", raced.status === 409 && raced.body.code === "CONFLICT", raced.body);
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
  }

  /* ---------- Concurrence réelle sur la version d'offre ---------- */
  console.log("\n[9] Concurrence réelle : deux dépôts simultanés → 409");

  /* Une transaction concurrente retient la prochaine version sans la
     valider : les deux dépôts calculent donc la même version et se
     bloquent sur l'index unique. On valide seulement quand les deux
     attentes sont observées, puis les deux doivent répondre 409. */
  const rfqIdB = (await query(`SELECT rfq_id FROM rfqs WHERE rfq_number = $1`, [numB])).rows[0].rfq_id;
  const nextVersion = (await query(
    `SELECT COALESCE(max(quote_version), 0) + 1 AS n
       FROM quotes WHERE rfq_id = $1 AND carrier_company_id = $2`,
    [rfqIdB, carrierIds[1]]
  )).rows[0].n;
  const eurId = (await query(`SELECT currency_id FROM currencies WHERE iso_code = 'EUR'`)).rows[0].currency_id;

  /* Connexion hors pool : le pool plafonne à 3, et les deux dépôts
     concurrents en occupent déjà deux. */
  const { Client } = require("pg");
  const quoteHolder = new Client({ connectionString: process.env.DATABASE_URL });
  await quoteHolder.connect();
  try {
    await quoteHolder.query("BEGIN");
    await quoteHolder.query(
      `INSERT INTO quotes (rfq_id, carrier_company_id, quote_version, currency_id,
                           base_transport_price, compliance_status)
       VALUES ($1,$2,$3,$4,2000,'CONFORME')`,
      [rfqIdB, carrierIds[1], nextVersion, eurId]
    );

    const deposit = () => call(quotes, "POST", {
      rfqNumber: numB, currency: "EUR", baseTransportPrice: 2000
    }, { cookie: carrierCookies[1] });
    const first = deposit();
    const second = deposit();

    const waiting = await waitForBlocked("INSERT INTO quotes", 2);
    check("les deux dépôts attendent l'index unique", waiting >= 2, waiting);

    await quoteHolder.query("COMMIT");
    const [firstRes, secondRes] = await Promise.all([first, second]);
    check("1er dépôt simultané → 409 CONFLICT", firstRes.status === 409 && firstRes.body.code === "CONFLICT", firstRes.body);
    check("2e dépôt simultané → 409 CONFLICT", secondRes.status === 409 && secondRes.body.code === "CONFLICT", secondRes.body);
  } finally {
    await quoteHolder.query("ROLLBACK").catch(() => {});
    await quoteHolder.end().catch(() => {});
  }

  /* ---------- Cotations simultanées ---------- */
  console.log("\n[10] Cotations simultanées : aucune 500");

  /* Le plafond du pool est lu à la création, donc vérifié dans un
     processus neuf pour chaque valeur. */
  const { spawnSync } = require("child_process");
  const dbPath = require.resolve("../api/_lib/db");
  const probeMax = (value) => {
    const code =
      `delete process.env.PG_POOL_MAX;` +
      (value === undefined ? "" : `process.env.PG_POOL_MAX=${JSON.stringify(value)};`) +
      `const { getPool } = require(${JSON.stringify(dbPath)});` +
      `process.stdout.write(String(getPool().options.max));`;
    return (spawnSync(process.execPath, ["-e", code], { encoding: "utf8" }).stdout || "").trim();
  };
  const byDefault = probeMax();
  check("plafond par défaut = 3", byDefault === "3", byDefault);
  const six = probeMax("6");
  check("PG_POOL_MAX=6 → plafond 6", six === "6", six);
  const invalid = probeMax("abc");
  check("PG_POOL_MAX invalide → 3", invalid === "3", invalid);
  const capped = probeMax("999");
  check("PG_POOL_MAX=999 → plafonné à 20", capped === "20", capped);

  /* Quatre transporteurs déposent en même temps sur la même RFQ :
     le pool en sert trois, le quatrième attend une connexion. Aucune
     requête ne doit finir en 500. */
  const extraCookies = [];
  for (const i of [3, 4]) {
    const { res, cookie } = await registerCarrier(i);
    const v = await call(admin, "POST", {
      action: "verify", companyId: res.body.company.company_id, decision: "VERIFIED"
    }, { cookie: adminCookie });
    check(`transporteur ${i} prêt pour la charge`, res.status === 201 && v.status === 200, v.body);
    extraCookies.push(cookie);
  }

  const rfqC = await call(rfqs, "POST", {
    originCity: "Nantes", originCountry: "FR", destinationCity: "Agadir", destinationCountry: "MA",
    mode: "ROAD", cargoDescription: "Charge simultanée", palletCount: 2
  }, { cookie: cookieA });
  check("RFQ de charge créée", rfqC.status === 201, rfqC.body);
  const numC = rfqC.body.rfq.rfq_number;

  const crew = [carrierCookies[0], carrierCookies[1], ...extraCookies];
  const deposits = await Promise.all(crew.map((cookie, i) => call(quotes, "POST", {
    rfqNumber: numC, currency: "EUR", baseTransportPrice: 2400 + i * 100, transitTimeValue: 4 + i
  }, { cookie })));
  const statuses = deposits.map((d) => d.status);
  check("4 cotations simultanées : aucune 500", statuses.every((s) => s !== 500), statuses);
  check("les 4 cotations sont acceptées", statuses.every((s) => s === 201), deposits.map((d) => d.body && d.body.code));

  const stored = await query(
    `SELECT count(*)::int AS n FROM quotes WHERE rfq_id = (SELECT rfq_id FROM rfqs WHERE rfq_number = $1)`,
    [numC]
  );
  check("4 offres en base", stored.rows[0].n === 4, stored.rows[0]);

  /* ---------- Créations de RFQ et acceptations simultanées ---------- */
  console.log("\n[11] Créations de RFQ et acceptations simultanées : aucune 500");

  const rfqBodies = [1, 2, 3, 4].map((i) => ({
    originCity: "Lille", originCountry: "FR", destinationCity: `Port ${i}`, destinationCountry: "MA",
    mode: "ROAD", cargoDescription: `Charge RFQ ${i}`, palletCount: i
  }));
  const created = await Promise.all(rfqBodies.map((b) => call(rfqs, "POST", b, { cookie: cookieA })));
  const createdStatuses = created.map((r) => r.status);
  check("4 créations de RFQ simultanées : aucune 500", createdStatuses.every((s) => s !== 500), createdStatuses);
  check("les 4 RFQ sont créées", createdStatuses.every((s) => s === 201), created.map((r) => r.body && r.body.code));
  const nums = created.map((r) => r.body.rfq.rfq_number);

  /* Une offre conforme par RFQ, puis acceptation des quatre en parallèle.
     La réponse de dépôt porte déjà quote_id : inutile de le relire. */
  const quoteIds = [];
  for (const [i, rfqNumber] of nums.entries()) {
    const q = await call(quotes, "POST", {
      rfqNumber, currency: "EUR", baseTransportPrice: 1800 + i * 100, transitTimeValue: 5
    }, { cookie: crew[i] });
    check(`offre ${i + 1} déposée pour l'acceptation`, q.status === 201, q.body);
    quoteIds.push(q.body.quote.quote_id);
  }
  await query(`UPDATE quotes SET compliance_status = 'CONFORME' WHERE quote_id = ANY($1)`, [quoteIds]);

  const accepts = await Promise.all(nums.map((rfqNumber, i) => call(deals, "POST", {
    rfqNumber, action: "accept", quoteId: quoteIds[i]
  }, { cookie: cookieA })));
  const acceptStatuses = accepts.map((r) => r.status);
  check("4 acceptations simultanées : aucune 500", acceptStatuses.every((s) => s !== 500), acceptStatuses);
  check("les 4 acceptations aboutissent", acceptStatuses.every((s) => s === 201), accepts.map((r) => r.body && r.body.code));

  const accCount = await query(
    `SELECT count(*)::int AS n FROM quote_acceptances
      WHERE rfq_id IN (SELECT rfq_id FROM rfqs WHERE rfq_number = ANY($1))`,
    [nums]
  );
  check("4 acceptations en base", accCount.rows[0].n === 4, accCount.rows[0]);

  /* ---------- Vérifications simultanées de transporteurs ---------- */
  console.log("\n[12] Vérifications simultanées de transporteurs : aucune 500");

  const awaiting = [];
  for (const i of [5, 6, 7, 8]) awaiting.push(await registerCarrier(i));
  check("4 transporteurs en attente de vérification",
    awaiting.every(({ res }) => res.status === 201 && res.body.verification.status === "PENDING"),
    awaiting.map(({ res }) => res.status));
  const awaitingIds = awaiting.map(({ res }) => res.body.company.company_id);

  const verdicts = await Promise.all(awaitingIds.map((companyId) => call(admin, "POST", {
    action: "verify", companyId, decision: "VERIFIED"
  }, { cookie: adminCookie })));
  const verdictStatuses = verdicts.map((r) => r.status);
  check("4 vérifications simultanées : aucune 500", verdictStatuses.every((s) => s !== 500), verdictStatuses);
  check("les 4 transporteurs sont vérifiés", verdictStatuses.every((s) => s === 200), verdicts.map((r) => r.body && r.body.code));

  const verifiedCount = await query(
    `SELECT count(*)::int AS n FROM carrier_profiles WHERE company_id = ANY($1) AND validation_status = 'VERIFIED'`,
    [awaitingIds]
  );
  check("4 profils vérifiés en base", verifiedCount.rows[0].n === 4, verifiedCount.rows[0]);

  /* ---------- Inscriptions simultanées ---------- */
  console.log("\n[13] Inscriptions simultanées : aucune 500");

  /* Quatre comptes donneurs d'ordre (la limite est de 10 par minute
     et par IP : deux ont déjà été créés en [1]). */
  const signups = await Promise.all([1, 2, 3, 4].map((i) => call(register, "POST", {
    email: `iso-load-${i}-${stamp}@example.fr`, password: pw,
    firstName: "Léa", lastName: `L${i}`,
    companyName: `Iso Charge ${i} ${stamp}`, countryCode: "FR", ...terms
  })));
  const signupStatuses = signups.map((r) => r.status);
  check("4 inscriptions simultanées : aucune 500", signupStatuses.every((s) => s !== 500), signupStatuses);
  check("les 4 inscriptions aboutissent", signupStatuses.every((s) => s === 201), signups.map((r) => r.body && r.body.code));

  const signupCount = await query(
    `SELECT count(*)::int AS n FROM users WHERE email LIKE $1`,
    [`iso-load-%-${stamp}@example.fr`]
  );
  check("4 comptes créés en base", signupCount.rows[0].n === 4, signupCount.rows[0]);

  /* ---------- Recommandations simultanées ---------- */
  console.log("\n[14] Recommandations simultanées : aucune 500");

  const recoNums = [];
  for (let i = 0; i < 4; i++) {
    const r = await call(rfqs, "POST", {
      originCity: "Marseille", originCountry: "FR", destinationCity: `Zone ${i + 1}`, destinationCountry: "MA",
      mode: "ROAD", cargoDescription: `Charge reco ${i + 1}`, palletCount: 1
    }, { cookie: cookieB });
    check(`RFQ reco ${i + 1} créée`, r.status === 201, r.body);
    if (r.status !== 201) continue;
    recoNums.push(r.body.rfq.rfq_number);
    const q = await call(quotes, "POST", {
      rfqNumber: r.body.rfq.rfq_number, currency: "EUR", baseTransportPrice: 1500 + i * 100, transitTimeValue: 3
    }, { cookie: crew[i] });
    check(`offre reco ${i + 1} déposée`, q.status === 201, q.body);
  }

  /* Sans NACE_API_KEY, Drex est indisponible : chaque recommandation
     part en relecture. Quatre validations explicites simultanées
     doivent aboutir sans 500 (chemin flushOutbox(client) pris). */
  const ranks = await Promise.all(recoNums.map((rfqNumber) => call(recommendations, "POST", { rfqNumber }, { cookie: adminCookie })));
  const rankStatuses = ranks.map((r) => r.status);
  check("4 classements simultanés : aucune 500", rankStatuses.every((s) => s !== 500), rankStatuses);
  check("les 4 classements attendent la relecture",
    ranks.every((r) => r.status === 200 && r.body.status === "PENDING_ADMIN"), ranks.map((r) => r.body && r.body.code));

  const recos = await Promise.all(recoNums.map((rfqNumber) => call(recommendations, "POST", { rfqNumber, approve: true }, { cookie: adminCookie })));
  const recoStatuses = recos.map((r) => r.status);
  check("4 validations simultanées : aucune 500", recoStatuses.every((s) => s !== 500), recoStatuses);
  check("les 4 validations aboutissent", recoStatuses.every((s) => s === 200), recos.map((r) => r.body && r.body.code));

  const recoCount = await query(
    `SELECT count(*)::int AS n FROM rfq_recommendations
      WHERE rfq_id IN (SELECT rfq_id FROM rfqs WHERE rfq_number = ANY($1))
        AND status <> 'SUPERSEDED'`,
    [recoNums]
  );
  check("4 recommandations en base", recoCount.rows[0].n === 4, recoCount.rows[0]);

  /* ---------- Vérifications d'e-mail simultanées ---------- */
  console.log("\n[15] Vérifications d'e-mail simultanées : aucune 500");

  const tokenHashes = [];
  const verifyTokens = [];
  for (let i = 1; i <= 4; i++) {
    const u = await query(
      `SELECT user_id, email FROM users WHERE email = $1`,
      [`iso-load-${i}-${stamp}@example.fr`]
    );
    const token = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    await query(
      `INSERT INTO email_verifications (user_id, email, token_hash, expires_at)
       VALUES ($1,$2,$3, now() + interval '1 hour')`,
      [u.rows[0].user_id, u.rows[0].email, hash]
    );
    verifyTokens.push(token);
    tokenHashes.push(hash);
  }

  const verifications = await Promise.all(verifyTokens.map((token) => call(tokens, "POST", { token })));
  const verifyStatuses = verifications.map((r) => r.status);
  check("4 vérifications simultanées : aucune 500", verifyStatuses.every((s) => s !== 500), verifyStatuses);
  check("les 4 comptes sont activés", verifyStatuses.every((s) => s === 200), verifications.map((r) => r.body && r.body.code));

  const usedTokens = await query(
    `SELECT count(*)::int AS n FROM email_verifications
      WHERE token_hash = ANY($1) AND used_at IS NOT NULL`,
    [tokenHashes]
  );
  check("4 jetons consommés", usedTokens.rows[0].n === 4, usedTokens.rows[0]);

  /* ---------- Deux validations simultanées de la même relecture ---------- */
  console.log("\n[16] Deux validations simultanées : une seule aboutit, un seul e-mail");

  const rfqOne = await call(rfqs, "POST", {
    originCity: "Bordeaux", originCountry: "FR", destinationCity: "Rabat", destinationCountry: "MA",
    mode: "ROAD", cargoDescription: "Charge validation unique", palletCount: 1
  }, { cookie: cookieB });
  check("RFQ de validation créée", rfqOne.status === 201, rfqOne.body);
  const numOne = rfqOne.body.rfq.rfq_number;

  const qOne = await call(quotes, "POST", {
    rfqNumber: numOne, currency: "EUR", baseTransportPrice: 1650, transitTimeValue: 4
  }, { cookie: crew[0] });
  check("offre de validation déposée", qOne.status === 201, qOne.body);

  const rankOne = await call(recommendations, "POST", { rfqNumber: numOne }, { cookie: adminCookie });
  check("classement en relecture", rankOne.status === 200 && rankOne.body.status === "PENDING_ADMIN", rankOne.body);

  /* Deux opérateurs valident en même temps : le verrou FOR UPDATE et le
     UPDATE conditionnel garantissent un seul succès, donc un seul
     e-mail recommendation_ready. */
  const twoApprovals = await Promise.all([1, 2].map(() => call(
    recommendations, "POST", { rfqNumber: numOne, approve: true }, { cookie: adminCookie }
  )));
  const approvalStatuses = twoApprovals.map((r) => r.status).sort();
  check("une validation aboutit, l'autre est refusée",
    approvalStatuses.length === 2 && approvalStatuses[0] === 200 && approvalStatuses[1] === 409,
    twoApprovals.map((r) => ({ status: r.status, code: r.body && r.body.code })));

  const loser = twoApprovals.find((r) => r.status === 409);
  check("le refus est explicite",
    !!loser && ["NO_PENDING_RECOMMENDATION", "RANKING_CHANGED"].includes(loser.body.code),
    loser && loser.body);

  const validatedCount = await query(
    `SELECT count(*)::int AS n FROM rfq_recommendations
      WHERE rfq_id = (SELECT rfq_id FROM rfqs WHERE rfq_number = $1) AND status = 'VALIDATED'`,
    [numOne]
  );
  check("une seule recommandation validée", validatedCount.rows[0].n === 1, validatedCount.rows[0]);

  const mailCount = await query(
    `SELECT count(*)::int AS n FROM outbox_emails
      WHERE event_type = 'recommendation_ready'
        AND entity_id = (SELECT rfq_id FROM rfqs WHERE rfq_number = $1)`,
    [numOne]
  );
  check("un seul e-mail recommendation_ready", mailCount.rows[0].n === 1, mailCount.rows[0]);

  const rankingCount = await query(
    `SELECT count(*)::int AS total, count(DISTINCT quote_id)::int AS offres
       FROM quote_rankings
      WHERE rfq_id = (SELECT rfq_id FROM rfqs WHERE rfq_number = $1)`,
    [numOne]
  );
  check("une seule ligne de classement par offre",
    rankingCount.rows[0].total === rankingCount.rows[0].offres, rankingCount.rows[0]);

  console.log("\n----------------------------------------");
  console.log(`Résultat : ${pass} succès, ${failCount} échec(s)`);
  process.exit(failCount === 0 ? 0 : 1);
})().catch((e) => { console.error("ERREUR FATALE:", e); process.exit(1); });
