/* ============================================================
   Transia — db/seed.js
   Peuplement initial et idempotent du référentiel :
   - pays (196) depuis assets/js/reference.js (ISO2, nom, devise)
   - devises (156) depuis reference.js
   - modes de transport (ROAD/SEA/AIR/MULTIMODAL)
   - les 11 Incoterms® 2020
   - langues principales
   Usage : node db/seed.js   (lit .env.local / .env via db/env.js)
   ============================================================ */
"use strict";

require("./env").requireDatabaseUrl();

global.window = {};
require("../assets/js/reference.js");
require("../assets/js/data.js");
const { getPool } = require("../api/_lib/db");

const MODES = [
  ["ROAD", "Routier"],
  ["SEA", "Maritime"],
  ["AIR", "Aérien"],
  ["MULTIMODAL", "Multimodal"]
];

const LANGUAGES = [
  ["fr", "Français"], ["en", "English"], ["es", "Español"], ["it", "Italiano"],
  ["de", "Deutsch"], ["ar", "العربية"], ["pt", "Português"]
];

/* Taux de change (1 unité de la devise = X EUR) — aligné sur le moteur
   de démonstration. En production : brancher un fournisseur de taux
   et écrire un nouveau snapshot dans fx_rates (l'historique est conservé). */
const FX_RATES = [
  ["USD", 0.92], ["GBP", 1.17], ["CHF", 1.06], ["MAD", 0.092],
  ["JPY", 0.0061], ["CAD", 0.68], ["AED", 0.25]
];

(async () => {
  const pool = getPool();
  const client = await pool.connect();
  let countries = 0, currencies = 0, modes = 0, incoterms = 0, langs = 0;
  try {
    await client.query("BEGIN");

    /* Pays : ISO2 + nom français + devise par défaut */
    for (const p of window.REF.pays) {
      const r = await client.query(
        `INSERT INTO countries (iso_code, country_name, default_currency, default_language, market_status, active)
         VALUES ($1,$2,$3,'fr','OBSERVATION',true)
         ON CONFLICT (iso_code) DO UPDATE SET country_name = EXCLUDED.country_name, default_currency = EXCLUDED.default_currency
         RETURNING country_id`,
        [p.c, p.n, p.d || null]
      );
      if (r.rowCount) countries++;
    }

    /* Devises ISO 4217 */
    for (const d of window.REF.devises) {
      const r = await client.query(
        `INSERT INTO currencies (iso_code, name, symbol, active)
         VALUES ($1,$2,$3,true)
         ON CONFLICT (iso_code) DO UPDATE SET name = EXCLUDED.name, symbol = EXCLUDED.symbol
         RETURNING currency_id`,
        [d.c, d.n, d.s || null]
      );
      if (r.rowCount) currencies++;
    }

    /* Modes */
    for (const [code, name] of MODES) {
      const r = await client.query(
        `INSERT INTO transport_modes (code, name) VALUES ($1,$2)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING transport_mode_id`,
        [code, name]
      );
      if (r.rowCount) modes++;
    }

    /* Incoterms 2020 (les 11, depuis data.js) */
    for (const inc of window.DB.incoterms) {
      const r = await client.query(
        `INSERT INTO incoterms (code, name, version, transport_scope, active)
         VALUES ($1,$2,'2020',NULL,true)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING incoterm_id`,
        [inc.code, inc.libelle]
      );
      if (r.rowCount) incoterms++;
    }

    /* Langues */
    for (const [code, name] of LANGUAGES) {
      const r = await client.query(
        `INSERT INTO languages (code, name, active) VALUES ($1,$2,true)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING language_id`,
        [code, name]
      );
      if (r.rowCount) langs++;
    }

    /* Taux de change : snapshot du jour (idempotent via l'UNIQUE du schéma) */
    let fx = 0;
    for (const [code, rate] of FX_RATES) {
      const r = await client.query(
        `INSERT INTO fx_rates (base_currency, quote_currency, rate, rate_date, provider)
         VALUES ('EUR', $1, $2, current_date, 'seed')
         ON CONFLICT (base_currency, quote_currency, rate_date, provider) DO NOTHING`,
        [code, rate]
      );
      if (r.rowCount) fx++;
    }

    await client.query("COMMIT");
    console.log(`Seed OK — pays:${countries} devises:${currencies} modes:${modes} incoterms:${incoterms} langues:${langs} taux:${fx}`);
    process.exit(0);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Seed échoué :", err.message);
    process.exit(1);
  } finally {
    client.release();
  }
})().catch((e) => { console.error(e); process.exit(1); });
