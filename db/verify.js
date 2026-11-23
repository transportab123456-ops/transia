/* ============================================================
   Transia — db/verify.js
   Vérifie, après migration, que le schéma porte bien la preuve
   d'acceptation des CGU : table, index unique, trigger immuable.

   Usage :
     npm run verify                       (lit .env.local / .env)
     DATABASE_URL="postgresql://…" npm run verify

   La chaîne est résolue par db/env.js, comme db/migrate.js :
   environnement d'abord, puis .env.local et .env, aucune valeur
   affichée. Une URL `-pooler` (pooler Neon en mode transaction)
   est refusée : ce contrôle interroge les catalogues système et
   n'a rien à faire derrière un pooler.

   Codes de sortie :
     0  schéma conforme
     1  schéma non conforme (ou erreur SQL)
     2  URL absente, masquée, invalide ou `-pooler`
   ============================================================ */
"use strict";

const { Client } = require("pg");
const { requireDatabaseUrl } = require("./env");

/* Cible de connexion déduite de l'URL, sans se connecter.
   `local` n'active pas SSL (seuls les hôtes de bouclage).
   Toute autre issue est une erreur refusée avant connexion. */
function parseTarget(rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).hostname;
  } catch (e) {
    return { error: "DATABASE_URL illisible : " + e.message };
  }
  if (!host) return { error: "DATABASE_URL sans hôte." };
  if (/-pooler\b/i.test(host)) {
    return {
      error:
        "URL -pooler refusée (" + host + ").\n" +
        "Utilisez l'URL directe Neon (console → Connect → décocher « Connection pooling ») :\n" +
        "le pooler en mode transaction ne convient pas à ce contrôle de schéma."
    };
  }
  return { host: host, local: /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host) };
}

const SQL = `
  SELECT to_regclass('public.terms_acceptances') IS NOT NULL AS table_terms,
         to_regclass('public.uq_terms_user_version') IS NOT NULL AS index_unique,
         EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'trg_terms_acceptances_immutable'
                    AND NOT tgisinternal) AS trigger_immutable,
         (SELECT indexdef FROM pg_indexes
           WHERE indexname = 'uq_terms_user_version') AS index_def,
         (SELECT pg_get_triggerdef(oid) FROM pg_trigger
           WHERE tgname = 'trg_terms_acceptances_immutable') AS trigger_def,
         (SELECT count(*)::int FROM terms_acceptances) AS acceptances`;

/* Contrôles de forme : un booléen vrai ne suffit pas, l'index doit
   être UNIQUE sur les trois colonnes et le trigger BEFORE UPDATE
   FOR EACH ROW — c'est ce qui rend la preuve non réécrite.
   Renvoie une liste [libellé, conforme]. */
function verdict(row) {
  const indexDef = row.index_def || "";
  const triggerDef = row.trigger_def || "";
  return [
    ["table_terms", row.table_terms === true],
    ["index_unique", row.index_unique === true],
    ["trigger_immutable", row.trigger_immutable === true],
    ["index_def UNIQUE", /\bUNIQUE\b/i.test(indexDef)],
    ["index_def user_id, document_type, document_version",
      /user_id/i.test(indexDef) &&
      /document_type/i.test(indexDef) &&
      /document_version/i.test(indexDef)],
    ["trigger_def BEFORE UPDATE … FOR EACH ROW",
      /BEFORE UPDATE/i.test(triggerDef) && /FOR EACH ROW/i.test(triggerDef)]
  ];
}

async function main() {
  const { url, source } = requireDatabaseUrl();
  const target = parseTarget(url);
  if (target.error) {
    console.error(target.error);
    process.exit(2);
  }

  const client = new Client({
    connectionString: url,
    ssl: target.local ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000
  });

  await client.connect();
  try {
    console.log("Base : " + (target.local ? "locale" : "distante") +
      " — DATABASE_URL depuis " + (source === "environnement" ? "l'environnement" : source));
    console.log("Hôte : " + target.host + " (direct, sans pooler)");

    const { rows } = await client.query(SQL);
    console.table(rows[0]);

    const bad = verdict(rows[0]).filter((c) => !c[1]);
    if (bad.length) {
      console.error("Schéma non conforme : " + bad.map((c) => c[0]).join(", "));
      console.error("Rejouer `npm run migrate` avec la même URL directe.");
      process.exitCode = 1;
    } else {
      console.log("Schéma conforme — table, index unique et trigger immuable en place.");
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Vérification échouée : " + err.message);
    process.exit(1);
  });
}

module.exports = { parseTarget, verdict };
