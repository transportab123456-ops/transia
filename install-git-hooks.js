/* ============================================================
   Transia — install-git-hooks.js
   Active les hooks d'auteur pour ce clone, sans commande manuelle :
   lancé par `npm install` et `npm ci` (script postinstall), il pose
   `core.hooksPath=.githooks`.

   Sans dépôt Git (build Vercel, archive, paquet), il ne fait rien.
   Il ne fait jamais échouer l'installation : un problème de hooks ne
   doit pas casser un `npm ci`.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const HOOKS = ".githooks";

if (!fs.existsSync(path.join(__dirname, ".git"))) process.exit(0);

function git(args) {
  return spawnSync("git", args, { cwd: __dirname, encoding: "utf8" });
}

const actuel = git(["config", "--local", "--get", "core.hooksPath"]);
if (actuel.status === 0 && actuel.stdout.trim() === HOOKS) process.exit(0);

const pose = git(["config", "--local", "core.hooksPath", HOOKS]);
if (pose.status === 0) {
  console.log("Hooks Git activés : core.hooksPath=" + HOOKS);
} else {
  console.warn("Hooks Git non activés : " + String(pose.stderr || "").trim());
}
