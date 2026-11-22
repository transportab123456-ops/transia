/* ============================================================
   Transia — test/api-e2e.js
   Test end-to-end des fonctions API contre la vraie PostgreSQL
   locale (Docker). Invoque les handlers directement avec des
   objets req/res simulés (compatibles Vercel).

   Usage : DATABASE_URL=postgresql://... node test/api-e2e.js
   Code de sortie 0 = tous les contrôles passent.
   ============================================================ */
"use strict";

const { PassThrough, Writable } = require("stream");

require("../db/env").requireDatabaseUrl();

/* ---------- Simulation req/res ---------- */
function makeReq(method, body, headers = {}) {
  const req = new PassThrough();
  req.method = method;
  req.headers = { "content-type": "application/json", ...headers };
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

async function call(handler, method, body, headers) {
  const req = makeReq(method, body, headers);
  const res = makeRes();
  await handler(req, res);
  await res._done;
  return { status: res.statusCode, headers: res._headers, body: res.body() };
}

/* ---------- Mini framework ---------- */
let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.log("  ✗ " + label + (extra !== undefined ? " → " + JSON.stringify(extra) : "")); }
}

const health = require("../api/health");
const register = require("../api/auth/register");
const login = require("../api/auth/login");
const me = require("../api/auth/me");
const rfqs = require("../api/rfqs");
const { query } = require("../api/_lib/db");

function extractCookie(resHeaders) {
  const set = resHeaders["set-cookie"];
  if (!set) return null;
  const arr = Array.isArray(set) ? set : [set];
  const m = arr.join("; ").match(/transia_session=([^;]+)/);
  return m ? "transia_session=" + m[1] : null;
}

(async () => {
  const stamp = Date.now();

  console.log("\n[1] GET /api/health");
  const h = await call(health, "GET");
  check("200 + db.ok", h.status === 200 && h.body.db && h.body.db.ok === true, h.body);
  check("base renseignée", h.body.db && !!h.body.db.database, h.body.db);

  console.log("\n[2] POST /api/auth/register (nouvel utilisateur)");
  const email = `e2e-${stamp}@example.fr`;
  const reg = await call(register, "POST", {
    email, password: "motdepasse-test-2026", firstName: "Émilie",
    lastName: "Dupont", companyName: "E2E Test SAS", countryCode: "FR",
    termsAccepted: true, termsVersion: "1.0"
  }, { "x-forwarded-for": "203.0.113.7" });
  check("201 créé", reg.status === 201, reg.body);
  check("rôle SHIPPER_USER", reg.body.user && reg.body.user.role === "SHIPPER_USER", reg.body.user);
  check("company_id présent", !!(reg.body.company && reg.body.company.company_id), reg.body);
  const cookie = extractCookie(reg.headers);
  check("cookie de session posé", !!cookie);

  console.log("\n[3] Rejets de validation register");
  const weak = await call(register, "POST", { email: `x-${stamp}@example.fr`, password: "court", firstName: "A", lastName: "B", companyName: "X" });
  check("mot de passe faible → 400", weak.status === 400 && weak.body.code === "WEAK_PASSWORD", weak.body);
  const dup = await call(register, "POST", { email, password: "motdepasse-test-2026", firstName: "A", lastName: "B", companyName: "Dup", termsAccepted: true, termsVersion: "1.0" });
  check("e-mail dupliqué → 409", dup.status === 409 && dup.body.code === "EMAIL_TAKEN", dup.body);
  const badCountry = await call(register, "POST", { email: `y-${stamp}@example.fr`, password: "motdepasse-test-2026", firstName: "A", lastName: "B", companyName: "Y", countryCode: "XYZ" });
  check("code pays invalide → 400", badCountry.status === 400, badCountry.body);
  const unknownCountry = await call(register, "POST", { email: `z-${stamp}@example.fr`, password: "motdepasse-test-2026", firstName: "A", lastName: "B", companyName: "Z", countryCode: "ZZ", termsAccepted: true, termsVersion: "1.0" });
  check("pays inconnu référentiel → 400", unknownCountry.status === 400 && unknownCountry.body.code === "UNKNOWN_COUNTRY", unknownCountry.body);

  console.log("\n[3bis] Acceptation des CGU");
  const noTerms = await call(register, "POST", { email: `nt-${stamp}@example.fr`, password: "motdepasse-test-2026", firstName: "A", lastName: "B", companyName: "NT" });
  check("CGU non acceptées → 400", noTerms.status === 400 && noTerms.body.code === "TERMS_NOT_ACCEPTED", noTerms.body);
  const staleTerms = await call(register, "POST", { email: `st-${stamp}@example.fr`, password: "motdepasse-test-2026", firstName: "A", lastName: "B", companyName: "ST", termsAccepted: true, termsVersion: "0.9" });
  check("version obsolète → 409", staleTerms.status === 409 && staleTerms.body.code === "TERMS_VERSION_OUTDATED", staleTerms.body);
  const proof = await query(
    `SELECT document_type, document_version, ip_address, user_agent, accepted_at
       FROM terms_acceptances WHERE user_id = $1`,
    [reg.body.user.user_id]
  );
  check("preuve CGU enregistrée", proof.rows.length === 1 && proof.rows[0].document_type === "SHIPPER_TERMS" && proof.rows[0].document_version === "1.0", proof.rows);
  check("IP et horodatage conservés", !!proof.rows[0] && proof.rows[0].ip_address === "203.0.113.7" && !!proof.rows[0].accepted_at, proof.rows[0]);

  console.log("\n[4] GET /api/auth/me");
  const anon = await call(me, "GET");
  check("sans session → user null", anon.status === 200 && anon.body.user === null, anon.body);
  const authed = await call(me, "GET", null, { cookie });
  check("avec session → profil renvoyé", authed.status === 200 && authed.body.user && authed.body.user.email === email, authed.body);

  console.log("\n[5] POST /api/auth/login");
  const badLogin = await call(login, "POST", { email, password: "mauvais-mdp" });
  check("mauvais mot de passe → 401", badLogin.status === 401 && badLogin.body.code === "INVALID_CREDENTIALS", badLogin.body);
  const okLogin = await call(login, "POST", { email, password: "motdepasse-test-2026" });
  check("bonnes identifiants → 200 + cookie", okLogin.status === 200 && !!extractCookie(okLogin.headers), okLogin.body);
  const cookie2 = extractCookie(okLogin.headers) || cookie;

  console.log("\n[6] GET /api/rfqs — RBAC");
  const anonList = await call(rfqs, "GET");
  check("sans session → 401", anonList.status === 401 && anonList.body.code === "UNAUTHENTICATED", anonList.body);
  const list0 = await call(rfqs, "GET", null, { cookie: cookie2 });
  check("avec session → 200", list0.status === 200, list0.body);

  console.log("\n[7] POST /api/rfqs — création");
  const anonPost = await call(rfqs, "POST", { originCity: "Lyon" });
  check("sans session → 401", anonPost.status === 401, anonPost.body);
  const badMode = await call(rfqs, "POST", {
    originCity: "Lyon", originCountry: "FR", destinationCity: "Casablanca", destinationCountry: "MA", mode: "FUSÉE"
  }, { cookie: cookie2 });
  check("mode invalide → 400", badMode.status === 400 && badMode.body.code === "INVALID_MODE", badMode.body);
  const badCountry2 = await call(rfqs, "POST", {
    originCity: "Lyon", originCountry: "FR", destinationCity: "X", destinationCountry: "ZZ", mode: "ROAD"
  }, { cookie: cookie2 });
  check("pays inconnu → 400", badCountry2.status === 400 && badCountry2.body.code === "UNKNOWN_COUNTRY", badCountry2.body);
  const badDg = await call(rfqs, "POST", {
    originCity: "Lyon", originCountry: "FR", destinationCity: "Casablanca", destinationCountry: "MA",
    mode: "ROAD", dangerousGoods: true
  }, { cookie: cookie2 });
  check("ADR sans champs → 400", badDg.status === 400 && badDg.body.code === "MISSING_DG_FIELDS", badDg.body);

  const created = await call(rfqs, "POST", {
    originCity: "Lyon", originCountry: "FR", originPostalCode: "69007",
    originPrivateAddress: "12 rue de la République, 69007 Lyon",
    destinationCity: "Casablanca", destinationCountry: "MA", destinationPostalCode: "20000",
    destinationPrivateAddress: "Zone franche Aïn Sebaâ",
    mode: "ROAD", incoterm: "EXW", pickupDate: "2026-12-01",
    quoteDeadline: "2026-11-20T16:00:00Z",
    cargoDescription: "Pièces détachées", palletCount: 12, grossWeight: 4800, volume: 26
  }, { cookie: cookie2 });
  check("201 créée", created.status === 201, created.body);
  const rfqNum = created.body.rfq && created.body.rfq.rfq_number;
  check("numéro RFQ-AAAA-NNNNNN", /^RFQ-\d{4}-\d{6}$/.test(rfqNum || ""), rfqNum);
  check("statut OPEN", created.body.rfq && created.body.rfq.status === "OPEN", created.body.rfq);

  const created2 = await call(rfqs, "POST", {
    originCity: "Marseille", originCountry: "FR", destinationCity: "Tanger", destinationCountry: "MA",
    mode: "SEA", dangerousGoods: true, unNumber: "1950", hazardClass: "2.1",
    cargoDescription: "Aérosols", palletCount: 3
  }, { cookie: cookie2 });
  check("2e RFQ créée (ADR)", created2.status === 201, created2.body);
  check("numéros distincts", created.body.rfq.rfq_number !== created2.body.rfq.rfq_number, { a: rfqNum, b: created2.body.rfq.rfq_number });

  console.log("\n[8] GET /api/rfqs — contenu");
  const list = await call(rfqs, "GET", null, { cookie: cookie2 });
  check("RFQ listées (≥2)", list.status === 200 && list.body.count >= 2, list.body);
  check("numéros présents dans la liste", list.body.rfqs.some((r) => r.rfq_number === rfqNum), list.body.rfqs && list.body.rfqs[0]);
  check("route enrichie (pays + mode)", list.body.rfqs[0] && list.body.rfqs[0].origin_country === "FR" && !!list.body.rfqs[0].mode, list.body.rfqs[0]);

  console.log("\n[9] Isolation RBAC : un 2e shipper ne voit pas les RFQ du 1er");
  const emailB = `e2e-b-${stamp}@example.fr`;
  const regB = await call(register, "POST", { email: emailB, password: "motdepasse-test-2026", firstName: "Bruno", lastName: "Martin", companyName: "Concurrent SAS", countryCode: "BE", termsAccepted: true, termsVersion: "1.0" });
  const cookieB = extractCookie(regB.headers);
  const listB = await call(rfqs, "GET", null, { cookie: cookieB });
  check("2e shipper : 0 RFQ", listB.status === 200 && listB.body.count === 0, listB.body);

  console.log("\n[10] POST /api/auth/logout révoque la session");
  const out = await call(me, "POST", null, { cookie: cookie2 });
  check("logout → 200", out.status === 200 && out.body.ok === true, out.body);
  const after = await call(rfqs, "GET", null, { cookie: cookie2 });
  check("session révoquée → 401", after.status === 401, after.body);

  console.log("\n----------------------------------------");
  console.log(`Résultat : ${pass} succès, ${fail} échec(s)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("ERREUR FATALE:", e); process.exit(1); });
