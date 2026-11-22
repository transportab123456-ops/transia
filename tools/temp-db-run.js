/* ============================================================
   Transia — tools/temp-db-run.js
   Lance un script Node contre une base PostgreSQL jetable dans
   Docker : création du conteneur, attente de disponibilité,
   exécution du script, puis suppression du conteneur — y compris
   si le script échoue.

   Le port hôte est attribué par Docker, donc aucune collision avec
   une base déjà en marche. La base ne contient rien au départ et
   disparaît avec le conteneur.

   Usage :
     node tools/temp-db-run.js test/migration-upgrade.js
   Code de sortie : celui du script exécuté (2 si Docker ou la base
   ne démarre pas, ou si aucun script n'est fourni).
   ============================================================ */
"use strict";

const crypto = require("crypto");
const path = require("path");
const { spawnSync } = require("child_process");

const IMAGE = "postgres:16-alpine";
const PASSWORD = "transia";
const DATABASE = "transia";

const target = process.argv[2];
if (!target) {
  console.error("Usage : node tools/temp-db-run.js <script.js>");
  process.exit(2);
}

const ROOT = path.join(__dirname, "..");
const name = "transia-tempdb-" + crypto.randomBytes(4).toString("hex");

function docker(args, options) {
  return spawnSync("docker", args, Object.assign({ encoding: "utf8" }, options));
}

function stop() {
  docker(["rm", "-f", name]);
}

if (docker(["info"]).status !== 0) {
  console.error("Docker ne répond pas : impossible de créer la base jetable.");
  process.exit(2);
}

const run = docker([
  "run", "--rm", "-d", "--name", name,
  "-e", "POSTGRES_PASSWORD=" + PASSWORD,
  "-e", "POSTGRES_DB=" + DATABASE,
  "-p", "127.0.0.1::5432",
  IMAGE
]);
if (run.status !== 0) {
  console.error("Démarrage du conteneur impossible : " + (run.stderr || "").trim().slice(0, 300));
  stop();
  process.exit(2);
}

try {
  /* Port réellement publié par Docker. */
  const mapped = docker(["port", name, "5432/tcp"]);
  const hostPort = ((mapped.stdout || "").trim().split("\n")[0] || "").split(":").pop();
  if (mapped.status !== 0 || !hostPort) {
    console.error("Port publié introuvable : " + (mapped.stderr || "").trim().slice(0, 300));
    process.exit(2);
  }

  /* Attente bornée : une vraie requête sur la base cible, pour ne pas
     partir pendant la phase d'initialisation du conteneur. */
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = docker(["exec", name, "psql", "-U", "postgres", "-d", DATABASE, "-tAc", "SELECT 1"]).status === 0;
    if (!ready) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  if (!ready) {
    console.error("La base jetable n'a pas démarré à temps.");
    process.exit(2);
  }

  const url = "postgresql://postgres:" + PASSWORD + "@127.0.0.1:" + hostPort + "/" + DATABASE;
  console.log("Base jetable prête sur 127.0.0.1:" + hostPort + " — " + target + "\n");
  const child = spawnSync(process.execPath, [path.resolve(ROOT, target)], {
    cwd: ROOT,
    stdio: "inherit",
    env: Object.assign({}, process.env, { DATABASE_URL: url })
  });
  if (child.error) {
    console.error("Exécution impossible : " + child.error.message);
    process.exitCode = 2;
  } else {
    process.exitCode = child.status === null ? 2 : child.status;
  }
} finally {
  stop();
}
