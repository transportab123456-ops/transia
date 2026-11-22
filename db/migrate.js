/* ============================================================
   Transia — db/migrate.js
   Applique db/schema.sql en une commande.

   Usage :
     npm run migrate                      (lit .env.local / .env)
     DATABASE_URL="postgresql://…" npm run migrate

   La chaîne de connexion est cherchée dans l'environnement, puis
   dans .env.local et .env à la racine du projet. Une variable déjà
   exportée garde la priorité : rien n'est écrasé, et aucune valeur
   n'est affichée.

   Le schéma est idempotent : chaque incrément est enveloppé dans
   sa propre transaction, et tout est en CREATE ... IF NOT EXISTS /
   ADD COLUMN IF NOT EXISTS. Le rejouer ne détruit aucune donnée.
   Code de sortie 0 = schéma à jour.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..");

/* Chargement minimal d'un fichier .env, sans dépendance.
   Gère export, guillemets, CRLF, BOM et commentaires. Les variables
   déjà présentes dans process.env ne sont jamais remplacées. */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
         (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
  return true;
}

const loaded = [".env.local", ".env"].filter(function (f) {
  return loadEnvFile(path.join(ROOT, f));
});

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "DATABASE_URL introuvable" + (loaded.length ? " (fichiers lus : " + loaded.join(", ") + ")" : " (aucun .env.local)") + ".\n" +
    "Ajoutez une ligne dans .env.local à la racine :\n" +
    "  DATABASE_URL=postgresql://user:pass@host/db"
  );
  process.exit(2);
}
if (url === "[SENSITIVE]" || /^\[.*\]$/.test(url)) {
  console.error(
    "DATABASE_URL vaut \"" + url + "\" : c'est une valeur masquée par `vercel env pull`.\n" +
    "Remplacez-la par la vraie chaîne de connexion dans .env.local."
  );
  process.exit(2);
}
if (!/^postgres(ql)?:\/\//.test(url)) {
  console.error("DATABASE_URL n'est pas une chaîne PostgreSQL (postgresql://…).");
  process.exit(2);
}

const schemaPath = path.join(__dirname, "schema.sql");
const sql = fs.readFileSync(schemaPath, "utf8");
const local = /localhost|127\.0\.0\.1/.test(url);

(async () => {
  const client = new Client({
    connectionString: url,
    ssl: local ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000
  });

  await client.connect();
  try {
    console.log("Base : " + (local ? "locale" : "distante") + " (" + loaded.join(", ") + ")");
    console.log("Application de db/schema.sql…");
    await client.query(sql);

    /* Contrôle minimal : la table de la dernière migration et son
       index unique (qui garantit une seule preuve par document et
       version) doivent exister. */
    const check = await client.query(
      `SELECT to_regclass('public.terms_acceptances') IS NOT NULL AS terms,
              to_regclass('public.outbox_emails') IS NOT NULL AS outbox,
              to_regclass('public.uq_terms_user_version') IS NOT NULL AS unique_idx`
    );
    const row = check.rows[0];
    console.log(
      "Schéma à jour — terms_acceptances: " + row.terms +
      ", outbox_emails: " + row.outbox +
      ", uq_terms_user_version: " + row.unique_idx
    );
    if (!row.terms || !row.outbox || !row.unique_idx) {
      console.error("Migration incomplète : vérifiez les erreurs au-dessus.");
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
})().catch((err) => {
  console.error("Migration échouée : " + err.message);
  process.exit(1);
});
