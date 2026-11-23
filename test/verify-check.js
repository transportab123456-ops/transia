/* ============================================================
   Transia — test/verify-check.js
   Contrôles autonomes de db/verify.js : ni base ni réseau.

   Couvre le garde-fou d'URL (refus `-pooler` insensible à la
   casse, y compris avec port, avant toute connexion) et les
   contrôles de forme du verdict (index unique sur les trois
   colonnes, trigger BEFORE UPDATE FOR EACH ROW). Le refus des
   valeurs masquées vérifie l'articulation avec db/env.js, dont
   le reste des contrôles vit dans test/env-check.js.

   Usage : node test/verify-check.js
   Code de sortie 0 = tous les contrôles passent.
   ============================================================ */
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");
const { parseTarget, verdict } = require("../db/verify");

const ROOT = path.join(__dirname, "..");
let pass = 0;
let failCount = 0;

function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else {
    failCount++;
    console.log("  ✗ " + label + (extra !== undefined ? " → " + JSON.stringify(extra).slice(0, 300) : ""));
  }
}

/* db/verify.js dans un processus séparé : code de sortie 2 = refus
   avant connexion (une connexion ratée sortirait en 1). Aucune URL
   de ce test n'est joignable, et le garde-fou doit trancher avant. */
function child(databaseUrl) {
  const env = Object.assign({}, process.env, { DATABASE_URL: databaseUrl });
  const result = spawnSync(process.execPath, ["db/verify.js"], {
    cwd: ROOT, env, encoding: "utf8", timeout: 20000
  });
  return { status: result.status, stderr: result.stderr || "" };
}

const DIRECT = "postgresql://u:p@ep-cool-1234.eu-west-2.aws.neon.tech/neondb?sslmode=require";
const POOLED = "postgresql://u:p@ep-cool-1234-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require";

const CONFORMING = {
  table_terms: true,
  index_unique: true,
  trigger_immutable: true,
  index_def: "CREATE UNIQUE INDEX uq_terms_user_version ON public.terms_acceptances USING btree (user_id, document_type, document_version)",
  trigger_def: "CREATE TRIGGER trg_terms_acceptances_immutable BEFORE UPDATE ON public.terms_acceptances FOR EACH ROW EXECUTE FUNCTION terms_acceptances_immutable()",
  acceptances: 0
};

/* Libellés des contrôles en échec, pour un schéma donné. */
function failed(patch) {
  const row = Object.assign({}, CONFORMING, patch);
  return verdict(row).filter((c) => !c[1]).map((c) => c[0]).join(",");
}

console.log("\n[1] Garde-fou : cible de connexion");
const direct = parseTarget(DIRECT);
check("URL directe acceptée, hôte repris",
  !direct.error && direct.host === "ep-cool-1234.eu-west-2.aws.neon.tech", direct);
check("URL distante → SSL actif", direct.local === false, direct);
check("bouclage → locale (SSL désactivé)", parseTarget("postgresql://u:p@127.0.0.1:5432/db").local === true);
check("hôte « pooler » sans tiret accepté",
  !parseTarget("postgresql://u:p@pooler.example.com/db").error);
check("URL illisible → erreur, pas d'exception", !!parseTarget("pas une url").error);
check("URL sans hôte → erreur", !!parseTarget("postgresql:///neondb").error);

console.log("\n[2] Garde-fou : refus du pooler (processus enfant)");
const pooled = child(POOLED);
check("URL -pooler → code 2", pooled.status === 2, pooled.status);
check("URL -pooler → message explicite", /-pooler refusée/.test(pooled.stderr), pooled.stderr);
check("URL -POOLER → code 2 (insensible à la casse)",
  child(POOLED.replace("-pooler", "-POOLER")).status === 2);
check("URL -pooler avec port → code 2",
  child(POOLED.replace(".neon.tech", ".neon.tech:5432")).status === 2);

console.log("\n[3] Refus hérité de db/env.js (processus enfant)");
const masked = child("[SENSITIVE]");
check("valeur masquée → code 2", masked.status === 2, masked.status);
check("valeur masquée → message de db/env.js", /masquée/.test(masked.stderr), masked.stderr);

console.log("\n[4] Verdict : schéma conforme");
check("schéma conforme → aucun contrôle en échec", failed({}) === "", failed({}));

console.log("\n[5] Verdict : écarts détectés");
check("table absente", failed({ table_terms: false }) === "table_terms", failed({ table_terms: false }));
check("index non unique",
  failed({ index_def: CONFORMING.index_def.replace("UNIQUE ", "") }) === "index_def UNIQUE",
  failed({ index_def: CONFORMING.index_def.replace("UNIQUE ", "") }));
check("index sur une seule colonne",
  failed({ index_def: "CREATE UNIQUE INDEX uq_terms_user_version ON public.terms_acceptances USING btree (user_id)" })
    === "index_def user_id, document_type, document_version");
check("trigger absent (colonne NULL)",
  failed({ trigger_immutable: false, trigger_def: null })
    === "trigger_immutable,trigger_def BEFORE UPDATE … FOR EACH ROW");
check("trigger AFTER au lieu de BEFORE",
  failed({ trigger_def: CONFORMING.trigger_def.replace("BEFORE", "AFTER") })
    === "trigger_def BEFORE UPDATE … FOR EACH ROW");
check("trigger sans FOR EACH ROW",
  failed({ trigger_def: CONFORMING.trigger_def.replace("FOR EACH ROW ", "") })
    === "trigger_def BEFORE UPDATE … FOR EACH ROW");

console.log("\n" + pass + " contrôle(s) OK, " + failCount + " échec(s).");
require("../tools/fin-de-suite")(__filename);
if (failCount) process.exitCode = 1;
