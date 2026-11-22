/* ============================================================
   Transia — db/bootstrap-admin.js
   Crée (ou met à jour) le premier compte plateforme.
   Usage :
     node db/bootstrap-admin.js
   Lit .env.admin (ADMIN_EMAIL, ADMIN_PASSWORD) et .env.local / .env
   (DATABASE_URL) via db/env.js.
   Idempotent : réexécution sans effacer les autres comptes.
   ============================================================ */
"use strict";

const { loadEnv, requireDatabaseUrl } = require("./env");
loadEnv();                  // .env.local puis .env : DATABASE_URL
loadEnv([".env.admin"]);    // ADMIN_EMAIL / ADMIN_PASSWORD

if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
  console.error("ADMIN_EMAIL et ADMIN_PASSWORD sont requis (.env.admin ou environnement).");
  process.exit(2);
}
requireDatabaseUrl();

const { getPool } = require("../api/_lib/db");
const { hashPassword } = require("../api/_lib/auth");

(async () => {
  const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (password.length < 10) {
    console.error("ADMIN_PASSWORD : 10 caractères minimum.");
    process.exit(2);
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    /* Compte plateforme (pas d'entreprise métier : rattaché à la
       « plateforme » ; le schéma exige company_id NOT NULL). */
    let co = await client.query(
      `SELECT company_id FROM companies WHERE legal_name = 'Transia Platform' LIMIT 1`
    );
    if (!co.rows.length) {
      co = await client.query(
        `INSERT INTO companies (legal_name, main_email, status)
         VALUES ('Transia Platform', $1, 'ACTIVE') RETURNING company_id`,
        [email]
      );
    }
    const companyId = co.rows[0].company_id;

    const hash = await hashPassword(password);
    const existing = await client.query(`SELECT user_id FROM users WHERE email = $1`, [email]);
    let userId;
    if (existing.rows.length) {
      userId = existing.rows[0].user_id;
      await client.query(
        `UPDATE users SET password_hash = $2, role = 'SUPER_ADMIN', status = 'ACTIVE', updated_at = now()
          WHERE user_id = $1`,
        [userId, hash]
      );
      console.log(`Compte existant mis à jour : ${email} (SUPER_ADMIN).`);
    } else {
      const u = await client.query(
        `INSERT INTO users (company_id, first_name, last_name, email, password_hash, role, status)
         VALUES ($1, 'Admin', 'Transia', $2, $3, 'SUPER_ADMIN', 'ACTIVE')
         RETURNING user_id`,
        [companyId, email, hash]
      );
      userId = u.rows[0].user_id;
      console.log(`Compte créé : ${email} (SUPER_ADMIN).`);
    }

    await client.query(
      `INSERT INTO audit_log (user_id, action_type, entity_type, entity_id, new_value)
       VALUES ($1,'PLATFORM_ADMIN_BOOTSTRAPPED','users',$1,$2)`,
      [userId, JSON.stringify({ email })]
    );

    await client.query("COMMIT");
    process.exit(0);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Bootstrap échoué :", err.message);
    process.exit(1);
  } finally {
    client.release();
  }
})().catch((e) => { console.error(e); process.exit(1); });
