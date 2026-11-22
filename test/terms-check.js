/* ============================================================
   Transia — test/terms-check.js
   Vérifie l'acceptation versionnée des CGU à l'inscription :
   - refus sans case cochée (400 TERMS_NOT_ACCEPTED) ;
   - refus d'une version obsolète (409 TERMS_VERSION_OUTDATED) ;
   - preuve enregistrée : version, IP, agent, horodatage ;
   - preuve non modifiable.

   Usage : DATABASE_URL=postgresql://... node test/terms-check.js
   Code de sortie 0 = tous les contrôles passent.
   ============================================================ */
"use strict";

const { PassThrough, Writable } = require("stream");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquant.");
  process.exit(2);
}

const register = require("../api/auth/register");
const { query, getPool } = require("../api/_lib/db");

function makeReq(method, body, headers = {}) {
  const req = new PassThrough();
  req.method = method;
  req.headers = { "content-type": "application/json", "user-agent": "terms-check/1.0", ...headers };
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

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.log("  ✗ " + label + (extra !== undefined ? " → " + JSON.stringify(extra) : "")); }
}

const IP = "203.0.113.7";
const stamp = Date.now();
const email = `terms-${stamp}@example.fr`;
const pw = "motdepasse-test-2026";

async function cleanup() {
  const u = await query("SELECT user_id, company_id FROM users WHERE email = $1", [email]);
  if (!u.rows.length) return;
  const { user_id, company_id } = u.rows[0];
  await query("DELETE FROM audit_log WHERE entity_id = $1 OR user_id = $1", [user_id]);
  await query("DELETE FROM users WHERE user_id = $1", [user_id]);   /* cascade preuve + sessions */
  if (company_id) await query("DELETE FROM companies WHERE company_id = $1", [company_id]);
}

(async () => {
  try {
    console.log("\n[1] Refus sans acceptation");
    const none = await call(register, "POST", {
      email: `terms-none-${stamp}@example.fr`, password: pw,
      firstName: "Sans", lastName: "Acceptation", companyName: "Sans CGU", countryCode: "FR"
    }, { "x-forwarded-for": IP });
    check("400 TERMS_NOT_ACCEPTED", none.status === 400 && none.body.code === "TERMS_NOT_ACCEPTED", none.body);

    console.log("\n[2] Refus d'une version obsolète");
    const stale = await call(register, "POST", {
      email: `terms-stale-${stamp}@example.fr`, password: pw,
      firstName: "Version", lastName: "Obsolete", companyName: "Ancienne CGU", countryCode: "FR",
      termsAccepted: true, termsVersion: "0.9"
    }, { "x-forwarded-for": IP });
    check("409 TERMS_VERSION_OUTDATED", stale.status === 409 && stale.body.code === "TERMS_VERSION_OUTDATED", stale.body);

    console.log("\n[3] Inscription avec acceptation");
    const ok = await call(register, "POST", {
      email, password: pw, firstName: "Preuve", lastName: "Acceptation",
      companyName: `Preuve CGU ${stamp}`, countryCode: "FR",
      termsAccepted: true, termsVersion: "1.0"
    }, { "x-forwarded-for": IP });
    check("201 créé", ok.status === 201, ok.body);

    console.log("\n[4] Preuve conservée en base");
    const proof = await query(
      `SELECT user_id, company_id, document_type, document_version, accepted_at, ip_address, user_agent, context
         FROM terms_acceptances WHERE user_id = $1`,
      [ok.body.user.user_id]
    );
    const row = proof.rows[0];
    check("une ligne d'acceptation", proof.rows.length === 1, proof.rows);
    check("document SHIPPER_TERMS", !!row && row.document_type === "SHIPPER_TERMS", row);
    check("version 1.0", !!row && row.document_version === "1.0", row);
    check("horodatage posé par la base", !!row && !!row.accepted_at, row);
    check("IP conservée", !!row && row.ip_address === IP, row);
    check("agent et contexte", !!row && row.user_agent === "terms-check/1.0" && row.context === "REGISTRATION", row);

    console.log("\n[5] Preuve non modifiable");
    let blocked = false;
    try {
      await query("UPDATE terms_acceptances SET document_version = '0.0' WHERE user_id = $1", [ok.body.user.user_id]);
    } catch (e) {
      blocked = /écriture seule/.test(e.message);
    }
    check("UPDATE refusé par la base", blocked);
  } finally {
    await cleanup();
    await getPool().end();
  }

  console.log(`\n${pass} contrôle(s) OK, ${fail} échec(s).`);
  process.exit(fail ? 1 : 0);
})();
