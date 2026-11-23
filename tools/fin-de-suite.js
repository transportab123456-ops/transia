/* ============================================================
   Transia — tools/fin-de-suite.js
   Marqueur de fin de suite, exigé par tools/temp-db-run.js.

   Chaque script exécuté par le lanceur imprime cette ligne en
   dernier, quand il a réellement atteint sa fin. Une suite
   tronquée, un retour anticipé ou un process.exit(0) au milieu
   du fichier laissent le lanceur sans marqueur : il échoue, même
   si le code de sortie est 0.

   L'écriture passe par fs.writeSync : stdout est un tube en CI,
   où console.log est asynchrone et pourrait être perdu par le
   process.exit() qui suit.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

module.exports = function finDeSuite(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  fs.writeSync(1, "\n[fin de suite] " + rel + "\n");
};
