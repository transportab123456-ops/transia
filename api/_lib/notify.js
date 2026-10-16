/* ============================================================
   Transia — api/_lib/notify.js
   Notifications transactionnelles (pattern outbox).
   - enqueueEmail(client, {...}) : écrit l'é-mail DANS LA MÊME
     TRANSACTION que l'événement métier (le client PostgreSQL est
     passé par l'appelant). Un commit réussi garantit que
     l'événement sera traité ; un rollback ne laisse aucun e-mail.
   - flushOutbox() : meilleur-effort APRÈS le commit (appelé par le
     cron /api/cron/flush-emails et en fin de requêtes clés).
   - Gabarits : e-mails français, texte + HTML sobre.
   ============================================================ */
"use strict";

const { drainOutbox } = require("./mailer");

const APP_URL = (process.env.APP_URL || "https://transia-sooty.vercel.app").replace(/\/+$/, "");

/* ---------- Gabarit commun ---------- */
function wrap(title, introHtml, ctaLabel, ctaUrl, outroHtml) {
  const cta = ctaLabel && ctaUrl
    ? `<p style="margin:26px 0;"><a href="${ctaUrl}" style="background:#0f2c4e;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block;">${ctaLabel}</a></p>`
    : "";
  return {
    html: `<div style="font-family:Georgia,'Times New Roman',serif;background:#f4f7fb;padding:28px 16px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #dde6f0;border-radius:12px;padding:32px 30px;">
    <p style="font-size:15px;letter-spacing:2px;color:#0f2c4e;font-weight:700;margin:0 0 18px;">◆ TRANSIA</p>
    <h1 style="font-size:21px;color:#0f2c4e;margin:0 0 14px;font-weight:600;">${title}</h1>
    ${introHtml}
    ${cta}
    ${outroHtml || ""}
    <p style="font-size:12px;color:#8aa0bb;margin-top:30px;border-top:1px solid #dde6f0;padding-top:14px;">
      Cet e-mail est envoyé par la plateforme Transia — mise en relation transport internationale.<br/>
      Ne répondez pas à ce message : il est automatique.
    </p>
  </div>
</div>`
  };
}

function row(label, value) {
  return `<p style="font-size:14px;color:#41597a;margin:4px 0;"><b style="color:#0f2c4e;">${label}</b> ${value}</p>`;
}

/* ---------- Gabarits par événement ---------- */
const TEMPLATES = {
  /* Inscription : lien de vérification d'e-mail */
  email_verification: (v) => {
    const url = `${APP_URL}/auth.html?verify=${encodeURIComponent(v.token)}`;
    const t = wrap(
      "Confirmez votre adresse e-mail",
      `<p style="font-size:14.5px;color:#41597a;line-height:1.6;">Bonjour ${v.firstName},</p>
       <p style="font-size:14.5px;color:#41597a;line-height:1.6;">Bienvenue sur Transia. Pour activer votre compte <b>${v.companyName}</b>, confirmez cette adresse e-mail en cliquant sur le bouton ci-dessous. Ce lien expire dans 24 heures.</p>`,
      "Confirmer mon e-mail", url,
      `<p style="font-size:12.5px;color:#8aa0bb;">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br/>${url}</p>`
    );
    return { subject: "Transia — confirmez votre adresse e-mail", text: `Confirmez votre adresse e-mail en ouvrant ce lien (valable 24 h) :\n${url}\n\nBonjour ${v.firstName}, bienvenue sur Transia pour ${v.companyName}.`, html: t.html };
  },

  /* Bienvenue (sans vérification) */
  welcome: (v) => {
    const url = `${APP_URL}/demande.html`;
    const t = wrap(
      "Bienvenue sur Transia",
      `<p style="font-size:14.5px;color:#41597a;line-height:1.6;">Bonjour ${v.firstName},</p>
       <p style="font-size:14.5px;color:#41597a;line-height:1.6;">Votre compte <b>${v.companyName}</b> est actif. Publiez votre première demande de cotation : les transporteurs vérifiés y répondent <b>à l'aveugle</b>, et vous comparez des prix normalisés en euros.</p>`,
      "Publier une demande", url
    );
    return { subject: "Bienvenue sur Transia", text: `Bonjour ${v.firstName}, votre compte ${v.companyName} est actif. Publiez votre première demande : ${url}`, html: t.html };
  },

  /* Nouvelle RFQ : confirmation au donneur */
  rfq_created: (v) => {
    const url = `${APP_URL}/comparateur.html?ref=${encodeURIComponent(v.rfqNumber)}`;
    const t = wrap(
      `Votre demande ${v.rfqNumber} est publiée`,
      `<p style="font-size:14.5px;color:#41597a;line-height:1.6;">Bonjour ${v.firstName},</p>
       <p style="font-size:14.5px;color:#41597a;line-height:1.6;">Votre demande de cotation est en ligne sur le marché. Les transporteurs vérifiés la voient <b>sans votre identité</b> et déposent leurs offres en aveugle.</p>
       ${row("Trajet", v.route)}
       ${row("Mode", v.mode)}`,
      "Suivre les offres", url
    );
    return { subject: `Demande ${v.rfqNumber} publiée sur Transia`, text: `Votre demande ${v.rfqNumber} (${v.route}, ${v.mode}) est publiée. Suivez les offres : ${url}`, html: t.html };
  },

  /* Offre reçue : notification au donneur (anonyme, pas de montant) */
  quote_received: (v) => {
    const url = `${APP_URL}/comparateur.html?ref=${encodeURIComponent(v.rfqNumber)}`;
    const t = wrap(
      `Une offre a été déposée sur ${v.rfqNumber}`,
      `<p style="font-size:14.5px;color:#41597a;line-height:1.6;">Bonjour ${v.firstName},</p>
       <p style="font-size:14.5px;color:#41597a;line-height:1.6;">Une nouvelle offre anonyme vient d'être déposée sur votre demande <b>${v.rfqNumber}</b>. Elle sera normalisée (prix comparable en euros) et présentée après analyse.</p>`,
      "Voir le comparateur", url
    );
    return { subject: `Nouvelle offre anonyme sur ${v.rfqNumber}`, text: `Une nouvelle offre anonyme a été déposée sur ${v.rfqNumber}. Voir : ${url}`, html: t.html };
  },

  /* Recommandation prête : au donneur */
  recommendation_ready: (v) => {
    const url = `${APP_URL}/comparateur.html?ref=${encodeURIComponent(v.rfqNumber)}`;
    const t = wrap(
      `Votre comparatif ${v.rfqNumber} est prêt`,
      `<p style="font-size:14.5px;color:#41597a;line-height:1.6;">Bonjour ${v.firstName},</p>
       <p style="font-size:14.5px;color:#41597a;line-height:1.6;">L'administration a validé la recommandation pour votre demande <b>${v.rfqNumber}</b>. Consultez le classement des offres, puis acceptez ou refusez.</p>
       ${v.offers ? row("Offres reçues", v.offers) : ""}`,
      "Décider maintenant", url
    );
    return { subject: `Comparatif ${v.rfqNumber} prêt — à valider`, text: `La recommandation pour ${v.rfqNumber} est validée et vous attend : ${url}`, html: t.html };
  },

  /* Acceptation : au transporteur pressenti */
  quote_accepted: (v) => {
    const url = `${APP_URL}/transporteur.html`;
    const t = wrap(
      `Vous avez été pressenti sur ${v.rfqNumber}`,
      `<p style="font-size:14.5px;color:#41597a;line-height:1.6;">Bonjour ${v.firstName},</p>
       <p style="font-size:14.5px;color:#41597a;line-height:1.6;">Le donneur d'ordre a accepté votre offre sur la demande <b>${v.rfqNumber}</b>. <b>Confirmez votre disponibilité</b> pour créer l'affaire : sans votre confirmation, l'offre n'est pas attribuée.</p>
       ${row("Prix comparable accepté", v.price)}
       ${row("Confirmation attendue sous", "48 heures")}`,
      "Confirmer l'affaire", url
    );
    return { subject: `Pressenti sur ${v.rfqNumber} — confirmation requise`, text: `Le donneur d'ordre a accepté votre offre sur ${v.rfqNumber} (${v.price}). Vous devez confirmer votre disponibilité sous 48 heures : sans confirmation, l'offre n'est pas attribuée. ${url}`, html: t.html };
  },

  /* Affaire confirmée : aux deux parties (appelé avec les deux destinataires) */
  deal_confirmed: (v) => {
    const url = `${APP_URL}/comparateur.html?ref=${encodeURIComponent(v.rfqNumber)}`;
    const t = wrap(
      `Affaire ${v.dealNumber} confirmée`,
      `<p style="font-size:14.5px;color:#41597a;line-height:1.6;">Bonjour ${v.firstName},</p>
       <p style="font-size:14.5px;color:#41597a;line-height:1.6;">Le contrat est conclu : les identités sont dévoilées aux deux parties et l'affaire est horodatée.</p>
       ${row("Affaire", v.dealNumber)}
       ${row("Trajet", v.route)}
       ${row("Montant transport", v.price)}
       ${v.commission ? row("Commission plateforme (" + v.rate + ")", v.commission) : ""}`,
      "Voir l'affaire", url
    );
    return { subject: `Affaire ${v.dealNumber} confirmée`, text: `Affaire ${v.dealNumber} confirmée : ${v.route}, ${v.price}.${v.commission ? ` Commission plateforme (${v.rate}) : ${v.commission}.` : ""} Identités dévoilées aux deux parties. Voir : ${url}`, html: t.html };
  },

  /* Décision de vérification transporteur */
  carrier_decision: (v) => {
    const url = `${APP_URL}/transporteur.html`;
    const ok = v.decision === "VERIFIED";
    const t = wrap(
      ok ? "Votre compte transporteur est vérifié" : v.decision === "SUSPENDED" ? "Votre compte est suspendu" : "Votre demande d'inscription a été refusée",
      `<p style="font-size:14.5px;color:#41597a;line-height:1.6;">Bonjour ${v.firstName},</p>
       <p style="font-size:14.5px;color:#41597a;line-height:1.6;">${ok
        ? "Votre compte est vérifié : vous avez accès au marché des demandes ouvertes et pouvez déposer des offres à l'aveugle."
        : `La plateforme a examiné votre dossier : décision <b>${v.decision === "SUSPENDED" ? "suspension" : "rejet"}</b>.${v.reason ? " Motif : " + v.reason : ""}`}</p>`,
      ok ? "Accéder au marché" : null, ok ? url : null
    );
    const subject = ok
      ? "Transia — compte vérifié, accès au marché activé"
      : v.decision === "SUSPENDED"
        ? "Transia — votre compte est suspendu"
        : "Transia — votre demande d'inscription a été refusée";
    return { subject, text: `${ok ? "Votre compte transporteur est vérifié : l'accès au marché est activé." : `Décision de la plateforme : ${v.decision === "SUSPENDED" ? "suspension" : "rejet"} du compte.`}${v.reason ? " Motif : " + v.reason : ""}`, html: t.html };
  },

  /* Nouvelle offre : notification plateforme (file de travail) */
  quote_received_admin: (v) => {
    const url = `${APP_URL}/admin.html`;
    const t = wrap(
      `Nouvelle offre reçue — ${v.rfqNumber}`,
      `<p style="font-size:14.5px;color:#41597a;line-height:1.6;">Une nouvelle offre anonyme vient d'être déposée sur la demande <b>${v.rfqNumber}</b> (${v.route}). Pensez au classement et à la validation de la recommandation une fois la cotation close.</p>`,
      "Ouvrir le back-office", url
    );
    return { subject: `Nouvelle offre sur ${v.rfqNumber}`, text: `Nouvelle offre déposée sur ${v.rfqNumber} (${v.route}). Back-office : ${url}`, html: t.html };
  }
};

/* ---------- Écriture transactionnelle ---------- */
async function enqueueEmail(client, { dedupeKey, eventType, entityType, entityId, to, userId, vars }) {
  const tpl = TEMPLATES[eventType];
  if (!tpl) throw new Error("Template d'e-mail inconnu : " + eventType);
  if (!to) return null;
  const mail = tpl(vars || {});

  /* ON CONFLICT sur la clé de déduplication : un rejeu de la
     requête métier n'envoie jamais deux fois le même e-mail. */
  const r = await client.query(
    `INSERT INTO outbox_emails (dedupe_key, event_type, entity_type, entity_id, recipient_email, recipient_user_id, subject, body_text, body_html)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING email_id`,
    [
      dedupeKey || null, eventType, entityType || null, entityId || null,
      to, userId || null, mail.subject, mail.text, mail.html
    ]
  );
  return r.rows.length ? r.rows[0].email_id : null;
}

/* Dérive les destinataires (e-mails) dans une transaction. */
async function companyEmails(client, companyId) {
  const r = await client.query(
    `SELECT u.user_id, u.email, u.first_name FROM users u
      WHERE u.company_id = $1 AND u.status = 'ACTIVE'
      ORDER BY (u.last_login_at IS NULL), u.last_login_at DESC NULLS LAST
      LIMIT 1`,
    [companyId]
  );
  return r.rows[0] || null;
}

async function adminEmails(client) {
  const r = await client.query(
    `SELECT user_id, email, first_name FROM users
      WHERE role IN ('PLATFORM_OPERATIONS','PLATFORM_ADMIN','SUPER_ADMIN') AND status = 'ACTIVE'
      ORDER BY (last_login_at IS NULL), last_login_at DESC NULLS LAST
      LIMIT 3`,
    []
  );
  return r.rows;
}

/* Flush best-effort après commit. N'échoue jamais la requête. */
async function flushOutbox() {
  try {
    await drainOutbox(5);
  } catch (err) {
    console.error("[notify] flush:", err.message);
  }
}

module.exports = { enqueueEmail, companyEmails, adminEmails, flushOutbox, APP_URL };
