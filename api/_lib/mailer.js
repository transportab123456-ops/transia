/* ============================================================
   Transia — api/_lib/mailer.js
   Transport d'e-mail transactionnel.
   - Provider : Resend (API REST, idempotency-key 24 h).
   - Sans clé RESEND_API_KEY : MODE LOG — l'e-mail est journalisé
     (statut LOGGED) au lieu d'être envoyé ; la plateforme reste
     intégralement fonctionnelle hors configuration e-mail.
   - drainOutbox() : vide la file outbox_emails (pending) avec
     backoff exponentiel + verrouillage optimiste (instances
     serverless multiples en toute sécurité).
   ============================================================ */
"use strict";

const { getPool } = require("./db");

const RESEND_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.EMAIL_FROM || "Transia <onboarding@resend.dev>";
const MAX_ATTEMPTS = 8;

/* Backoff : 30 s, 2 min, 10 min, 1 h puis 1 h. */
const BACKOFF_SEC = [30, 120, 600, 3600];

function mailEnabled() {
  return !!RESEND_KEY;
}

/* Envoi réel via Resend. Idempotency-key : un rejeu après timeout
   ne crée pas de second e-mail côté Resend. */
async function sendViaResend({ to, subject, html, text, dedupeKey }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + RESEND_KEY,
      "Content-Type": "application/json",
      "Idempotency-Key": (dedupeKey || subject + to).slice(0, 256)
    },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html, text })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("Resend " + res.status + " : " + body.slice(0, 300));
  }
  return true;
}

/* Drain best-effort de la file. À appeler après un commit qui a
   écrit dans l'outbox, et par le cron. Ne doit JAMAIS faire échouer
   la requête métier : les erreurs sont absorbées ici (l'événement
   reste PENDING et sera repris). */
async function drainOutbox(limit, existing) {
  /* `existing` : connexion déjà tenue par l'appelant (juste après un
     COMMIT). Sans elle, le drain en ouvre une seconde, ce qui affame
     le pool quand plusieurs requêtes se terminent ensemble. */
  const owns = !existing;
  const client = existing || await getPool().connect();
  try {
    /* Verrouillage optimiste : une seule instance draine à la fois.
       (FOR UPDATE SKIP LOCKED protège aussi si le verrou expire.) */
    const picked = await client.query(
      `UPDATE outbox_emails e
          SET status = 'SENDING', locked_at = now(), attempts = e.attempts + 1
        WHERE e.email_id IN (
          SELECT email_id FROM outbox_emails
           WHERE (status = 'PENDING' AND next_attempt_at <= now())
              OR (status = 'SENDING' AND locked_at < now() - interval '10 minutes')
           ORDER BY email_id
           LIMIT $1
           FOR UPDATE SKIP LOCKED)
        RETURNING e.*`,
      [limit || 10]
    );

    for (const mail of picked.rows) {
      try {
        if (!mailEnabled()) {
          /* Mode log : journalisé, pas envoyé. Visible dans la base
             et les logs serveur — aucun e-mail ne sort. */
          console.log(
            "[outbox:log] → " + mail.recipient_email + " | " + mail.subject +
            " | événement " + mail.event_type +
            (process.env.NODE_ENV === "production" ? "" : "\n" + mail.body_text)
          );
          await client.query(
            `UPDATE outbox_emails SET status = 'LOGGED', sent_at = now(), last_error = NULL WHERE email_id = $1`,
            [mail.email_id]
          );
          continue;
        }

        await sendViaResend({
          to: mail.recipient_email,
          subject: mail.subject,
          html: mail.body_html,
          text: mail.body_text,
          dedupeKey: mail.dedupe_key
        });
        await client.query(
          `UPDATE outbox_emails SET status = 'SENT', sent_at = now(), last_error = NULL WHERE email_id = $1`,
          [mail.email_id]
        );
      } catch (err) {
        const attempts = mail.attempts;
        const permanent = /4\d\d/.test(String(err.message)) && !/429/.test(String(err.message));
        if (attempts >= MAX_ATTEMPTS || permanent) {
          await client.query(
            `UPDATE outbox_emails SET status = 'FAILED', last_error = $2 WHERE email_id = $1`,
            [mail.email_id, String(err.message).slice(0, 500)]
          );
          console.error("[outbox] échec définitif", mail.email_id, err.message);
        } else {
          const wait = BACKOFF_SEC[Math.min(attempts - 1, BACKOFF_SEC.length - 1)];
          await client.query(
            `UPDATE outbox_emails
                SET status = 'PENDING', locked_at = NULL,
                    last_error = $2, next_attempt_at = now() + make_interval(secs => $3)
              WHERE email_id = $1`,
            [mail.email_id, String(err.message).slice(0, 500), wait]
          );
        }
      }
    }
    return picked.rows.length;
  } finally {
    if (owns) client.release();
  }
}

module.exports = { mailEnabled, sendViaResend, drainOutbox };
