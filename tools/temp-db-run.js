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
     node tools/temp-db-run.js [--migrate] [--seed] <script.js…>
   --migrate et --seed sont des raccourcis pour db/migrate.js et
   db/seed.js, placés à leur position dans la séquence.
   Code de sortie : celui du premier script en échec (2 si Docker,
   la base ou un script ne peuvent pas démarrer).
   ============================================================ */
"use strict";

const crypto = require("crypto");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const IMAGE = "postgres:16-alpine";
const PASSWORD = "transia";
const DATABASE = "transia";
const ROOT = path.join(__dirname, "..");
const LABEL = "transia.tempdb=1";
const USAGE = "Usage : node tools/temp-db-run.js [--migrate] [--seed] <script.js…>";

/* ---------- Arguments : la séquence à exécuter ---------- */
const steps = [];
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--migrate") steps.push("db/migrate.js");
  else if (arg === "--seed") steps.push("db/seed.js");
  else if (arg.startsWith("--")) {
    console.error("Option inconnue : " + arg + "\n" + USAGE);
    process.exit(2);
  } else steps.push(arg);
}
if (!steps.length) {
  console.error(USAGE);
  process.exit(2);
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
      stdio: "inherit",
      env: Object.assign({}, process.env, { DATABASE_URL: url })
    });
    child.on("close", (code) => resolve(code === null ? 2 : code));
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
    stop();
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

    for (const script of steps) {
      console.log("▶ " + script);
      const code = await runNode(script);
      if (code) {
        console.error("\n" + script + " a échoué (code " + code + ").");
        return code;
      }
    }
    return 0;
  } finally {
    stop();
  }
})().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error("ERREUR : " + err.message);
  stop();
  process.exitCode = 2;
});
