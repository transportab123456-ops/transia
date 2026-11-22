/* ============================================================
   Transia — db/env.js
   Chargement des variables locales, partagé par les scripts de
   base et les tests : plus besoin d'exporter DATABASE_URL.

   Lit les fichiers demandés (par défaut .env.local puis .env) à
   la racine, sans dépendance. Une variable déjà présente dans
   l'environnement n'est jamais remplacée : `DATABASE_URL=… npm
   run migrate` garde la priorité, et aucune valeur n'est affichée.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DEFAULT_FILES = [".env.local", ".env"];

/* Clé → fichier qui l'a définie (absent : vient de l'environnement). */
const definedIn = {};

/* Gère export, guillemets, BOM, CRLF et commentaire en fin de ligne. */
function readEnvFile(name, root) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    if (!(m[1] in process.env)) {
      process.env[m[1]] = value;
      definedIn[m[1]] = name;
    }
  }
  return true;
}

/* Charge les fichiers indiqués et renvoie ceux qui existaient.
   Rejouable : les variables déjà définies sont conservées.
   `root` n'existe que pour les tests (répertoire temporaire). */
function loadEnv(files, root) {
  const dir = root || ROOT;
  return (files || DEFAULT_FILES).filter(function (name) {
    return readEnvFile(name, dir);
  });
}

/* DATABASE_URL contrôlée ; sort en code 2 avec la marche à suivre.
   Renvoie { url, loaded, source } : `source` vaut le fichier qui a
   fourni la variable, ou "environnement" si elle était déjà exportée. */
function requireDatabaseUrl() {
  const loaded = loadEnv();
  const url = process.env.DATABASE_URL;
  const source = definedIn.DATABASE_URL || "environnement";
  function fail(why) {
    console.error(why + "\nAjoutez dans .env.local à la racine :\n  DATABASE_URL=postgresql://user:pass@host/db");
    process.exit(2);
  }
  if (!url) fail("DATABASE_URL introuvable (" + (loaded.join(", ") || "environnement") + ").");
  if (/^\[.*\]$/.test(url)) fail("DATABASE_URL vaut \"" + url + "\", une valeur masquée par `vercel env pull`.");
  if (!/^postgres(ql)?:\/\//.test(url)) fail("DATABASE_URL n'est pas une chaîne PostgreSQL.");
  return { url, loaded, source };
}

module.exports = { loadEnv, requireDatabaseUrl };
