/* ============================================================
   Transia — test/env-check.js
   Contrôles autonomes de db/env.js : ni base ni réseau.

   Couvre la lecture des fichiers (guillemets, commentaire de fin,
   BOM/CRLF/export), la priorité de l'environnement, l'ordre
   .env.local avant .env, les fichiers absents, puis le refus des
   valeurs masquées et des schémas non PostgreSQL — ces derniers
   dans un processus enfant, puisque requireDatabaseUrl() sort en
   code 2 (et ne se connecte jamais).

   Usage : node test/env-check.js
   Code de sortie 0 = tous les contrôles passent.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadEnv } = require("../db/env");

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "transia-env-"));
let pass = 0;
let failCount = 0;

function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else {
    failCount++;
    console.log("  ✗ " + label + (extra !== undefined ? " → " + JSON.stringify(extra).slice(0, 300) : ""));
  }
}

function write(name, text) { fs.writeFileSync(path.join(tmp, name), text); }
function reset(keys) { for (const k of keys) delete process.env[k]; }

/* requireDatabaseUrl() dans un processus séparé, pour observer son
   code de sortie sans terminer le test. Il renvoie son résultat en
   JSON : source de DATABASE_URL comprise. `root` permet de viser un
   répertoire de fichiers temporaire ; `null` retire la variable. */
const CALL = 'const r=require("./db/env").requireDatabaseUrl(process.argv[1]);' +
  'process.stdout.write(JSON.stringify(r))';

function child(databaseUrl, root) {
  const env = Object.assign({}, process.env);
  if (databaseUrl === null) delete env.DATABASE_URL;
  else env.DATABASE_URL = databaseUrl;
  const args = ["-e", CALL];
  if (root) args.push(root);
  return spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: "utf8" });
}

function parsed(result) {
  try { return JSON.parse(result.stdout || "{}"); }
  catch (e) { return {}; }
}

try {
  console.log("\n[1] Lecture des fichiers");
  write(".env.local", 'DATABASE_URL="postgresql://u:p@h:5432/db"\nQUOTE_S=\'simple\'\n');
  reset(["DATABASE_URL", "QUOTE_S"]);
  let loaded = loadEnv([".env.local"], tmp);
  check("double guillemets retirés", process.env.DATABASE_URL === "postgresql://u:p@h:5432/db", process.env.DATABASE_URL);
  check("guillemets simples retirés", process.env.QUOTE_S === "simple", process.env.QUOTE_S);
  check("fichier lu signalé", loaded.length === 1 && loaded[0] === ".env.local", loaded);

  write(".env", "\uFEFFexport PRIORITE=crlf\r\nCOMMENTAIRE=valeur  # note de fin\r\n# ligne ignorée\r\n");
  reset(["PRIORITE", "COMMENTAIRE"]);
  loadEnv([".env"], tmp);
  check("BOM + CRLF + export", process.env.PRIORITE === "crlf", process.env.PRIORITE);
  check("commentaire de fin retiré", process.env.COMMENTAIRE === "valeur", process.env.COMMENTAIRE);

  console.log("\n[2] Priorité et ordre");
  process.env.DATABASE_URL = "postgresql://depuis-env/db";
  loadEnv([".env.local"], tmp);
  check("environnement prioritaire sur le fichier",
    process.env.DATABASE_URL === "postgresql://depuis-env/db", process.env.DATABASE_URL);
  delete process.env.DATABASE_URL;

  write(".env.local", "ORDRE=local\n");
  write(".env", "ORDRE=fichier\n");
  reset(["ORDRE"]);
  loaded = loadEnv([".env.local", ".env"], tmp);
  check(".env.local l'emporte sur .env", process.env.ORDRE === "local", process.env.ORDRE);
  check("les deux fichiers sont signalés", loaded.join(",") === ".env.local,.env", loaded);
  delete process.env.ORDRE;

  console.log("\n[3] Provenance de DATABASE_URL");
  write(".env.local", 'DATABASE_URL="postgresql://fichier/db"\n');
  const fromFile = child(null, tmp);
  check("fichier → code 0", fromFile.status === 0, fromFile.stderr);
  check("fichier → source .env.local", parsed(fromFile).source === ".env.local", parsed(fromFile));
  check("fichier → URL du fichier", parsed(fromFile).url === "postgresql://fichier/db", parsed(fromFile));
  const fromEnv = child("postgresql://exporte/db", tmp);
  check("environnement → source environnement", parsed(fromEnv).source === "environnement", parsed(fromEnv));
  check("environnement → URL exportée", parsed(fromEnv).url === "postgresql://exporte/db", parsed(fromEnv));

  console.log("\n[4] Fichiers absents");
  const before = Object.keys(process.env).length;
  loaded = loadEnv([".env.inexistant"], tmp);
  check("fichier absent ignoré",
    loaded.length === 0 && Object.keys(process.env).length === before, loaded);

  console.log("\n[5] Chaînes refusées (processus enfant)");
  const masked = child("[SENSITIVE]");
  check("valeur masquée → code 2", masked.status === 2, masked.status);
  check("valeur masquée → message explicite", /masquée/.test(masked.stderr || ""), masked.stderr);
  const wrong = child("mysql://h/db");
  check("schéma non PostgreSQL → code 2", wrong.status === 2, wrong.status);
  check("schéma non PostgreSQL → message", /PostgreSQL/.test(wrong.stderr || ""), wrong.stderr);
  const ok = child("postgresql://u:p@h/db");
  check("chaîne PostgreSQL acceptée", ok.status === 0 && !ok.stderr, ok.stderr);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n" + pass + " contrôle(s) OK, " + failCount + " échec(s).");
if (failCount) process.exitCode = 1;
