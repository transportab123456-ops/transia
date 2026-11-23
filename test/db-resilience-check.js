/* ============================================================
   Transia — test/db-resilience-check.js
   Contrôles de la reprise après suspension de la base, contre la
   base jetable : réessai borné d'une connexion qui échoue, puis
   statement_timeout réellement appliqué.

   Un proxy TCP est placé devant la base : la première connexion est
   coupée, la suivante passe. C'est la forme d'un réveil Neon — la
   connexion est refusée ou réinitialisée avant que le calcul ne
   réponde. Le contrôle vérifie que la requête aboutit quand même et
   qu'exactement deux connexions ont été tentées.

   Le dernier contrôle fait l'inverse : toutes les connexions sont
   coupées, et le processus doit abandonner après le nombre d'essais
   prévu, sans boucler.

   Usage : DATABASE_URL=... node test/db-resilience-check.js
   Code de sortie 0 = tous les contrôles passent.
   ============================================================ */
"use strict";

const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DB = new URL(process.env.DATABASE_URL);
const DB_HOST = DB.hostname;
const DB_PORT = Number(DB.port || 5432);
const DB_NAME = DB.pathname.replace(/^\//, "");

let pass = 0;
let failCount = 0;

function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else {
    failCount++;
    console.log("  ✗ " + label + (extra !== undefined ? " → " + JSON.stringify(extra).slice(0, 300) : ""));
  }
}

/* Proxy TCP devant la base. failFirst coupe les N premières
   connexions, failAll les coupe toutes. Chaque acceptation est
   comptée : c'est la mesure directe du nombre d'essais. */
function startProxy(opts) {
  const failFirst = opts.failFirst || 0;
  const failAll = !!opts.failAll;
  return new Promise((resolve) => {
    let accepted = 0;
    const server = net.createServer((socket) => {
      accepted++;
      socket.on("error", () => {});
      if (failAll || accepted <= failFirst) {
        socket.destroy();
        return;
      }
      const upstream = net.connect(DB_PORT, DB_HOST);
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
      socket.pipe(upstream).pipe(socket);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, count: () => accepted });
    });
  });
}

function proxyUrl(port) {
  return (
    "postgresql://" + encodeURIComponent(DB.username) + ":" + encodeURIComponent(DB.password) +
    "@127.0.0.1:" + port + "/" + DB_NAME
  );
}

/* Processus enfant : le pool est mémorisé par processus, un second
   scénario de connexion demande donc un second processus. */
function runChild(port, attempts) {
  const script =
    "const db = require(" + JSON.stringify(path.join(ROOT, "api/_lib/db.js")) + ");" +
    "db.query('SELECT 1 AS n')" +
    ".then(() => { process.stdout.write('OK'); process.exit(0); })" +
    ".catch((e) => { process.stdout.write('ERR ' + (e.code || e.message)); process.exit(1); });";
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", script], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        DATABASE_URL: proxyUrl(port),
        PG_RETRY_ATTEMPTS: String(attempts)
      })
    });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { out += chunk.toString("utf8"); });
    child.on("close", (code) => resolve({ code: code === null ? 2 : code, out }));
  });
}

(async () => {
  const recover = await startProxy({ failFirst: 1 });
  const dead = await startProxy({ failAll: true });

  /* db.js lit DATABASE_URL à la création du pool : le proxy doit être
     en place avant le require. */
  process.env.DATABASE_URL = proxyUrl(recover.port);
  process.env.PG_RETRY_ATTEMPTS = "3";
  const db = require("../api/_lib/db");

  console.log("\n[1] Reprise après une connexion coupée");
  const first = await db.query("SELECT 1 AS n");
  check("la requête aboutit malgré la première connexion coupée", first.rows[0].n === 1);
  check("exactement deux connexions tentées", recover.count() === 2, recover.count());

  console.log("\n[2] statement_timeout appliqué");
  const setting = await db.query(
    "SELECT setting::int AS ms FROM pg_settings WHERE name = 'statement_timeout'"
  );
  check("statement_timeout = 5000 ms", setting.rows[0].ms === 5000, setting.rows[0].ms);

  console.log("\n[3] Une requête trop longue est annulée");
  const started = Date.now();
  let slowErr = null;
  try {
    await db.query("SELECT pg_sleep(30)");
  } catch (err) {
    slowErr = err;
  }
  const elapsed = Date.now() - started;
  check("annulation par la base (code 57014)", !!slowErr && slowErr.code === "57014",
    slowErr && slowErr.code);
  check("annulée en moins de 8 s", elapsed < 8000, elapsed);

  console.log("\n[4] Le réessai est borné");
  const bounded = await runChild(dead.port, 3);
  check("trois tentatives, pas plus", dead.count() === 3, dead.count());
  check("le processus enfant échoue", bounded.code === 1, bounded);
  /* Le processus enfant écrit ses avertissements de réessai avant la
     ligne finale : c'est cette dernière qui porte l'erreur remontée. */
  const lastLine = bounded.out.trim().split(/\r?\n/).pop();
  check("l'erreur remontée est celle de la connexion", /^ERR .+/.test(lastLine), lastLine);

  await db.getPool().end();
  recover.server.close();
  dead.server.close();

  console.log("\n" + pass + " contrôle(s) OK, " + failCount + " échec(s).");
  require("../tools/fin-de-suite")(__filename);
  if (failCount) process.exitCode = 1;
})().catch((err) => {
  console.error("\nERREUR : " + err.message);
  process.exitCode = 1;
});
