/* ============================================================
   Transia — db/env.js
   Chargement des variables locales, partagé par les scripts de
   base (migrate, seed, bootstrap-admin) et les tests.

   Lit .env.local puis .env à la racine du projet, dans cet ordre,
   sans dépendance. Une variable déjà présente dans l'environnement
   n'est jamais remplacée : `DATABASE_URL=… npm run migrate` garde
   la priorité sur le fichier, et rien n'est affiché du contenu.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FILES = [".env.local", ".env"];

/* Gère export, guillemets, CRLF, BOM et commentaires en fin de ligne. */
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

let cached = null;

/* Charge une seule fois ; renvoie les noms des fichiers lus. */
function loadEnv() {
  if (!cached) {
    cached = FILES.filter(function (f) { return loadEnvFile(path.join(ROOT, f)); });
  }
  return cached;
}

/* Chaîne de connexion validée, sans jamais l'afficher.
   { url, loaded, error } */
function databaseUrl() {
  const loaded = loadEnv();
  const url = process.env.DATABASE_URL;
  const where = loaded.length ? " (fichiers lus : " + loaded.join(", ") + ")" : " (aucun .env.local)";

  if (!url) {
    return {
      url: null, loaded,
      error: "DATABASE_URL introuvable" + where + ".\n" +
        "Ajoutez une ligne dans .env.local à la racine :\n" +
        "  DATABASE_URL=postgresql://user:pass@host/db"
    };
  }
  if (/^\[.*\]$/.test(url)) {
    return {
      url: null, loaded,
      error: "DATABASE_URL vaut \"" + url + "\" : c'est une valeur masquée par `vercel env pull`.\n" +
        "Remplacez-la par la vraie chaîne de connexion dans .env.local."
    };
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    return { url: null, loaded, error: "DATABASE_URL n'est pas une chaîne PostgreSQL (postgresql://…)." };
  }
  return { url, loaded, error: null };
}

/* Variante pour les scripts en ligne de commande : affiche le
   problème et sort en code 2 plutôt que de laisser échouer plus loin. */
function requireDatabaseUrl() {
  const r = databaseUrl();
  if (r.error) {
    console.error(r.error);
    process.exit(2);
  }
  return r;
}

module.exports = { loadEnv, databaseUrl, requireDatabaseUrl };
