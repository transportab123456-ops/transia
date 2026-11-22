/* ============================================================
   Transia — tools/temp-db-run.js
   Exécute une séquence d'étapes contre une base PostgreSQL jetable
   dans Docker : migration, seed et scripts Node dans l'ordre donné,
   puis suppression du conteneur — même en cas d'échec ou de Ctrl+C.

   Le conteneur porte l'étiquette transia.tempdb=1 : si un run
   précédent a été tué avant son nettoyage, il est supprimé au
   démarrage du suivant. Le port hôte est choisi par Docker, donc
   aucune collision avec une base déjà en marche.

   Usage :
     node tools/temp-db-run.js [--migrate] [--seed] [options] <script.js…>
   Les options s'appliquent à leur position dans la séquence :
     --migrate           applique db/schema.sql à cet endroit
     --seed              peuple le référentiel (db/seed.js) à cet endroit
     --env-for motif:CLE=VALEUR
                         variable réservée aux scripts dont le nom
                         contient « motif » (répétable)
   Code de sortie : celui de la première étape en échec (2 si Docker,
   la base ou une étape ne peuvent pas démarrer).
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

/* ---------- Arguments : une séquence d'étapes ---------- */
const steps = [];
const envFor = [];

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--migrate") steps.push({ type: "migrate" });
  else if (arg === "--seed") steps.push({ type: "seed" });
  else if (arg === "--env-for") {
    const spec = process.argv[++i] || "";
    const colon = spec.indexOf(":");
    const eq = spec.indexOf("=", colon + 1);
    if (colon < 1 || eq < colon + 2) {
      console.error("--env-for attend motif:CLE=VALEUR.");
      process.exit(2);
    }
    envFor.push({
      match: spec.slice(0, colon),
      key: spec.slice(colon + 1, eq),
      value: spec.slice(eq + 1)
    });
  } else if (arg.startsWith("--")) {
    console.error("Option inconnue : " + arg);
    process.exit(2);
  } else {
    steps.push({ type: "script", path: arg });
  }
}
if (!steps.some((step) => step.type === "script")) {
  console.error("Usage : node tools/temp-db-run.js [--migrate] [--seed] [--env-for motif:CLE=VALEUR] <script.js…>");
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

function runNode(args, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: "inherit",
      env: Object.assign({}, process.env, { DATABASE_URL: url }, extraEnv || {})
    });
    child.on("close", (code) => resolve(code === null ? 2 : code));
  });
}

/* Libellé affiché et commande de chaque étape. */
function describe(step) {
  if (step.type === "migrate") return { label: "db/migrate.js", args: ["db/migrate.js"], env: {} };
  if (step.type === "seed") return { label: "db/seed.js", args: ["db/seed.js"], env: {} };
  const env = {};
  for (const rule of envFor) {
    if (step.path.includes(rule.match)) env[rule.key] = rule.value;
  }
  return { label: step.path, args: [path.resolve(ROOT, step.path)], env };
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

    for (const step of steps) {
      const { label, args, env } = describe(step);
      console.log("▶ " + label);
      const code = await runNode(args, env);
      if (code) {
        console.error("\n" + label + " a échoué (code " + code + ").");
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
