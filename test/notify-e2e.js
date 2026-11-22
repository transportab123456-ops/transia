/* ============================================================
   Transia — test/notify-e2e.js
   Test end-to-end des NOTIFICATIONS TRANSACTIONNELLES et de la
   VÉRIFICATION D'E-MAIL contre la PostgreSQL locale :

   - inscription → statut PENDING_EMAIL, aucun e-mail réel sorti
     (mode log : le corps est journalisé dans outbox_emails)
   - login bloqué tant que non vérifié, puis vérification par jeton
   - renvoi de lien (l'ancien jeton est révoqué)
   - outbox du cycle complet : rfq_created, quote_received,
     recommendation_ready, quote_accepted, deal_confirmed,
     carrier_decision
   - déduplication (ON CONFLICT sur dedupe_key)
   - endpoint cron : secret exigé

   Usage : DATABASE_URL=... node test/notify-e2e.js
   ============================================================ */
"use strict";

const { PassThrough, Writable } = require("stream");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE manquant.");
  process.exit(2);
}

/* Force la vérification d'e-mail même sans transport configuré :
   les e-mails partent alors en mode log (statut LOGGED), leur corps
   restant lisible dans outbox_emails pour le test. */
process.env.REQUIRE_EMAIL_VERIFY = "true";
process.env.CRON_SECRET = "cron-secret-de-test";

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
  const m = arr.join(";").match(/transia_session=([^;]+)/);
  return m ? "transia_session=" + m[1] : null;
}

const register = require("../api/auth/register");
const login = require("../api/auth/login");
const verifyEmail = require("../api/auth/tokens");
const carriers = require("../api/carriers");
const rfqs = require("../api/rfqs");
const quotes = require("../api/quotes");
const recommendations = require("../api/recommendations");
const deals = require("../api/deals");
const admin = require("../api/admin");
const flushCron = require("../api/health"); /* ?flush=emails : drain outbox */
const { query } = require("../api/_lib/db");
const { hashPassword } = require("../api/_lib/auth");
const { enqueueEmail } = require("../api/_lib/notify");
const { getPool } = require("../api/_lib/db");

/* Dernier e-mail d'un destinataire pour un événement donné */
async function lastMail(to, eventType) {
  const r = await query(
    `SELECT * FROM outbox_emails
      WHERE recipient_email = $1 AND event_type = $2
      ORDER BY email_id DESC LIMIT 1`,
    [to, eventType]
  );
  return r.rows[0] || null;
}
async function countMail(eventType, to) {
  const r = await query(
    `SELECT count(*)::int AS n FROM outbox_emails
      WHERE event_type = $1 AND ($2::text IS NULL OR recipient_email = $2)`,
    [eventType, to || null]
  );
  return r.rows[0].n;
}
function tokenFrom(mail) {
  const m = String(mail.body_text || "").match(/verify=([a-f0-9]{64})/);
  return m ? m[1] : null;
}

(async () => {
  const stamp = Date.now();
  const pw = "motdepasse-test-2026";

  /* ============================================================
     [1] Inscription avec vérification exigée
     ============================================================ */
  console.log("\n[1] Inscription → PENDING_EMAIL + e-mail de vérification");
  const email = `notify-shipper-${stamp}@example.fr`;
  const reg = await call(register, "POST", {
    email, password: pw,
    firstName: "Nadia", lastName: "Notify", companyName: `Notify ${stamp}`, countryCode: "FR",
    termsAccepted: true, termsVersion: "1.0"
  });
  check("201 avec requiresEmailVerification", reg.status === 201 && reg.body.requiresEmailVerification === true, reg.body);
  check("aucune session ouverte (pas de cookie)", !extractCookie(reg.headers));

  const u = await query(`SELECT user_id, status FROM users WHERE email = $1`, [email]);
  check("statut PENDING_EMAIL en base", u.rows[0] && u.rows[0].status === "PENDING_EMAIL", u.rows[0]);

  const verifyMail = await lastMail(email, "email_verification");
  check("e-mail de vérification dans l'outbox", !!verifyMail, null);
  check("outbox : mode log (pas d'envoi réel, statut LOGGED)", verifyMail && verifyMail.status === "LOGGED", verifyMail && verifyMail.status);
  check("destinataire + objet en français", !!verifyMail && verifyMail.recipient_email === email && /confirmez/i.test(verifyMail.subject), verifyMail && verifyMail.subject);

  const token = verifyMail ? tokenFrom(verifyMail) : null;
  check("jeton présent dans le corps (lien de vérification)", !!token);

  /* ============================================================
     [2] Login bloqué tant que non vérifié
     ============================================================ */
  console.log("\n[2] Login bloqué / renvoi / vérification");
  const blocked = await call(login, "POST", { email, password: pw });
  check("login → 403 EMAIL_NOT_VERIFIED", blocked.status === 403 && blocked.body.code === "EMAIL_NOT_VERIFIED", blocked.body);

  const wrongPw = await call(login, "POST", { email, password: "mauvais-mdp-ici" });
  check("mauvais mot de passe → 401 (pas d'énumération)", wrongPw.status === 401, wrongPw.body);

  const resend = await call(verifyEmail, "POST", { action: "resend", email });
  check("renvoi accepté (réponse générique)", resend.status === 200 && !!resend.body.message, resend.body);
  const newMail = await lastMail(email, "email_verification");
  const newToken = newMail ? tokenFrom(newMail) : null;
  check("nouveau jeton émis", !!newToken && newToken !== token);

  const oldTokenTry = await call(verifyEmail, "POST", { token });
  check("ancien jeton révoqué → 400", oldTokenTry.status === 400, oldTokenTry.body);

  const verified = await call(verifyEmail, "POST", { token: newToken });
  check("vérification → 200 + session", verified.status === 200 && verified.body.verified === true && !!extractCookie(verified.headers), verified.body);
  const u2 = await query(`SELECT status, email_verified_at FROM users WHERE email = $1`, [email]);
  check("statut ACTIVE + email_verified_at", u2.rows[0].status === "ACTIVE" && !!u2.rows[0].email_verified_at, u2.rows[0]);

  const usedAgain = await call(verifyEmail, "POST", { token: newToken });
  check("jeton déjà utilisé → 400", usedAgain.status === 400, usedAgain.body);

  const shipperCookie = extractCookie(verified.headers);
  const loginOk = await call(login, "POST", { email, password: pw });
  check("login désormais autorisé", loginOk.status === 200, loginOk.body);

  /* resend sur un compte déjà actif : réponse générique, pas d'e-mail */
  const before = await countMail("email_verification", email);
  const resendActive = await call(verifyEmail, "POST", { action: "resend", email });
  const after = await countMail("email_verification", email);
  check("resend sur compte actif : rien n'est envoyé", resendActive.status === 200 && after === before, { after, before });

  /* ============================================================
     [3] Cycle complet → outbox de chaque étape
     ============================================================ */
  console.log("\n[3] Notifications du cycle métier");

  /* Admin plateforme + transporteur */
  const adminEmail = `notify-admin-${stamp}@example.fr`;
  const adminHash = await hashPassword(pw);
  const adminCo = await query(`INSERT INTO companies (legal_name, status) VALUES ('Transia Notif', 'ACTIVE') RETURNING company_id`);
  await query(
    `INSERT INTO users (company_id, first_name, last_name, email, password_hash, role, status)
     VALUES ($1,'Admin','Notif',$2,$3,'SUPER_ADMIN','ACTIVE')`,
    [adminCo.rows[0].company_id, adminEmail, adminHash]
  );

  const carrierEmail = `notify-carrier-${stamp}@example.fr`;
  const car = await call(carriers, "POST", {
    companyName: `Transporteur Notif ${stamp}`, countryCode: "FR",
    email: carrierEmail, password: pw,
    firstName: "Marc", lastName: "Notif", modes: ["ROAD"],
    termsAccepted: true, termsVersion: "1.0"
  });
  check("transporteur inscrit (PENDING_EMAIL)", car.status === 201 && car.body.requiresEmailVerification === true, car.body);

  const carMail = await lastMail(carrierEmail, "email_verification");
  const carToken = carMail ? tokenFrom(carMail) : null;
  const carVerified = await call(verifyEmail, "POST", { token: carToken });
  check("transporteur vérifié e-mail → session", carVerified.status === 200, carVerified.body);
  const carrierCookie = extractCookie(carVerified.headers);
  const carrierCompanyId = car.body.company.company_id;

  const adminLogin = await call(login, "POST", { email: adminEmail, password: pw });
  const adminCookie = extractCookie(adminLogin.headers);

  const v = await call(admin, "POST", { action: "verify", companyId: carrierCompanyId, decision: "VERIFIED" }, { cookie: adminCookie });
  check("vérification transporteur → 200", v.status === 200, v.body);
  const decisionMail = await lastMail(carrierEmail, "carrier_decision");
  check("e-mail carrier_decision envoyé", !!decisionMail && /vérifié/i.test(decisionMail.subject), decisionMail && decisionMail.subject);

  /* RFQ */
  const rfqRes = await call(rfqs, "POST", {
    originCity: "Lille", originCountry: "FR",
    destinationCity: "Tanger", destinationCountry: "MA",
    mode: "ROAD", cargoDescription: "Bacs", grossWeight: 900
  }, { cookie: shipperCookie });
  check("RFQ créée", rfqRes.status === 201, rfqRes.body);
  const rfqNum = rfqRes.body.rfq.rfq_number;

  const createdMail = await lastMail(email, "rfq_created");
  check("e-mail rfq_created au donneur", !!createdMail && createdMail.body_text.includes(rfqNum), createdMail && createdMail.body_text.slice(0, 120));
  check("rfq_created : aucun montant d'offre", !/\d{3,}\s*€/.test(createdMail ? createdMail.body_text : ""));

  /* Offre */
  const q = await call(quotes, "POST", {
    rfqNumber: rfqNum, currency: "EUR", baseTransportPrice: 1500,
    transitTimeValue: 4, transitTimeUnit: "day"
  }, { cookie: carrierCookie });
  check("offre déposée", q.status === 201, q.body);

  const quoteMail = await lastMail(email, "quote_received");
  check("e-mail quote_received au donneur", !!quoteMail, null);
  check("quote_received : prix masqué (aveuglement)", quoteMail && !quoteMail.body_text.includes("1500"), quoteMail && quoteMail.body_text);

  const adminQuoteMail = await lastMail(adminEmail, "quote_received_admin");
  check("e-mail quote_received_admin à la plateforme", !!adminQuoteMail && adminQuoteMail.body_text.includes(rfqNum), null);

  /* Recommandation */
  const rank = await call(recommendations, "POST", { rfqNumber: rfqNum }, { cookie: adminCookie });
  check("recommandation validée", rank.status === 200 && rank.body.status === "VALIDATED", rank.body);
  const recoMail = await lastMail(email, "recommendation_ready");
  check("e-mail recommendation_ready au donneur", !!recoMail && recoMail.body_text.includes(rfqNum), null);

  /* Acceptation → transporteur pressenti */
  const accept = await call(deals, "POST", { action: "accept", rfqNumber: rfqNum }, { cookie: shipperCookie });
  check("acceptation → 201", accept.status === 201, accept.body);
  const acceptedMail = await lastMail(carrierEmail, "quote_accepted");
  check("e-mail quote_accepted au transporteur", !!acceptedMail && /48 heures/.test(acceptedMail.body_text), acceptedMail && acceptedMail.body_text.slice(0, 200));

  /* Confirmation → les deux parties */
  const confirm = await call(deals, "POST", { action: "confirm", acceptanceId: accept.body.acceptance_id, rfqNumber: rfqNum }, { cookie: carrierCookie });
  check("confirmation → affaire", confirm.status === 201, confirm.body);
  const dealNumber = confirm.body.deal.deal_number;
  const dealMailShipper = await lastMail(email, "deal_confirmed");
  const dealMailCarrier = await lastMail(carrierEmail, "deal_confirmed");
  check("deal_confirmed au donneur (n° d'affaire + commission)", !!dealMailShipper && dealMailShipper.body_text.includes(dealNumber) && /120[,\s]/.test(dealMailShipper.body_text) && /8\s*%/.test(dealMailShipper.body_text), dealMailShipper && dealMailShipper.body_text);
  check("deal_confirmed au transporteur", !!dealMailCarrier && dealMailCarrier.body_text.includes(dealNumber), null);

  /* Suspension → décision notifiée */
  const susp = await call(admin, "POST", { action: "verify", companyId: carrierCompanyId, decision: "SUSPENDED", reason: "Assurance expirée (test notif)" }, { cookie: adminCookie });
  check("suspension → 200", susp.status === 200, susp.body);
  const suspMail = await lastMail(carrierEmail, "carrier_decision");
  check("e-mail carrier_decision (suspension + motif)", !!suspMail && /suspendu/i.test(suspMail.subject) && suspMail.body_text.includes("Assurance expirée"), suspMail && suspMail.subject);

  /* ============================================================
     [4] Garanties outbox
     ============================================================ */
  console.log("\n[4] Garanties outbox (transactionnalité, dédup, cron)");

  /* Transactionnalité : un rollback ne laisse AUCUN e-mail */
  const pool = getPool();
  const client = await pool.connect();
  let ghost = null;
  try {
    await client.query("BEGIN");
    await enqueueEmail(client, {
      dedupeKey: "ghost-test-" + stamp,
      eventType: "welcome", to: `ghost-${stamp}@example.fr`,
      vars: { firstName: "Fantome", companyName: "Societe Fantome" }
    });
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  const ghostRow = await query(`SELECT 1 FROM outbox_emails WHERE dedupe_key = $1`, ["ghost-test-" + stamp]);
  check("rollback → aucun e-mail fantôme", ghostRow.rows.length === 0);

  /* Déduplication : ON CONFLICT sur dedupe_key */
  const c2 = await pool.connect();
  let first = null, second = null;
  try {
    await c2.query("BEGIN");
    first = await enqueueEmail(c2, {
      dedupeKey: "dedupe-test-" + stamp,
      eventType: "welcome", to: email, userId: null,
      vars: { firstName: "Nadia", companyName: `Notify ${stamp}` }
    });
    second = await enqueueEmail(c2, {
      dedupeKey: "dedupe-test-" + stamp,
      eventType: "welcome", to: email, userId: null,
      vars: { firstName: "Nadia", companyName: `Notify ${stamp}` }
    });
    await c2.query("COMMIT");
  } finally {
    c2.release();
  }
  check("deuxième envoi avec même dedupe_key → ignoré", first !== null && second === null, { first, second });
  const dupes = await query(`SELECT count(*)::int AS n FROM outbox_emails WHERE dedupe_key = $1`, ["dedupe-test-" + stamp]);
  check("une seule ligne en base pour la clé", dupes.rows[0].n === 1, dupes.rows[0]);

  /* Aucune donnée sensible dans l'e-mail transporteur */
  check("quote_accepted ne contient pas l'adresse privée du donneur", !/République|Aïn Sebaâ/.test(acceptedMail ? acceptedMail.body_text : ""));

  /* Cron (health?flush=emails) : secret exigé */
  const cronNoAuth = await call(flushCron, "GET", { flush: "emails" });
  check("cron sans secret → 401", cronNoAuth.status === 401, cronNoAuth.body);
  const cronBad = await call(flushCron, "GET", { flush: "emails" }, { authorization: "Bearer mauvais" });
  check("cron mauvais secret → 401", cronBad.status === 401, cronBad.body);
  const cronOk = await call(flushCron, "GET", { flush: "emails" }, { authorization: "Bearer " + process.env.CRON_SECRET });
  check("cron valide → 200 + drained", cronOk.status === 200 && typeof cronOk.body.drained === "number", cronOk.body);
  const healthOk = await call(flushCron, "GET");
  check("health public inchangé (200 + db)", healthOk.status === 200 && healthOk.body.db && healthOk.body.db.ok === true, healthOk.body);

  const stuck = await query(`SELECT count(*)::int AS n FROM outbox_emails WHERE status IN ('SENDING') AND locked_at < now() - interval '1 minute'`);
  check("aucun verrou orphelin laissé", stuck.rows[0].n === 0, stuck.rows[0]);

  console.log("\n----------------------------------------");
  console.log(`Résultat : ${pass} succès, ${failCount} échec(s)`);
  process.exit(failCount === 0 ? 0 : 1);
})().catch((e) => { console.error("ERREUR FATALE:", e); process.exit(1); });
