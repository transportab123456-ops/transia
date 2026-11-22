/* ============================================================
   Transia — test/prod-smoke.js
   Vérification bout en bout contre la PRODUCTION (ou tout
   environnement) par HTTP : cycle complet
   donneur d'ordre → transporteur vérifié → offres → classement →
   acceptation → confirmation → affaire + commission.

   Le test fonctionne SANS accès direct à la base : tout le cycle,
   nettoyage compris, passe par l'API publique (POST /api/admin
   action=purge-smoke). Seul le contrôle du contenu de
   outbox_emails reste interne : sans DATABASE_URL il est signalé
   « ignoré » et le test continue.

   Usage :
     BASE_URL=https://transia-sooty.vercel.app \
     ADMIN_EMAIL=... ADMIN_PASSWORD=... \
     node test/prod-smoke.js

   Code de sortie 0 = tous les contrôles HTTP passent.
   ============================================================ */
"use strict";

const BASE = process.env.BASE_URL || "https://transia-sooty.vercel.app";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error("ADMIN_EMAIL et ADMIN_PASSWORD requis.");
  process.exit(2);
}

/* Accès base FACULTATIF. Il ne sert qu'à lire l'outbox et à
   supprimer les données de test : le cycle métier n'en dépend pas. */
let dbQuery = null;
if (process.env.DATABASE_URL) {
  try {
    dbQuery = require("../api/_lib/db").query;
  } catch (e) {
    dbQuery = null;
  }
}
const HAS_DB = typeof dbQuery === "function";

let pass = 0, failCount = 0, skipped = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { failCount++; console.log("  ✗ " + label + (extra !== undefined ? " → " + JSON.stringify(extra).slice(0, 300) : "")); }
}
function skip(label, why) {
  skipped++;
  console.log("  – " + label + " (ignoré : " + why + ")");
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
  /* Identifiants collectés pour le seul affichage de secours si la
     purge échoue : le nettoyage lui-même passe par l'API. */
  const idsToDelete = { companies: [], users: [] };

  console.log(`\nCible : ${BASE}`);
  console.log(`Accès base directe : ${HAS_DB ? "oui (outbox + nettoyage)" : "non (HTTP seul)"}`);

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

  /* Deux modes possibles selon la configuration du serveur :
     - transport e-mail actif → requiresEmailVerification, le compte
       s'active par le jeton contenu dans l'e-mail (outbox) ;
     - sans transport → compte actif, e-mail de bienvenue journalisé
       (statut LOGGED, jamais envoyé).
     Le jeton n'existe que dans outbox_emails : sans DATABASE_URL,
     ce mode ne peut pas être exercé (on s'arrête plutôt que de
     poursuivre avec un compte non activable). */
  if (reg.body.requiresEmailVerification) {
    if (!HAS_DB) {
      console.error(
        "\nVérification e-mail exigée sur cet environnement, et le jeton n'est lisible que dans outbox_emails.\n" +
        "Relancez avec DATABASE_URL défini (ou REQUIRE_EMAIL_VERIFY=false sur cet environnement)."
      );
      process.exit(2);
    }
    const vmail = await dbQuery(
      `SELECT body_text FROM outbox_emails
        WHERE recipient_email = $1 AND event_type = 'email_verification'
        ORDER BY email_id DESC LIMIT 1`,
      [sEmail]
    );
    const m = vmail.rows.length ? String(vmail.rows[0].body_text).match(/verify=([a-f0-9]{64})/) : null;
    check("e-mail de vérification émis + jeton récupérable", !!m, vmail.rows[0] && String(vmail.rows[0].body_text).slice(0, 120));
    if (m) {
      const ver = await shipper("POST", "/api/auth/tokens", { token: m[1] });
      check("vérification → session ouverte", ver.status === 200 && ver.body.verified === true, ver.body);
    }
  } else {
    if (HAS_DB) {
      const outbox = await dbQuery(
        `SELECT event_type, status, recipient_email FROM outbox_emails
          WHERE recipient_email = $1 ORDER BY email_id DESC LIMIT 1`,
        [sEmail]
      );
      check("outbox : e-mail de bienvenue journalisé", outbox.rows.length === 1 && outbox.rows[0].event_type === "welcome" && ["LOGGED", "SENT", "PENDING"].includes(outbox.rows[0].status), outbox.rows[0]);
    } else {
      skip("outbox : e-mail de bienvenue journalisé", "DATABASE_URL absent, outbox non interrogeable par HTTP");
    }

    const resend = await shipper("POST", "/api/auth/tokens", { action: "resend", email: sEmail });
    check("renvoi vérification : réponse générique 200", resend.status === 200 && !!resend.body.message, resend.body);
  }

  const flushOpen = await fetch(BASE + "/api/health?flush=emails");
  check("drain outbox protégé (401 sans secret)", flushOpen.status === 401, flushOpen.status);

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

  /* ---------- 5. Marketplace aveugle ---------- */
  console.log("\n[5] Marketplace (aveuglement)");
  const market = await carriers[0].client("GET", "/api/marketplace");
  check("marketplace 200", market.status === 200, market.body);
  const mStr = JSON.stringify(market.body);
  check("RFQ présente", mStr.includes(rfqNum || "@@@"), market.body.count);
  check("pas d'identité shipper", !mStr.includes("Smoke Industrie") && !mStr.includes("smoke-shipper"));
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

  const qB = await carriers[1].client("POST", "/api/quotes", {
    rfqNumber: rfqNum, currency: "EUR", baseTransportPrice: 2180, feesToSpecify: true,
    transitTimeValue: 6, transitTimeUnit: "day", validUntil: "2026-12-18",
    conditions: "Franco départ. Frais de manutention à préciser."
  });
  check("offre B A_VERIFIER", qB.status === 201 && qB.body.quote.compliance_status === "A_VERIFIER", qB.body);

  const qC = await carriers[2].client("POST", "/api/quotes", {
    rfqNumber: rfqNum, currency: "USD", baseTransportPrice: 2500, mandatoryFeesTotal: 140,
    transitTimeValue: 4, transitTimeUnit: "day", validUntil: "2026-12-22",
    conditions: "Port payé. Frais de dossier 140 USD."
  });
  check("offre C CONFORME (USD normalisé)", qC.status === 201 && qC.body.quote.compliance_status === "CONFORME", qC.body);
  check("comparable C calculé ≈ 2429 EUR", qC.body.quote && Math.abs(qC.body.quote.comparable_total - 2429) <= 2, qC.body.quote);

  /* ---------- 7. Classement ---------- */
  console.log("\n[7] Classement + recommandation");
  const rank = await admin("POST", "/api/recommendations", { rfqNumber: rfqNum });
  check("classement calculé", rank.status === 200, rank.body);
  check("stats 1 conforme + 1 à vérifier + 1 conforme(USD)", rank.body.stats && rank.body.stats.conforme === 2 && rank.body.stats.aVerifier === 1, rank.body.stats);
  check("n°1 = offre A (2350 EUR)", rank.body.recommended && rank.body.recommended.comparable_total === 2350, rank.body.recommended);

  const reco = await shipper("GET", `/api/recommendations?rfq=${rfqNum}`);
  check("client voit la reco validée", reco.status === 200 && reco.body.validated === true, reco.body);

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
  check("commission barème dégressif de 2350 → 181", conf.body.deal && conf.body.deal.commission_amount === 181, conf.body.deal);
  /* L'API ne renvoie pas deal_id (seulement deal_number) : le
     nettoyage passe par la purge admin, pas par des identifiants. */

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
  /* La purge passe par l'API : même chemin avec ou sans
     DATABASE_URL, et elle couvre aussi les runs interrompus. */
  const dry = await admin("POST", "/api/admin", { action: "purge-smoke", dryRun: true });
  check("purge : inventaire à blanc",
    dry.status === 200 && dry.body.dryRun === true && dry.body.scope && dry.body.scope.companies >= 4,
    dry.body);

  const purge = await admin("POST", "/api/admin", { action: "purge-smoke", confirm: "PURGE-SMOKE" });
  check("purge exécutée",
    purge.status === 200 && purge.body.deleted && purge.body.deleted.companies >= 4,
    purge.body);

  const after = await admin("POST", "/api/admin", { action: "purge-smoke", dryRun: true });
  check("purge idempotente (périmètre vide)",
    after.status === 200 && after.body.scope && after.body.scope.companies === 0,
    after.body);

  if (purge.status !== 200) {
    console.log("  À purger manuellement :");
    console.log("    comptes     : " + [sEmail, ...[0, 1, 2].map((i) => `smoke-carrier${i}-${stamp}@example.fr`)].join(", "));
    console.log("    entreprises : " + (idsToDelete.companies.filter(Boolean).join(", ") || "inconnues"));
    console.log("    utilisateurs: " + (idsToDelete.users.filter(Boolean).join(", ") || "inconnus"));
    console.log("    RFQ         : " + (rfqNum || "aucune"));
    console.log("    affaire     : " + ((conf.body.deal || {}).deal_number || "aucune"));
  }

  console.log("\n----------------------------------------");
  console.log(`Résultat production : ${pass} succès, ${failCount} échec(s), ${skipped} ignoré(s)`);
  process.exit(failCount === 0 ? 0 : 1);
})().catch((e) => { console.error("ERREUR FATALE:", e); process.exit(1); });
