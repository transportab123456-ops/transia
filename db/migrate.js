/* ============================================================
   Transia — db/migrate.js
   Applique db/schema.sql en une commande.

   Usage :
     npm run migrate                      (lit .env.local / .env)
     DATABASE_URL="postgresql://…" npm run migrate

   La chaîne est résolue par db/env.js : environnement d'abord,
   puis .env.local et .env. Une variable déjà exportée garde la
   priorité, et aucune valeur n'est affichée.

   Le schéma est idempotent : chaque incrément est enveloppé dans
   sa propre transaction, et tout est en CREATE ... IF NOT EXISTS /
   ADD COLUMN IF NOT EXISTS. Le rejouer ne détruit aucune donnée.
   Code de sortie 0 = schéma à jour.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { requireDatabaseUrl } = require("./env");

const { url, source } = requireDatabaseUrl();
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
    console.log("Base : " + (local ? "locale" : "distante") +
      " — DATABASE_URL depuis " + (source === "environnement" ? "l'environnement" : source));
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
