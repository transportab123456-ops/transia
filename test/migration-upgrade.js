/* ============================================================
   Transia — test/migration-upgrade.js
   Vérifie la mise à niveau d'une base DÉJÀ PEUPLÉE par les
   incréments 4 et 5 (preuves CGU) de db/schema.sql.

   Déroulé :
     1. réinitialise le schéma public (base locale uniquement) ;
     2. applique le schéma complet, puis le RÉTROGRADE à l'état
        d'avant : ni index unique, ni trigger d'immuabilité, mais
        l'ancien index de lecture idx_terms_lookup ; l'ancienne
        table acceptait donc des doublons ;
     3. insère des preuves en double (même compte, même document,
        même version) et des données dans d'autres tables ;
     4. lance `npm run migrate` et vérifie que les doublons sont
        ramenés à la plus ancienne preuve, que l'index unique est
        créé, que idx_terms_lookup disparaît, qu'aucune autre table
        ne bouge ;
     5. rejoue db/schema.sql tel quel : sortie (stdout et stderr)
        IDENTIQUE au premier passage, code 0, aucune écriture —
        toute migration future non idempotente casse ici ;
     6. supprime ses comptes et preuves de test (schéma migré
        conservé), y compris si un contrôle échoue.

   La base est vidée : par sécurité, le test refuse toute base qui
   contient déjà des données, métier ou de référentiel (ALLOW_RESET=1
   pour passer outre), ainsi que toute base non locale.

   Usage :
     DATABASE_URL=postgresql://postgres:...@127.0.0.1:PORT/transia \
       node test/migration-upgrade.js
   Code de sortie 0 = tous les contrôles passent.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { Client } = require("pg");
const { requireDatabaseUrl } = require("../db/env");

const { url } = requireDatabaseUrl();
if (!/localhost|127\.0\.0\.1/.test(url)) {
  console.error("Ce test réinitialise le schéma public : base locale uniquement.");
  process.exit(2);
}

const ROOT = path.join(__dirname, "..");
const SCHEMA = fs.readFileSync(path.join(ROOT, "db", "schema.sql"), "utf8");
const TEST_EMAIL = "migration.upgrade@transia.test";

let pass = 0;
let failCount = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else {
    failCount++;
    console.log("  ✗ " + label + (extra !== undefined ? " → " + JSON.stringify(extra).slice(0, 400) : ""));
  }
}

/* Empreinte de chaque table : nombre de lignes + md5 des lignes
   ordonnées. Deux empreintes identiques = aucune écriture. */
async function snapshot(client, skip) {
  const list = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1"
  );
  const map = {};
  for (const row of list.rows) {
    if (skip.includes(row.tablename)) continue;
    const r = await client.query(
      `SELECT count(*)::text || ':' ||
              coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), 'vide') AS h
         FROM "${row.tablename}" x`
    );
    map[row.tablename] = r.rows[0].h;
  }
  return map;
}

function diff(before, after) {
  const keys = new Set(Object.keys(before).concat(Object.keys(after)));
  return [...keys].filter((k) => before[k] !== after[k]);
}

/* `npm run migrate` tel quel, avec la base du test imposée. */
function migrate() {
  return spawnSync("npm run migrate --silent", {
    cwd: ROOT,
    env: Object.assign({}, process.env, { DATABASE_URL: url }),
    encoding: "utf8",
    shell: true
  });
}

(async () => {
  const client = new Client({ connectionString: url });
  await client.connect();
  const one = async (sql, params) => (await client.query(sql, params)).rows[0];
  const termsHash = async () => (await one(
    "SELECT count(*)::text || ':' || md5(string_agg(x::text,'|' ORDER BY x::text)) AS h FROM terms_acceptances x"
  )).h;
  let companyId = null;

  /* Nettoyage rejouable : les preuves tombent avec les comptes
     (ON DELETE CASCADE), puis l'entreprise. Silencieux si le schéma
     n'existe pas encore ou plus. */
  async function cleanup() {
    if (!companyId) return;
    try {
      await client.query("DELETE FROM users WHERE company_id = $1", [companyId]);
      await client.query("DELETE FROM companies WHERE company_id = $1", [companyId]);
    } catch (e) { /* rien à nettoyer */ }
    companyId = null;
  }

  try {
    /* ---------- 0. Sécurité : aucune donnée à perdre ----------
       Toutes les tables publiques sont inspectées, pas seulement les
       comptes : un référentiel (pays, devises…) ou des données métier
       (RFQ, offres…) ont autant de valeur qu'un utilisateur. Une base
       simplement migrée est vide, le schéma n'insère rien. */
    const existing = await client.query(
      `SELECT c.relname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY 1`
    );
    const counts = await Promise.all(existing.rows.map(async (t) => {
      const n = (await one(`SELECT count(*)::int AS n FROM "${t.relname}"`)).n;
      return n > 0 ? t.relname + " (" + n + ")" : null;
    }));
    const nonEmpty = counts.filter(Boolean);
    if (nonEmpty.length && process.env.ALLOW_RESET !== "1") {
      console.error(
        "Base non vide — ce test réinitialise le schéma public : " +
        nonEmpty.slice(0, 6).join(", ") + (nonEmpty.length > 6 ? ", …" : "") + ".\n" +
        "Utilisez une base dédiée, ou ALLOW_RESET=1 pour l'écraser volontairement."
      );
      process.exitCode = 2;
      return;
    }

    /* ---------- 1. Base repartie de zéro ---------- */
    console.log("\n[1] Réinitialisation du schéma public");
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.query(SCHEMA);
    const tables = (await one(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'"
    )).n;
    check("schéma complet appliqué", tables >= 40, tables);

    /* ---------- 2. Rétrogradation à l'état d'avant ---------- */
    console.log("\n[2] Rétrogradation à l'état d'avant l'unicité");
    await client.query("DROP TRIGGER IF EXISTS trg_terms_acceptances_immutable ON terms_acceptances");
    await client.query("DROP INDEX IF EXISTS uq_terms_user_version");
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_terms_lookup ON terms_acceptances (user_id, document_type, document_version)"
    );
    const legacy = await one(
      `SELECT (SELECT count(*) FROM pg_indexes WHERE indexname='uq_terms_user_version') AS uniq,
              (SELECT count(*) FROM pg_indexes WHERE indexname='idx_terms_lookup') AS lookup,
              (SELECT count(*) FROM pg_trigger WHERE tgname='trg_terms_acceptances_immutable') AS trg`
    );
    check("état de départ : ni index unique ni trigger",
      legacy.uniq === "0" && legacy.trg === "0", legacy);
    check("ancien index de lecture présent", legacy.lookup === "1", legacy);

    /* ---------- 3. Données d'avant migration ---------- */
    console.log("\n[3] Données de test et doublons");
    companyId = (await one(
      `INSERT INTO companies (legal_name, main_email, status)
       VALUES ('Migration Upgrade SARL', $1, 'ACTIVE')
       RETURNING company_id`, [TEST_EMAIL]
    )).company_id;
    const newUser = async (email) => (await one(
      `INSERT INTO users (company_id, first_name, last_name, email, password_hash, role, status)
       VALUES ($1,'Ancien','Compte',$2,'x','SHIPPER_USER','ACTIVE')
       RETURNING user_id`, [companyId, email]
    )).user_id;
    const u1 = await newUser("migration.u1@transia.test");
    const u2 = await newUser("migration.u2@transia.test");

    const newProof = async (userId, documentType, acceptedAt, ip, context) => one(
      `INSERT INTO terms_acceptances
         (user_id, company_id, document_type, document_version, accepted_at, ip_address, user_agent, context)
       VALUES ($1,$2,$3,'1.0',$4,$5,'legacy',$6)
       RETURNING acceptance_id, accepted_at`,
      [userId, companyId, documentType, acceptedAt, ip, context]
    );

    /* La plus ancienne preuve de u1, puis son doublon (autre contexte,
       IP différente, horodatage plus récent) : la migration doit garder
       la première et supprimer la seconde. */
    const first = await newProof(u1, "SHIPPER_TERMS", "2026-01-01T10:00:00Z", "203.0.113.1", "REGISTRATION");
    await newProof(u1, "SHIPPER_TERMS", "2026-02-01T10:00:00Z", "203.0.113.3", "REACCEPTANCE");
    /* Clé distincte et document différent : ne doivent pas être touchés. */
    const other = await newProof(u2, "SHIPPER_TERMS", "2026-01-02T10:00:00Z", "203.0.113.2", "REGISTRATION");
    const carrier = await newProof(u1, "CARRIER_TERMS", "2026-01-03T10:00:00Z", "203.0.113.4", "REGISTRATION");

    check("4 preuves posées, dont 1 doublon",
      (await one("SELECT count(*)::int AS n FROM terms_acceptances")).n === 4);
    const snapshotBefore = await snapshot(client, ["terms_acceptances"]);

    /* ---------- 4. Migration ---------- */
    console.log("\n[4] npm run migrate");
    const run1 = migrate();
    check("premier passage : code 0", run1.status === 0, (run1.stderr || "").slice(0, 300));
    check("premier passage : schéma à jour annoncé",
      /Schéma à jour/.test(run1.stdout || ""), (run1.stdout || "").slice(-200));
    check("premier passage : index unique signalé",
      /uq_terms_user_version: true/.test(run1.stdout || ""), (run1.stdout || "").slice(-200));

    /* ---------- 5. Doublons réduits à la plus ancienne preuve ---------- */
    console.log("\n[5] Effet sur les preuves");
    const remaining = await client.query(
      `SELECT acceptance_id, ip_address, context, accepted_at
         FROM terms_acceptances
        WHERE user_id = $1 AND document_type = 'SHIPPER_TERMS' AND document_version = '1.0'
        ORDER BY acceptance_id`, [u1]
    );
    const kept = remaining.rows[0] || {};
    check("un seul doublon restant pour la clé en double", remaining.rows.length === 1, remaining.rows.length);
    check("la preuve conservée est la plus ancienne (id minimal)",
      kept.acceptance_id === first.acceptance_id, { garde: kept.acceptance_id, attendu: first.acceptance_id });
    check("son contenu est intact (IP, contexte, horodatage)",
      kept.ip_address === "203.0.113.1" && kept.context === "REGISTRATION" &&
      new Date(kept.accepted_at).toISOString() === new Date(first.accepted_at).toISOString(),
      kept);
    check("le doublon supprimé ne laisse aucune trace",
      (await one("SELECT count(*)::int AS n FROM terms_acceptances WHERE ip_address='203.0.113.3'")).n === 0);

    const survivors = await client.query("SELECT acceptance_id FROM terms_acceptances ORDER BY acceptance_id");
    check("clé distincte préservée", survivors.rows.some((r) => r.acceptance_id === other.acceptance_id));
    check("document différent préservé", survivors.rows.some((r) => r.acceptance_id === carrier.acceptance_id));
    check("total : 3 preuves", survivors.rows.length === 3, survivors.rows.length);

    /* ---------- 6. Index et trigger ---------- */
    console.log("\n[6] Index et trigger");
    const indexes = (await client.query(
      `SELECT i.relname, ix.indisunique, pg_get_indexdef(ix.indexrelid) AS def
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_class t ON t.oid = ix.indrelid
        WHERE t.relname = 'terms_acceptances'`
    )).rows;
    const unique = indexes.find((r) => r.relname === "uq_terms_user_version");
    check("index unique créé", !!unique && unique.indisunique === true, indexes.map((r) => r.relname));
    check("il porte sur (user_id, document_type, document_version)",
      !!unique && /\(user_id, document_type, document_version\)/.test(unique.def), unique && unique.def);
    check("idx_terms_lookup supprimé",
      !indexes.some((r) => r.relname === "idx_terms_lookup"), indexes.map((r) => r.relname));
    check("trigger d'immuabilité posé",
      (await one("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='trg_terms_acceptances_immutable' AND NOT tgisinternal")).n === 1);

    /* ---------- 7. Aucune autre table modifiée ---------- */
    console.log("\n[7] Autres tables");
    const snapshotAfter = await snapshot(client, ["terms_acceptances"]);
    const changed = diff(snapshotBefore, snapshotAfter);
    check("aucune autre table n'a bougé", changed.length === 0, changed);

    /* ---------- 8. Rejouabilité ----------
       db/schema.sql est rejoué tel quel sur la base déjà migrée : même
       code de sortie, même stdout, même stderr, aucune écriture. Une
       migration future non idempotente (CREATE sans IF NOT EXISTS,
       trigger recréé sans DROP, index en double…) fait échouer
       `npm run migrate` ici, donc `npm test` aussi. */
    console.log("\n[8] Second passage");
    const termsBefore = await termsHash();
    const run2 = migrate();
    check("second passage : code 0", run2.status === 0, (run2.stderr || "").slice(0, 300));
    check("second passage : db/schema.sql bien rejoué",
      /Application de db\/schema\.sql/.test(run2.stdout || ""), (run2.stdout || "").slice(-200));
    check("second passage : sortie identique au premier",
      run2.stdout === run1.stdout,
      { premier: (run1.stdout || "").slice(-300), second: (run2.stdout || "").slice(-300) });
    check("second passage : stderr identique au premier",
      (run2.stderr || "") === (run1.stderr || ""),
      { premier: (run1.stderr || "").slice(0, 300), second: (run2.stderr || "").slice(0, 300) });
    check("second passage : autres tables inchangées",
      diff(snapshotAfter, await snapshot(client, ["terms_acceptances"])).length === 0);
    const termsAfter = await termsHash();
    check("second passage : preuves inchangées", termsBefore === termsAfter, { termsBefore, termsAfter });
    check("second passage : index unique toujours là",
      (await one("SELECT count(*)::int AS n FROM pg_indexes WHERE indexname='uq_terms_user_version'")).n === 1);

    /* ---------- 9. Nettoyage ---------- */
    console.log("\n[9] Nettoyage des données de test");
    await cleanup();
    check("aucun compte de test restant",
      (await one("SELECT count(*)::int AS n FROM users WHERE email LIKE 'migration.%'")).n === 0);
    check("aucune entreprise de test restante",
      (await one("SELECT count(*)::int AS n FROM companies WHERE main_email = $1", [TEST_EMAIL])).n === 0);
    check("aucune preuve de test restante",
      (await one("SELECT count(*)::int AS n FROM terms_acceptances")).n === 0);
  } finally {
    await cleanup();
    await client.end();
  }

  console.log("\n" + pass + " contrôle(s) OK, " + failCount + " échec(s).");
  require("../tools/fin-de-suite")(__filename);
  if (failCount) process.exitCode = 1;
})().catch((err) => {
  console.error("ERREUR FATALE:", err.message);
  process.exit(1);
});
