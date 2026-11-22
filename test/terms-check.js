/* ============================================================
   Transia — test/terms-check.js
   Vérifie l'acceptation versionnée des CGU :
   - refus sans case cochée (400 TERMS_NOT_ACCEPTED) ;
   - refus d'une version obsolète (409 TERMS_VERSION_OUTDATED) ;
   - preuve enregistrée : version, IP, agent, horodatage ;
   - preuve non modifiable ;
   - ré-acceptation à la connexion pour un compte sans preuve ;
   - comptes plateforme non soumis.

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
const login = require("../api/auth/login");
const me = require("../api/auth/me");
const rfqs = require("../api/rfqs");
const { query, getPool } = require("../api/_lib/db");
const { hashPassword } = require("../api/_lib/auth");

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

function extractCookie(headers) {
  const set = headers["set-cookie"];
  if (!set) return null;
  const arr = Array.isArray(set) ? set : [set];
  const m = arr.join("; ").match(/transia_session=([^;]+)/);
  return m ? "transia_session=" + m[1] : null;
}

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.log("  ✗ " + label + (extra !== undefined ? " → " + JSON.stringify(extra) : "")); }
}

const IP = "203.0.113.7";
const stamp = Date.now();
const email = `terms-${stamp}@example.fr`;
const platformEmail = `terms-platform-${stamp}@example.fr`;
const pw = "motdepasse-test-2026";

let platformUserId = null;
let platformCompanyId = null;

async function cleanup() {
  const u = await query("SELECT user_id, company_id FROM users WHERE email = $1", [email]);
  if (u.rows.length) {
    const { user_id, company_id } = u.rows[0];
    await query("DELETE FROM audit_log WHERE entity_id = $1 OR user_id = $1", [user_id]);
    await query("DELETE FROM users WHERE user_id = $1", [user_id]);   /* cascade preuve + sessions */
    if (company_id) await query("DELETE FROM companies WHERE company_id = $1", [company_id]);
  }
  if (platformUserId) {
    await query("DELETE FROM users WHERE user_id = $1", [platformUserId]);
  }
  if (platformCompanyId) {
    await query("DELETE FROM companies WHERE company_id = $1", [platformCompanyId]);
  }
  await query("DELETE FROM outbox_emails WHERE recipient_email = ANY($1::text[])", [[email, platformEmail]]);
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
    const userId = ok.body.user.user_id;

    console.log("\n[4] Preuve conservée en base");
    const proof = await query(
      `SELECT user_id, company_id, document_type, document_version, accepted_at, ip_address, user_agent, context
         FROM terms_acceptances WHERE user_id = $1`,
      [userId]
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
      await query("UPDATE terms_acceptances SET document_version = '0.0' WHERE user_id = $1", [userId]);
    } catch (e) {
      blocked = /écriture seule/.test(e.message);
    }
    check("UPDATE refusé par la base", blocked);

    console.log("\n[6] Ré-acceptation à la connexion");
    /* Compte hérité : la preuve disparaît (comme un compte créé avant
       la mise en place du mécanisme). */
    await query("DELETE FROM terms_acceptances WHERE user_id = $1", [userId]);

    const needTerms = await call(login, "POST", { email, password: pw }, { "x-forwarded-for": IP });
    check("403 TERMS_REACCEPTANCE_REQUIRED", needTerms.status === 403 && needTerms.body.code === "TERMS_REACCEPTANCE_REQUIRED", needTerms.body);
    check("version annoncée au client", !!needTerms.body.terms && needTerms.body.terms.version === "1.0", needTerms.body.terms);
    check("aucune session ouverte", !needTerms.headers["set-cookie"]);

    const wrong = await call(login, "POST", { email, password: pw, termsAccepted: true, termsVersion: "0.9" }, { "x-forwarded-for": IP });
    check("version obsolète → 403", wrong.status === 403 && wrong.body.code === "TERMS_REACCEPTANCE_REQUIRED", wrong.body);

    const reaccepted = await call(login, "POST", { email, password: pw, termsAccepted: true, termsVersion: "1.0" }, { "x-forwarded-for": IP });
    check("connexion après acceptation → 200", reaccepted.status === 200 && !!reaccepted.headers["set-cookie"], reaccepted.body);

    const proof2 = await query(
      "SELECT context, document_version, ip_address FROM terms_acceptances WHERE user_id = $1",
      [userId]
    );
    check("une preuve REACCEPTANCE", proof2.rows.length === 1 && proof2.rows[0].context === "REACCEPTANCE", proof2.rows);
    check("version et IP de la connexion", proof2.rows[0] && proof2.rows[0].document_version === "1.0" && proof2.rows[0].ip_address === IP, proof2.rows);

    /* Une fois la preuve posée, la connexion ne la redemande plus. */
    const again = await call(login, "POST", { email, password: pw }, { "x-forwarded-for": IP });
    check("connexion suivante sans case → 200", again.status === 200, again.body);

    /* Session ouverte avant la preuve : cas d'un compte hérité,
       connecté avant la mise en place du mécanisme. La preuve
       disparaît, la session reste valide (8 h). */
    const legacyCookie = extractCookie(again.headers);
    await query("DELETE FROM terms_acceptances WHERE user_id = $1", [userId]);

    const mePending = await call(me, "GET", null, { cookie: legacyCookie, "x-forwarded-for": IP });
    check("session active : /me signale les CGU",
      mePending.status === 200 && !!mePending.body.user && !!mePending.body.terms && mePending.body.terms.required === true,
      mePending.body);

    const blockedApi = await call(rfqs, "GET", null, { cookie: legacyCookie });
    check("session active : API protégée → 403",
      blockedApi.status === 403 && blockedApi.body.code === "TERMS_REACCEPTANCE_REQUIRED",
      blockedApi.body);

    const acceptedInSession = await call(me, "POST", { termsAccepted: true, termsVersion: "1.0" }, { cookie: legacyCookie, "x-forwarded-for": IP });
    check("acceptation depuis la session → 200", acceptedInSession.status === 200, acceptedInSession.body);

    const unblocked = await call(rfqs, "GET", null, { cookie: legacyCookie });
    check("API débloquée après acceptation", unblocked.status === 200, unblocked.body);

    const proof3 = await query("SELECT context, ip_address FROM terms_acceptances WHERE user_id = $1", [userId]);
    check("preuve REACCEPTANCE depuis la session",
      proof3.rows.length === 1 && proof3.rows[0].context === "REACCEPTANCE" && proof3.rows[0].ip_address === IP,
      proof3.rows);

    const duplicate = await call(me, "POST", { termsAccepted: true, termsVersion: "1.0" }, { cookie: legacyCookie });
    const count3 = await query("SELECT count(*)::int AS n FROM terms_acceptances WHERE user_id = $1", [userId]);
    check("seconde acceptation sans doublon",
      duplicate.status === 200 && count3.rows[0].n === 1,
      { body: duplicate.body, n: count3.rows[0].n });

    console.log("\n[6bis] Concurrence et unicité");
    await query("DELETE FROM terms_acceptances WHERE user_id = $1", [userId]);
    const [raceA, raceB] = await Promise.all([
      call(me, "POST", { termsAccepted: true, termsVersion: "1.0" }, { cookie: legacyCookie, "x-forwarded-for": IP }),
      call(me, "POST", { termsAccepted: true, termsVersion: "1.0" }, { cookie: legacyCookie, "x-forwarded-for": IP })
    ]);
    const raced = await query("SELECT count(*)::int AS n FROM terms_acceptances WHERE user_id = $1", [userId]);
    check("deux acceptations simultanées → 200", raceA.status === 200 && raceB.status === 200, [raceA.body, raceB.body]);
    check("une seule preuve malgré la course", raced.rows[0].n === 1, raced.rows);
    check("une requête signale l'existant",
      (raceA.body.alreadyAccepted === false && raceB.body.alreadyAccepted === true) ||
      (raceA.body.alreadyAccepted === true && raceB.body.alreadyAccepted === false),
      [raceA.body, raceB.body]);

    const uniqueIdx = await query("SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_terms_user_version'");
    check("index unique présent",
      uniqueIdx.rows.length === 1 && /UNIQUE/i.test(uniqueIdx.rows[0].indexdef),
      uniqueIdx.rows);

    let duplicateRejected = false;
    try {
      await query(
        "INSERT INTO terms_acceptances (user_id, document_type, document_version) VALUES ($1, 'SHIPPER_TERMS', '1.0')",
        [userId]
      );
    } catch (e) {
      duplicateRejected = /duplicate key|unique/i.test(e.message);
    }
    check("doublon direct rejeté par la base", duplicateRejected);

    console.log("\n[7] Compte plateforme non soumis");
    const comp = await query("INSERT INTO companies (legal_name, status) VALUES ($1, 'ACTIVE') RETURNING company_id", [`Plateforme ${stamp}`]);
    platformCompanyId = comp.rows[0].company_id;
    const pUser = await query(
      `INSERT INTO users (company_id, first_name, last_name, email, password_hash, role, status)
       VALUES ($1, 'Admin', 'Plateforme', $2, $3, 'PLATFORM_ADMIN', 'ACTIVE') RETURNING user_id`,
      [platformCompanyId, platformEmail, await hashPassword(pw)]
    );
    platformUserId = pUser.rows[0].user_id;
    const platformLogin = await call(login, "POST", { email: platformEmail, password: pw }, { "x-forwarded-for": IP });
    check("connexion sans acceptation → 200", platformLogin.status === 200, platformLogin.body);
    const platformProof = await query("SELECT 1 FROM terms_acceptances WHERE user_id = $1", [platformUserId]);
    check("aucune preuve créée", platformProof.rows.length === 0, platformProof.rows);
    const platformMe = await call(me, "GET", null, { cookie: extractCookie(platformLogin.headers) });
    check("/me sans exigence pour la plateforme", platformMe.status === 200 && platformMe.body.terms === null, platformMe.body);
  } finally {
    await cleanup();
    await getPool().end();
  }

  console.log(`\n${pass} contrôle(s) OK, ${fail} échec(s).`);
  process.exit(fail ? 1 : 0);
})();
