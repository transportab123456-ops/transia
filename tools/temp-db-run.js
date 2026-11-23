/* ============================================================
   Transia — tools/temp-db-run.js
   Exécute une liste de scripts Node contre une base PostgreSQL
   jetable dans Docker, puis supprime le conteneur — même en cas
   d'échec ou de Ctrl+C.

   Le conteneur porte l'étiquette transia.tempdb=1 : si un run
   précédent a été tué avant son nettoyage, il est supprimé au
   démarrage du suivant. Le port hôte est choisi par Docker, donc
   aucune collision avec une base déjà en marche.

   Usage :
     node tools/temp-db-run.js [--partial] [--migrate] [--seed] <script.js…>
   --migrate et --seed sont des raccourcis pour db/migrate.js et
   db/seed.js, placés à leur position dans la séquence.

   La ligne de commande et scripts.test sont analysées par le même
   parseArgs : mêmes raccourcis, mêmes chemins normalisés, et une
   option inconnue est une erreur des deux côtés.

   Sauf --partial, le run doit couvrir toutes les suites listées dans
   scripts.test de package.json : la liste attendue y est relue et
   toute suite absente fait échouer le lanceur avant Docker, en la
   nommant. --partial autorise un run volontairement partiel (mise au
   point d'une seule suite), mais ce n'est pas un interrupteur muet :
   il est refusé en CI (process.env.CI) et refusé dans scripts.test,
   les deux chemins par lesquels un run incomplet se ferait passer
   pour complet. Il ne dispense que de la couverture complète, jamais
   du marqueur de fin.

   La liste seule ne prouve rien : un script peut sortir en 0 sans
   avoir rien exécuté. Le lanceur capture donc la sortie de chaque
   suite et exige, en plus du code 0, le marqueur de fin que la
   suite imprime elle-même avec tools/fin-de-suite.js. Sans lui, le
   run échoue, même sous npm test.

   Code de sortie : celui du premier script en échec (2 si Docker,
   la base ou un script ne peuvent pas démarrer, si une suite listée
   dans package.json manque au run, si une suite s'arrête sans son
   marqueur de fin, ou si les arguments sont invalides).
   ============================================================ */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const IMAGE = "postgres:16-alpine";
const PASSWORD = "transia";
const DATABASE = "transia";
const ROOT = path.join(__dirname, "..");
const LABEL = "transia.tempdb=1";
const RUNNER = "tools/temp-db-run.js";
const USAGE = "Usage : node " + RUNNER + " [--partial] [--migrate] [--seed] <script.js…>";
const MARKER = "[fin de suite] ";
const SHORTCUTS = { "--migrate": "db/migrate.js", "--seed": "db/seed.js" };

/* ---------- Arguments : une seule analyse, deux appelants ---------- */
/* Un script est ramené à son chemin relatif à la racine, en slashes,
   pour que `./db/verify.js`, `db\verify.js` et `db/verify.js` soient
   la même suite — celle que scripts.test liste et que le marqueur
   nomme. */
function parseArgs(tokens) {
  const list = [];
  let partial = false;
  for (const token of tokens) {
    if (token === "--partial") partial = true;
    else if (SHORTCUTS[token]) list.push(SHORTCUTS[token]);
    else if (token.startsWith("--")) return { error: "Option inconnue : " + token };
    else list.push(path.relative(ROOT, path.resolve(ROOT, token)).split(path.sep).join("/"));
  }
  return { list, partial };
}

const argv = parseArgs(process.argv.slice(2));
if (argv.error) {
  console.error(argv.error + "\n" + USAGE);
  process.exit(2);
}
const steps = argv.list;
const partial = argv.partial;

if (!steps.length) {
  console.error(USAGE);
  process.exit(2);
}
const duplicate = steps.find((script, i) => steps.indexOf(script) !== i);
if (duplicate) {
  console.error("Suite listée deux fois : " + duplicate + "\n" + USAGE);
  process.exit(2);
}

/* ---------- La liste attendue : scripts.test de package.json ---------- */
function expectedSteps() {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  } catch (err) {
    return { error: "package.json illisible : " + err.message };
  }
  const test = pkg && pkg.scripts && pkg.scripts.test;
  if (typeof test !== "string") return { error: "scripts.test absent de package.json." };
  const tokens = test.trim().split(/\s+/);
  const at = tokens.indexOf(RUNNER);
  if (at < 0) return { error: "scripts.test ne passe pas par " + RUNNER + "." };
  const parsed = parseArgs(tokens.slice(at + 1));
  if (parsed.error) return { error: "scripts.test : " + parsed.error };
  /* Un --partial dans package.json désarmerait la garde pour npm test. */
  if (parsed.partial) return { error: "scripts.test passe --partial : la liste attendue doit rester complète." };
  if (!parsed.list.length) return { error: "scripts.test ne liste aucune suite." };
  return { list: parsed.list };
}

/* ---------- --partial : refusé là où un run incomplet se cacherait ---------- */
if (partial && process.env.CI) {
  console.error(
    "--partial refusé en CI : un run d'intégration doit couvrir toutes les suites de package.json."
  );
  process.exit(2);
}

const expected = expectedSteps();
const expectedList = expected.list || null;

if (!partial && expected.error) {
  console.error("Garde des suites impossible : " + expected.error);
  process.exit(2);
}

/* Sous --partial, la liste peut rester illisible : le run est alors
   annoncé partiel, sans prétendre couvrir package.json. */
const missing = expectedList ? expectedList.filter((script) => !steps.includes(script)) : [];

if (!partial && missing.length) {
  console.error(
    "Garde des suites : " + missing.length + " suite(s) listée(s) dans package.json manque(nt) à ce run :\n  " +
      missing.join("\n  ") +
      "\nUtilisez --partial pour un run volontairement partiel.\n" + USAGE
  );
  process.exit(2);
}

if (partial) {
  console.log("Run partiel demandé : couverture complète non exigée, marqueur de fin toujours exigé.\n");
}

const name = "transia-tempdb-" + crypto.randomBytes(4).toString("hex");
let url = null;

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8" });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stop() {
  docker(["rm", "-f", name]);
}

/* Ctrl+C ne doit pas laisser la base derrière lui. */
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { stop(); process.exit(130); });
}

function runNode(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.resolve(ROOT, script)], {
      cwd: ROOT,
      stdio: ["inherit", "pipe", "pipe"],
      env: Object.assign({}, process.env, { DATABASE_URL: url })
    });
    /* Sortie relayée telle quelle, et retenue : le marqueur de fin
       doit être vu dans ce que la suite a réellement écrit. */
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("close", (code) => resolve({ code: code === null ? 2 : code, out }));
  });
}

(async () => {
  if (docker(["info"]).status !== 0) {
    console.error("Docker ne répond pas : impossible de créer la base jetable.");
    return 2;
  }

  /* Balayage des conteneurs d'un run interrompu (même étiquette). */
  const stale = docker(["ps", "-aq", "--filter", "label=" + LABEL]);
  const staleIds = stale.status === 0 ? stale.stdout.trim().split(/\s+/).filter(Boolean) : [];
  if (staleIds.length) {
    docker(["rm", "-f"].concat(staleIds));
    console.log("Conteneur(s) jetable(s) d'un run précédent supprimé(s) : " + staleIds.length);
  }

  const started = docker([
    "run", "--rm", "-d", "--name", name, "--label", LABEL,
    "-e", "POSTGRES_PASSWORD=" + PASSWORD,
    "-e", "POSTGRES_DB=" + DATABASE,
    "-p", "127.0.0.1::5432",
    IMAGE
  ]);
  if (started.status !== 0) {
    console.error("Démarrage du conteneur impossible : " + (started.stderr || "").trim().slice(0, 300));
    return 2;
  }

  try {
    const mapped = docker(["port", name, "5432/tcp"]);
    const hostPort = ((mapped.stdout || "").trim().split("\n")[0] || "").split(":").pop();
    if (mapped.status !== 0 || !hostPort) {
      console.error("Port publié introuvable : " + (mapped.stderr || "").trim().slice(0, 300));
      return 2;
    }
    url = "postgresql://postgres:" + PASSWORD + "@127.0.0.1:" + hostPort + "/" + DATABASE;

    /* Attente bornée : une vraie requête sur la base cible, pour ne pas
       partir pendant la phase d'initialisation du conteneur. */
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      ready = docker(["exec", name, "psql", "-U", "postgres", "-d", DATABASE, "-tAc", "SELECT 1"]).status === 0;
      if (!ready) sleep(500);
    }
    if (!ready) {
      console.error("La base jetable n'a pas démarré à temps.");
      return 2;
    }

    console.log("Base jetable sur 127.0.0.1:" + hostPort + "\n");

    let done = 0;
    for (const script of steps) {
      console.log("▶ " + script);
      const result = await runNode(script);
      if (result.code) {
        console.error("\n" + script + " a échoué (code " + result.code + ").");
        return result.code;
      }
      /* Code 0 ne veut pas dire « allé au bout » : le marqueur de fin,
         imprimé par la suite elle-même, en est la preuve. */
      if (result.out.indexOf(MARKER + script + "\n") === -1) {
        console.error(
          "\n" + script + " s'est arrêté sans marqueur de fin (\"" + MARKER + script + "\") : " +
            "suite tronquée, sortie anticipée, ou script non instrumenté."
        );
        return 2;
      }
      done++;
    }

    /* Confirmation finale : ce qui a réellement tourné, face à la liste
       attendue, pour que le log porte la preuve sans relecture. */
    if (expectedList && !missing.length) {
      console.log("\n" + done + " suite(s) exécutée(s) : toutes celles listées dans package.json.");
    } else {
      console.log(
        "\nRun partiel : " + done + " suite(s) exécutée(s)" +
          (expectedList ? " sur " + expectedList.length + " listée(s) dans package.json" : "") + "."
      );
    }
    return 0;
  } finally {
    stop();
  }
})().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error("ERREUR : " + err.message);
  process.exitCode = 2;
});
