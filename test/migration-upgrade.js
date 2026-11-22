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
     5. rejoue la migration : même résultat, aucune écriture.

   Usage (base jetable, locale) :
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

  try {
    /* ---------- 1. Base repartie de zéro ---------- */
    console.log("\n[1] Réinitialisation du schéma public");
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.query(SCHEMA);
    const tables = (await client.query(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'"
    )).rows[0].n;
    check("schéma complet appliqué", tables >= 40, tables);

    /* ---------- 2. Rétrogradation à l'état d'avant ---------- */
    console.log("\n[2] Rétrogradation à l'état d'avant l'unicité");
    await client.query("DROP TRIGGER IF EXISTS trg_terms_acceptances_immutable ON terms_acceptances");
    await client.query("DROP INDEX IF EXISTS uq_terms_user_version");
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_terms_lookup ON terms_acceptances (user_id, document_type, document_version)"
    );
    const legacy = await client.query(
      `SELECT (SELECT count(*) FROM pg_indexes WHERE indexname='uq_terms_user_version') AS uniq,
              (SELECT count(*) FROM pg_indexes WHERE indexname='idx_terms_lookup') AS lookup,
              (SELECT count(*) FROM pg_trigger WHERE tgname='trg_terms_acceptances_immutable') AS trg`
    );
    check("état de départ : ni index unique ni trigger",
      legacy.rows[0].uniq === "0" && legacy.rows[0].trg === "0", legacy.rows[0]);
    check("ancien index de lecture présent", legacy.rows[0].lookup === "1", legacy.rows[0]);

    /* ---------- 3. Données d'avant migration ---------- */
    console.log("\n[3] Données de test et doublons");
    const co = await client.query(
      `INSERT INTO companies (legal_name, main_email, status)
       VALUES ('Migration Upgrade SARL', 'migration.upgrade@transia.test', 'ACTIVE')
       RETURNING company_id`
    );
    const companyId = co.rows[0].company_id;
    const u1 = (await client.query(
      `INSERT INTO users (company_id, first_name, last_name, email, password_hash, role, status)
       VALUES ($1,'Ancien','Compte1','migration.u1@transia.test','x','SHIPPER_USER','ACTIVE')
       RETURNING user_id`, [companyId]
    )).rows[0].user_id;
    const u2 = (await client.query(
      `INSERT INTO users (company_id, first_name, last_name, email, password_hash, role, status)
       VALUES ($1,'Ancien','Compte2','migration.u2@transia.test','x','SHIPPER_USER','ACTIVE')
       RETURNING user_id`, [companyId]
    )).rows[0].user_id;

    /* La plus ancienne preuve de u1, puis son doublon (autre contexte,
       IP différente, horodatage plus récent) : la migration doit garder
       la première et supprimer la seconde. */
    const first = (await client.query(
      `INSERT INTO terms_acceptances
         (user_id, company_id, document_type, document_version, accepted_at, ip_address, user_agent, context)
       VALUES ($1,$2,'SHIPPER_TERMS','1.0','2026-01-01T10:00:00Z','203.0.113.1','legacy/1','REGISTRATION')
       RETURNING acceptance_id, accepted_at`, [u1, companyId]
    )).rows[0];
    await client.query(
      `INSERT INTO terms_acceptances
         (user_id, company_id, document_type, document_version, accepted_at, ip_address, user_agent, context)
       VALUES ($1,$2,'SHIPPER_TERMS','1.0','2026-02-01T10:00:00Z','203.0.113.3','legacy/2','REACCEPTANCE')`,
      [u1, companyId]
    );
    /* Clé distincte : ne doit pas être touchée. */
    const other = (await client.query(
      `INSERT INTO terms_acceptances
         (user_id, company_id, document_type, document_version, accepted_at, ip_address, context)
       VALUES ($1,$2,'SHIPPER_TERMS','1.0','2026-01-02T10:00:00Z','203.0.113.2','REGISTRATION')
       RETURNING acceptance_id`, [u2, companyId]
    )).rows[0];
    /* Document différent : ne doit pas être touché non plus. */
    const carrier = (await client.query(
      `INSERT INTO terms_acceptances
         (user_id, company_id, document_type, document_version, accepted_at, ip_address, context)
       VALUES ($1,$2,'CARRIER_TERMS','1.0','2026-01-03T10:00:00Z','203.0.113.4','REGISTRATION')
       RETURNING acceptance_id`, [u1, companyId]
    )).rows[0];

    const before = await client.query("SELECT count(*)::int AS n FROM terms_acceptances");
    check("4 preuves posées, dont 1 doublon", before.rows[0].n === 4, before.rows[0]);
    const snapshotBefore = await snapshot(client, ["terms_acceptances"]);
    check("empreinte des autres tables relevée",
      Object.keys(snapshotBefore).length > 10, Object.keys(snapshotBefore).length);

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
    check("un seul doublon restant pour la clé en double",
      remaining.rows.length === 1, remaining.rows.length);
    const kept = remaining.rows[0] || {};
    check("la preuve conservée est la plus ancienne (id minimal)",
      kept.acceptance_id === first.acceptance_id, { garde: kept.acceptance_id, attendu: first.acceptance_id });
    check("son contenu est intact (IP, contexte, horodatage)",
      kept.ip_address === "203.0.113.1" && kept.context === "REGISTRATION" &&
      new Date(kept.accepted_at).toISOString() === new Date(first.accepted_at).toISOString(),
      kept);
    check("le doublon supprimé ne laisse aucune trace",
      (await client.query("SELECT count(*)::int AS n FROM terms_acceptances WHERE ip_address='203.0.113.3'")).rows[0].n === 0);

    const survivors = await client.query(
      "SELECT acceptance_id FROM terms_acceptances ORDER BY acceptance_id"
    );
    check("clé distincte préservée", survivors.rows.some((r) => r.acceptance_id === other.acceptance_id));
    check("document différent préservé", survivors.rows.some((r) => r.acceptance_id === carrier.acceptance_id));
    check("total : 3 preuves", survivors.rows.length === 3, survivors.rows.length);

    /* ---------- 6. Index et trigger ---------- */
    console.log("\n[6] Index et trigger");
    const idx = await client.query(
      `SELECT i.relname, ix.indisunique, pg_get_indexdef(ix.indexrelid) AS def
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_class t ON t.oid = ix.indrelid
        WHERE t.relname = 'terms_acceptances'`
    );
    const unique = idx.rows.find((r) => r.relname === "uq_terms_user_version");
    check("index unique créé", !!unique && unique.indisunique === true, idx.rows.map((r) => r.relname));
    check("il porte sur (user_id, document_type, document_version)",
      !!unique && /\(user_id, document_type, document_version\)/.test(unique.def), unique && unique.def);
    check("idx_terms_lookup supprimé",
      !idx.rows.some((r) => r.relname === "idx_terms_lookup"), idx.rows.map((r) => r.relname));
    check("trigger d'immuabilité posé",
      (await client.query(
        "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='trg_terms_acceptances_immutable' AND NOT tgisinternal"
      )).rows[0].n === 1);

    /* ---------- 7. Aucune autre table modifiée ---------- */
    console.log("\n[7] Autres tables");
    const snapshotAfter = await snapshot(client, ["terms_acceptances"]);
    const changed = diff(snapshotBefore, snapshotAfter);
    check("aucune autre table n'a bougé", changed.length === 0, changed);

    /* ---------- 8. Rejouabilité ---------- */
    console.log("\n[8] Second passage");
    const termsBefore = (await client.query(
      "SELECT count(*)::text || ':' || md5(string_agg(x::text,'|' ORDER BY x::text)) AS h FROM terms_acceptances x"
    )).rows[0].h;
    const run2 = migrate();
    check("second passage : code 0", run2.status === 0, (run2.stderr || "").slice(0, 300));
    const snapshotAgain = await snapshot(client, ["terms_acceptances"]);
    check("second passage : autres tables inchangées",
      diff(snapshotAfter, snapshotAgain).length === 0, diff(snapshotAfter, snapshotAgain));
    const termsAfter = (await client.query(
      "SELECT count(*)::text || ':' || md5(string_agg(x::text,'|' ORDER BY x::text)) AS h FROM terms_acceptances x"
    )).rows[0].h;
    check("second passage : preuves inchangées", termsBefore === termsAfter, { termsBefore, termsAfter });
    check("second passage : index unique toujours là",
      (await client.query(
        "SELECT count(*)::int AS n FROM pg_indexes WHERE indexname='uq_terms_user_version'"
      )).rows[0].n === 1);
  } finally {
    await client.end();
  }

  console.log("\n" + pass + " contrôle(s) OK, " + failCount + " échec(s).");
  if (failCount) process.exitCode = 1;
})().catch((err) => {
  console.error("ERREUR FATALE:", err.message);
  process.exit(1);
});
