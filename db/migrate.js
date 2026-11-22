/* ============================================================
   Transia — db/migrate.js
   Applique db/schema.sql en une commande.

   Usage :
     DATABASE_URL="postgresql://…" node db/migrate.js
     DATABASE_URL="postgresql://…" npm run migrate

   Le schéma est idempotent : chaque incrément est enveloppé dans
   sa propre transaction, et tout est en CREATE ... IF NOT EXISTS /
   ADD COLUMN IF NOT EXISTS. Le rejouer ne détruit aucune donnée.
   Code de sortie 0 = schéma à jour.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL manquant. Exemple :\n  DATABASE_URL=\"postgresql://user:pass@host/db\" node db/migrate.js");
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
    console.log("Application de db/schema.sql…");
    await client.query(sql);

    /* Contrôle minimal : les tables de la dernière migration existent. */
    const check = await client.query(
      `SELECT to_regclass('public.terms_acceptances') IS NOT NULL AS terms,
              to_regclass('public.outbox_emails') IS NOT NULL AS outbox`
    );
    const row = check.rows[0];
    console.log("Schéma à jour — terms_acceptances: " + row.terms + ", outbox_emails: " + row.outbox);
    if (!row.terms || !row.outbox) {
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
