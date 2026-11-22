/* ============================================================
   Transia — api/_lib/terms.js
   Acceptation des conditions générales.

   - La version en vigueur est définie ICI, côté serveur. Le client
     affiche cette version et la renvoie ; si la page est restée
     ouverte pendant une mise à jour des conditions, le serveur
     refuse au lieu d'enregistrer une acceptation qui ne correspond
     pas au texte affiché.
   - La version enregistrée est toujours celle du serveur : un
     client ne peut pas déclarer avoir accepté un autre texte.
   - Un seul analyseur (parseAcceptance) sert l'inscription, la
     connexion et l'acceptation depuis une session ouverte.
   - L'écriture est idempotente en base (index unique + ON CONFLICT) :
     deux onglets qui acceptent en même temps ne créent qu'une preuve.
   ============================================================ */
"use strict";

const { clientIp } = require("./security");
const { query } = require("./db");

/* Changer une version ici publie de nouvelles conditions : les
   pages d'inscription doivent être mises à jour en conséquence
   (assets/js/terms.js) et les comptes existants ré-accepter. */
const DOCUMENTS = {
  SHIPPER: {
    documentType: "SHIPPER_TERMS",
    version: "1.0",
    label: "Conditions générales d'utilisation — donneur d'ordre",
    url: "juridique.html"
  },
  CARRIER: {
    documentType: "CARRIER_TERMS",
    version: "1.0",
    label: "Conditions d'accès et d'intermédiation — transporteur",
    url: "juridique.html"
  }
};

/* Document applicable au rôle. Les comptes plateforme (exploitation,
   finance, administration) ne sont pas soumis aux conditions des
   utilisateurs : ils n'ont pas de relation commerciale avec la
   plateforme. */
function termsForRole(role) {
  const r = String(role || "");
  if (r.indexOf("SHIPPER_") === 0) return DOCUMENTS.SHIPPER;
  if (r.indexOf("CARRIER_") === 0) return DOCUMENTS.CARRIER;
  return null;
}

/* Une acceptation de cette version existe-t-elle déjà ? */
async function hasAccepted(userId, terms) {
  const r = await query(
    `SELECT 1 FROM terms_acceptances
      WHERE user_id = $1 AND document_type = $2 AND document_version = $3
      LIMIT 1`,
    [userId, terms.documentType, terms.version]
  );
  return r.rows.length > 0;
}

function currentTerms(kind) {
  const doc = DOCUMENTS[kind];
  if (!doc) throw new Error("Type de document inconnu : " + kind);
  return doc;
}

/* Analyse l'acceptation envoyée par le client.
   { accepted, reason: "MISSING" | "OUTDATED" | null } */
function parseAcceptance(body, terms) {
  if (!body || body.termsAccepted !== true) {
    return { accepted: false, reason: "MISSING" };
  }
  const sent = String(body.termsVersion == null ? "" : body.termsVersion).trim();
  if (sent !== terms.version) {
    return { accepted: false, reason: "OUTDATED" };
  }
  return { accepted: true, reason: null };
}

/* Refus HTTP correspondant, partagé par les trois parcours. */
function acceptanceError(reason) {
  if (reason === "OUTDATED") {
    return {
      status: 409, code: "TERMS_VERSION_OUTDATED",
      message: "Les conditions générales ont été mises à jour. Rechargez la page pour en prendre connaissance."
    };
  }
  return {
    status: 400, code: "TERMS_NOT_ACCEPTED",
    message: "Vous devez accepter les conditions générales pour continuer."
  };
}

/* Contrôle avant écriture (inscription, transporteur).
   { ok:false, status, code, message } ou { ok:true, terms }. */
function checkAcceptance(body, kind) {
  const terms = currentTerms(kind);
  const state = parseAcceptance(body, terms);
  if (state.accepted) return { ok: true, terms };
  return Object.assign({ ok: false }, acceptanceError(state.reason));
}

/* Écrit la preuve. `client` est la transaction de l'inscription, ou
   { query } pour une session déjà ouverte.
   ON CONFLICT : l'unicité est tenue par la base, donc deux requêtes
   simultanées ne peuvent pas produire deux lignes. */
async function recordAcceptance(client, { userId, companyId, terms, req, context }) {
  const ip = clientIp(req);
  const userAgent = String(req.headers["user-agent"] || "").slice(0, 300);

  const r = await client.query(
    `INSERT INTO terms_acceptances
       (user_id, company_id, document_type, document_version, ip_address, user_agent, context)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, document_type, document_version) DO NOTHING
     RETURNING acceptance_id`,
    [
      userId,
      companyId,
      terms.documentType,
      terms.version,
      ip === "unknown" ? null : ip,
      userAgent,
      context || "REGISTRATION"
    ]
  );

  return {
    inserted: r.rowCount === 1,
    documentType: terms.documentType,
    version: terms.version
  };
}

module.exports = {
  DOCUMENTS, currentTerms, termsForRole, hasAccepted,
  parseAcceptance, acceptanceError, checkAcceptance, recordAcceptance
};
