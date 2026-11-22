-- ============================================================
-- Transia — Schéma PostgreSQL (phase 2)
-- Dérivé du cahier « Architecture de la Base de Données »
-- Principes : multi-pays, multi-devise, UUID publics, pas de
-- duplication (companies + roles), prix comparable ≠ assiette de
-- commission, taux de commission stocké par affaire, audit,
-- historique jamais écrasé.
-- Cible : PostgreSQL 14+ (gen_random_uuid natif).
-- ============================================================

BEGIN;

-- ---------- Séquences de numérotation commerciale ----------
-- (numéros mondiaux uniques : RFQ-2026-000001, TR-2026-000001)
CREATE SEQUENCE IF NOT EXISTS rfq_number_seq START 1;
CREATE SEQUENCE IF NOT EXISTS deal_number_seq START 1;
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1;

-- ---------- Référentiels ----------

CREATE TABLE IF NOT EXISTS countries (
  country_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  iso_code          char(2) UNIQUE NOT NULL,
  country_name      text NOT NULL,
  default_currency  char(3),
  default_language  varchar(5),
  market_status     text NOT NULL DEFAULT 'OBSERVATION'
                    CHECK (market_status IN
                      ('NOT_TARGETED','OBSERVATION','BUILDING_DATABASE',
                       'READY_FOR_REVIEW','APPROVED_FOR_LAUNCH','ACTIVE','SUSPENDED')),
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS currencies (
  currency_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  iso_code     char(3) UNIQUE NOT NULL,
  name         text NOT NULL,
  symbol       varchar(8),
  active       boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS languages (
  language_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         varchar(5) UNIQUE NOT NULL,
  name         text NOT NULL,
  active       boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS incoterms (
  incoterm_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           varchar(3) UNIQUE NOT NULL,
  name           text NOT NULL,
  version        varchar(10) NOT NULL DEFAULT '2020',
  transport_scope text,
  active         boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS transport_modes (
  transport_mode_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              varchar(20) UNIQUE NOT NULL, -- ROAD, SEA, AIR, MULTIMODAL
  name              text NOT NULL
);

CREATE TABLE IF NOT EXISTS fx_rates (
  fx_rate_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency  char(3) NOT NULL,
  quote_currency char(3) NOT NULL,
  rate           numeric(18,8) NOT NULL,
  rate_date      date NOT NULL,
  provider       text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (base_currency, quote_currency, rate_date, provider)
);

-- ---------- Entreprises / utilisateurs / contacts ----------

CREATE TABLE IF NOT EXISTS companies (
  company_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name          text NOT NULL,
  trade_name          text,
  company_type        text, -- hint only; roles are authoritative
  country_id          uuid REFERENCES countries(country_id),
  address             text,
  postal_code         text,
  city                text,
  tax_id              text,
  vat_number          text,
  registration_number text,
  website             text,
  main_email          text,
  main_phone          text,
  status              text NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE','PENDING','SUSPENDED','ARCHIVED')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_companies_name ON companies (legal_name);
CREATE INDEX IF NOT EXISTS idx_companies_country ON companies (country_id);

CREATE TABLE IF NOT EXISTS company_roles (
  company_role_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  role_type       text NOT NULL
                  CHECK (role_type IN
                    ('SHIPPER','CARRIER','FREIGHT_FORWARDER','FOREIGN_PARTNER',
                     'EXPORTER','IMPORTER','OTHER')),
  active          boolean NOT NULL DEFAULT true,
  start_date      date,
  end_date        date,
  UNIQUE (company_id, role_type)
);

CREATE TABLE IF NOT EXISTS users (
  user_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  first_name     text NOT NULL,
  last_name      text NOT NULL,
  job_title      text,
  email          text UNIQUE NOT NULL,
  phone          text,
  password_hash  text NOT NULL,
  language       varchar(5) DEFAULT 'fr',
  timezone       text DEFAULT 'Europe/Paris',
  role           text NOT NULL DEFAULT 'SHIPPER_USER'
                 CHECK (role IN
                   ('SHIPPER_USER','SHIPPER_ADMIN','CARRIER_USER','CARRIER_ADMIN',
                    'PLATFORM_OPERATIONS','PLATFORM_FINANCE','PLATFORM_ADMIN','SUPER_ADMIN')),
  status         text NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('ACTIVE','PENDING_EMAIL','SUSPENDED','ARCHIVED')),
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_company ON users (company_id);

-- ---------- Sessions (authentification) ----------
-- Token stocké sous forme haché : un vol de la base ne donne pas
-- de session utilisable. Expiration + révocation possibles (spec §13).
-- (placé après users : il référence users.user_id)
CREATE TABLE IF NOT EXISTS sessions (
  session_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  token_hash    text UNIQUE NOT NULL,
  user_agent    text,
  ip_address    text,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS contacts (
  contact_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid REFERENCES companies(company_id) ON DELETE CASCADE,
  first_name   text NOT NULL,
  last_name    text NOT NULL,
  job_title    text,
  email        text,
  phone        text,
  country_id   uuid REFERENCES countries(country_id),
  language     varchar(5) DEFAULT 'fr',
  active       boolean NOT NULL DEFAULT true,
  source_type  text NOT NULL DEFAULT 'DIRECT_REGISTRATION'
               CHECK (source_type IN
                 ('DIRECT_REGISTRATION','RFQ','DEAL','CARRIER_PARTNER','MANUAL_ADMIN','IMPORTED_DATA')),
  source_id    uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts (company_id);

CREATE TABLE IF NOT EXISTS contact_roles (
  contact_role_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      uuid NOT NULL REFERENCES contacts(contact_id) ON DELETE CASCADE,
  role_type       text NOT NULL
                  CHECK (role_type IN
                    ('IMPORT_MANAGER','EXPORT_MANAGER','LOGISTICS_MANAGER','TRANSPORT_MANAGER',
                     'SHIPPING_MANAGER','PURCHASING_MANAGER','GENERAL_MANAGER','OPERATIONS_CONTACT')),
  UNIQUE (contact_id, role_type)
);

-- ---------- Profil transporteur ----------

CREATE TABLE IF NOT EXISTS carrier_profiles (
  carrier_profile_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL UNIQUE REFERENCES companies(company_id) ON DELETE CASCADE,
  validation_status      text NOT NULL DEFAULT 'PENDING'
                         CHECK (validation_status IN ('PENDING','VERIFIED','REJECTED','SUSPENDED')),
  insurance_status       text DEFAULT 'UNKNOWN',
  license_status         text DEFAULT 'UNKNOWN',
  dangerous_goods_allowed boolean NOT NULL DEFAULT false,
  temperature_controlled  boolean NOT NULL DEFAULT false,
  active                 boolean NOT NULL DEFAULT true,
  verified_at            timestamptz,
  verified_by            uuid REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS carrier_transport_modes (
  company_id         uuid NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  transport_mode_id  uuid NOT NULL REFERENCES transport_modes(transport_mode_id),
  active             boolean NOT NULL DEFAULT true,
  PRIMARY KEY (company_id, transport_mode_id)
);

CREATE TABLE IF NOT EXISTS carrier_lanes (
  carrier_lane_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  origin_country_id     uuid REFERENCES countries(country_id),
  destination_country_id uuid REFERENCES countries(country_id),
  transport_mode_id     uuid REFERENCES transport_modes(transport_mode_id),
  active                boolean NOT NULL DEFAULT true,
  priority              int DEFAULT 0
);

CREATE TABLE IF NOT EXISTS carrier_documents (
  document_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  document_type  text NOT NULL,
  file_reference text,
  issue_date     date,
  expiry_date    date,
  status         text NOT NULL DEFAULT 'RECEIVED'
                 CHECK (status IN ('RECEIVED','VERIFIED','EXPIRED','REJECTED')),
  verified_by    uuid REFERENCES users(user_id),
  verified_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_carrier_docs_expiry ON carrier_documents (expiry_date);

-- ---------- RFQ ----------

CREATE TABLE IF NOT EXISTS rfqs (
  rfq_id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_number               text UNIQUE NOT NULL, -- RFQ-2026-000001
  shipper_company_id       uuid NOT NULL REFERENCES companies(company_id),
  created_by_user_id       uuid REFERENCES users(user_id),
  origin_country_id        uuid REFERENCES countries(country_id),
  origin_city              text,
  origin_postal_code       text,
  origin_public_location   text,   -- visible avant confirmation
  origin_private_address   text,   -- débloqué après confirmation
  destination_country_id   uuid REFERENCES countries(country_id),
  destination_city         text,
  destination_postal_code  text,
  destination_public_location text,
  destination_private_address text,
  transport_mode_id        uuid REFERENCES transport_modes(transport_mode_id),
  incoterm_id              uuid REFERENCES incoterms(incoterm_id),
  pickup_date              date,
  delivery_date_requested  date,
  quote_deadline           timestamptz,
  quote_currency_id        uuid REFERENCES currencies(currency_id),
  status                   text NOT NULL DEFAULT 'DRAFT'
                           CHECK (status IN
                             ('DRAFT','PUBLISHED','OPEN','COTATION','CLOSED','ANALYSIS',
                              'RECOMMENDED','ACCEPTED','REFUSED','CONFIRMED','CANCELLED','TERMINATED')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  published_at             timestamptz,
  closed_at                timestamptz
);
CREATE INDEX IF NOT EXISTS idx_rfqs_number ON rfqs (rfq_number);
CREATE INDEX IF NOT EXISTS idx_rfqs_status ON rfqs (status);
CREATE INDEX IF NOT EXISTS idx_rfqs_shipper ON rfqs (shipper_company_id);
CREATE INDEX IF NOT EXISTS idx_rfqs_origin ON rfqs (origin_country_id);
CREATE INDEX IF NOT EXISTS idx_rfqs_dest ON rfqs (destination_country_id);
CREATE INDEX IF NOT EXISTS idx_rfqs_created ON rfqs (created_at);

CREATE TABLE IF NOT EXISTS rfq_cargo (
  rfq_cargo_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id                uuid NOT NULL REFERENCES rfqs(rfq_id) ON DELETE CASCADE,
  description           text,
  package_type          text,
  package_count         int,
  pallet_count          int,
  gross_weight          numeric(12,3),
  volume                numeric(12,3),
  stackable             boolean,
  fragile               boolean,
  temperature_controlled boolean,
  declared_value        numeric(14,2),
  dangerous_goods       boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dangerous_goods_details (
  dangerous_goods_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_cargo_id         uuid NOT NULL REFERENCES rfq_cargo(rfq_cargo_id) ON DELETE CASCADE,
  un_number            text,
  proper_shipping_name text,
  hazard_class         text,
  packing_group        text,
  quantity             text,
  packaging_type       text,
  regulation_reference text,
  safety_data_sheet_file text
);

CREATE TABLE IF NOT EXISTS rfq_attachments (
  attachment_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id          uuid NOT NULL REFERENCES rfqs(rfq_id) ON DELETE CASCADE,
  file_reference  text,
  file_type       text,
  uploaded_by     uuid REFERENCES users(user_id),
  privacy_status  text NOT NULL DEFAULT 'PRIVATE'
                  CHECK (privacy_status IN ('PRIVATE','ANONYMIZED','RELEASE_AFTER_CONFIRMATION')),
  sanitized       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rfq_questions (
  question_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id        uuid NOT NULL REFERENCES rfqs(rfq_id) ON DELETE CASCADE,
  carrier_company_id uuid REFERENCES companies(company_id),
  question_text text NOT NULL,
  status        text NOT NULL DEFAULT 'OPEN'
                CHECK (status IN ('OPEN','ANSWERED')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rfq_answers (
  answer_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES rfq_questions(question_id) ON DELETE CASCADE,
  answer_text text NOT NULL,
  answered_by uuid REFERENCES users(user_id),
  public_to_all_bidders boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Cotations ----------

CREATE TABLE IF NOT EXISTS quotes (
  quote_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id                uuid NOT NULL REFERENCES rfqs(rfq_id) ON DELETE CASCADE,
  carrier_company_id    uuid NOT NULL REFERENCES companies(company_id),
  quote_version         int NOT NULL DEFAULT 1,
  currency_id           uuid NOT NULL REFERENCES currencies(currency_id),
  base_transport_price  numeric(14,2) NOT NULL,
  mandatory_fees_total  numeric(14,2) NOT NULL DEFAULT 0,
  comparable_total       numeric(14,2),  -- transport + frais obligatoires (peut être NULL si à clarifier)
  commissionable_amount  numeric(14,2),  -- transport seul
  transit_time_value    numeric(10,2),
  transit_time_unit     varchar(10) DEFAULT 'day',
  pickup_date           date,
  valid_until           date,
  compliance_status     text NOT NULL DEFAULT 'PENDING'
                        CHECK (compliance_status IN ('CONFORME','A_VERIFIER','NON_CONFORME')),
  rank                  int,
  status                text NOT NULL DEFAULT 'SUBMITTED'
                        CHECK (status IN ('SUBMITTED','CLARIFYING','RANKED','SELECTED','REJECTED','WITHDRAWN')),
  submitted_at          timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, carrier_company_id, quote_version)
);
CREATE INDEX IF NOT EXISTS idx_quotes_rfq ON quotes (rfq_id);
CREATE INDEX IF NOT EXISTS idx_quotes_carrier ON quotes (carrier_company_id);

-- Table la plus importante : ce qui entre dans le prix comparable vs la commission
CREATE TABLE IF NOT EXISTS quote_price_lines (
  quote_price_line_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id               uuid NOT NULL REFERENCES quotes(quote_id) ON DELETE CASCADE,
  line_type              text NOT NULL, -- TRANSPORT, PORT_FEE, INSURANCE_OPTION, ...
  description            text,
  amount                 numeric(14,2) NOT NULL,
  currency_id            uuid NOT NULL REFERENCES currencies(currency_id),
  mandatory              boolean NOT NULL DEFAULT false,
  commissionable         boolean NOT NULL DEFAULT false,
  included_in_comparison boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_price_lines_quote ON quote_price_lines (quote_id);

CREATE TABLE IF NOT EXISTS quote_versions (
  quote_version_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id          uuid NOT NULL REFERENCES quotes(quote_id) ON DELETE CASCADE,
  version_number    int NOT NULL,
  snapshot_data     jsonb NOT NULL,
  modified_by       uuid REFERENCES users(user_id),
  modification_reason text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quote_id, version_number)
);

CREATE TABLE IF NOT EXISTS quote_rankings (
  ranking_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id           uuid NOT NULL REFERENCES rfqs(rfq_id) ON DELETE CASCADE,
  quote_id         uuid NOT NULL REFERENCES quotes(quote_id) ON DELETE CASCADE,
  rank_position    int NOT NULL,
  comparable_price numeric(14,2),
  compliance_score numeric(5,2),
  system_recommended boolean NOT NULL DEFAULT false,
  admin_validated  boolean NOT NULL DEFAULT false,
  admin_user_id    uuid REFERENCES users(user_id),
  admin_reason     text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rankings_rfq ON quote_rankings (rfq_id, rank_position);

CREATE TABLE IF NOT EXISTS rfq_recommendations (
  recommendation_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id                uuid NOT NULL REFERENCES rfqs(rfq_id) ON DELETE CASCADE,
  quote_id              uuid NOT NULL REFERENCES quotes(quote_id),
  system_recommended_at timestamptz NOT NULL DEFAULT now(),
  admin_validated_at    timestamptz,
  sent_to_client_at     timestamptz,
  status                text NOT NULL DEFAULT 'PENDING_ADMIN'
                        CHECK (status IN ('PENDING_ADMIN','VALIDATED','SENT','SUPERSEDED'))
);

-- ---------- Double confirmation + affaires ----------

CREATE TABLE IF NOT EXISTS quote_acceptances (
  acceptance_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id         uuid NOT NULL REFERENCES rfqs(rfq_id) ON DELETE CASCADE,
  quote_id       uuid NOT NULL REFERENCES quotes(quote_id),
  shipper_user_id uuid REFERENCES users(user_id),
  accepted_at    timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'AWAITING_CARRIER'
                 CHECK (status IN ('AWAITING_CARRIER','CONFIRMED','REFUSED','EXPIRED')),
  client_comment text
);

CREATE TABLE IF NOT EXISTS carrier_confirmations (
  confirmation_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acceptance_id    uuid NOT NULL REFERENCES quote_acceptances(acceptance_id) ON DELETE CASCADE,
  carrier_user_id  uuid REFERENCES users(user_id),
  confirmed        boolean NOT NULL DEFAULT false,
  confirmed_at     timestamptz,
  refusal_reason   text
);

CREATE TABLE IF NOT EXISTS deals (
  deal_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_number          text UNIQUE NOT NULL, -- TR-2026-000001
  rfq_id               uuid NOT NULL REFERENCES rfqs(rfq_id),
  quote_id             uuid NOT NULL REFERENCES quotes(quote_id),
  shipper_company_id   uuid NOT NULL REFERENCES companies(company_id),
  carrier_company_id   uuid NOT NULL REFERENCES companies(company_id),
  deal_currency_id     uuid NOT NULL REFERENCES currencies(currency_id),
  transport_amount     numeric(14,2) NOT NULL,
  commissionable_amount numeric(14,2) NOT NULL,
  commission_rate      numeric(6,4) NOT NULL DEFAULT 0.08, -- taux EFFECTIF figé par affaire (commission / assiette)
  commission_amount    numeric(14,2) NOT NULL,
  status               text NOT NULL DEFAULT 'CONFIRMED'
                       CHECK (status IN
                         ('AWAITING_CARRIER','CONFIRMED','IN_PROGRESS','COMPLETED',
                          'CANCELLED_CLIENT','CANCELLED_CARRIER','DISPUTED')),
  confirmed_at         timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz,
  cancelled_at         timestamptz
);
CREATE INDEX IF NOT EXISTS idx_deals_number ON deals (deal_number);
CREATE INDEX IF NOT EXISTS idx_deals_carrier ON deals (carrier_company_id);

CREATE TABLE IF NOT EXISTS commissions (
  commission_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id                uuid NOT NULL REFERENCES deals(deal_id) ON DELETE CASCADE,
  carrier_company_id     uuid NOT NULL REFERENCES companies(company_id),
  commissionable_amount  numeric(14,2) NOT NULL,
  commission_rate        numeric(6,4) NOT NULL,
  commission_amount      numeric(14,2) NOT NULL,
  tax_amount             numeric(14,2) NOT NULL DEFAULT 0,
  total_amount           numeric(14,2) NOT NULL,
  status                 text NOT NULL DEFAULT 'CALCULATED'
                         CHECK (status IN ('CALCULATED','TO_INVOICE','INVOICED','PAID','OVERDUE','DISPUTED','CANCELLED')),
  due_date               date,
  paid_at                timestamptz
);
CREATE INDEX IF NOT EXISTS idx_commissions_status ON commissions (status);

CREATE TABLE IF NOT EXISTS invoices (
  invoice_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number    text UNIQUE NOT NULL,
  carrier_company_id uuid NOT NULL REFERENCES companies(company_id),
  issue_date        date NOT NULL,
  due_date          date,
  currency_id       uuid NOT NULL REFERENCES currencies(currency_id),
  subtotal          numeric(14,2) NOT NULL,
  tax_total         numeric(14,2) NOT NULL DEFAULT 0,
  total             numeric(14,2) NOT NULL,
  status            text NOT NULL DEFAULT 'ISSUED'
                    CHECK (status IN ('DRAFT','ISSUED','PAID','OVERDUE','CANCELLED')),
  file_reference    text
);

CREATE TABLE IF NOT EXISTS invoice_commissions (
  invoice_id     uuid NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  commission_id  uuid NOT NULL REFERENCES commissions(commission_id),
  PRIMARY KEY (invoice_id, commission_id)
);

-- ---------- Incidents / anti-contournement / audit ----------

CREATE TABLE IF NOT EXISTS incidents (
  incident_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_type       text NOT NULL,
  related_entity_type text,
  related_entity_id   uuid,
  reported_by         uuid REFERENCES users(user_id),
  description         text,
  severity            text NOT NULL DEFAULT 'INFO'
                      CHECK (severity IN ('INFO','ATTENTION','IMPORTANT','CRITICAL')),
  status              text NOT NULL DEFAULT 'OPEN'
                      CHECK (status IN ('OPEN','ANALYSIS','ACTION_REQUIRED','RESOLVED','CLASSIFIED')),
  assigned_to         uuid REFERENCES users(user_id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz
);

CREATE TABLE IF NOT EXISTS content_flags (
  flag_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type      text NOT NULL,
  entity_id        uuid NOT NULL,
  flag_type        text NOT NULL
                   CHECK (flag_type IN ('PHONE_DETECTED','EMAIL_DETECTED','URL_DETECTED','COMPANY_NAME_DETECTED')),
  detected_content text,
  risk_level       text NOT NULL DEFAULT 'ATTENTION'
                   CHECK (risk_level IN ('INFO','ATTENTION','IMPORTANT','CRITICAL')),
  status           text NOT NULL DEFAULT 'OPEN'
                   CHECK (status IN ('OPEN','ALLOWED','MASKED','BLOCKED')),
  reviewed_by      uuid REFERENCES users(user_id),
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       uuid,
  action_type   text NOT NULL,
  entity_type   text,
  entity_id     uuid,
  old_value     jsonb,
  new_value     jsonb,
  reason        text,
  ip_address    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);

CREATE TABLE IF NOT EXISTS internal_notes (
  note_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  text NOT NULL,
  entity_id    uuid NOT NULL,
  note_text    text NOT NULL,
  created_by   uuid REFERENCES users(user_id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------- Expansion : relations internationales ----------

CREATE TABLE IF NOT EXISTS international_relationships (
  relationship_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_company_id  uuid REFERENCES companies(company_id),
  target_company_id  uuid REFERENCES companies(company_id),
  source_country_id  uuid REFERENCES countries(country_id),
  target_country_id  uuid REFERENCES countries(country_id),
  relationship_type  text NOT NULL,
  related_deal_id    uuid REFERENCES deals(deal_id),
  related_rfq_id     uuid REFERENCES rfqs(rfq_id),
  source_contact_id  uuid REFERENCES contacts(contact_id),
  target_contact_id  uuid REFERENCES contacts(contact_id),
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rel_source_country ON international_relationships (source_country_id);
CREATE INDEX IF NOT EXISTS idx_rel_target_country ON international_relationships (target_country_id);

COMMIT;

/* ============================================================
   Migrations (idempotentes) — incrément 2 : cycle métier complet
   ============================================================ */
BEGIN;

-- Paramètres de la plateforme (clé/valeur, réservé aux réglages
-- d'exploitation : seuils, drapeaux, libellés).
--
-- Le taux de commission n'y figure plus. Depuis le passage au barème
-- dégressif, la commission est une grille publiée dans la clause CGU
-- transporteur, implémentée une seule fois dans assets/js/commission.js.
-- La rendre modifiable en base ferait diverger la facturation du contrat
-- signé par le transporteur : un changement de barème passe par une
-- révision des CGU et du code, pas par un réglage d'exploitation.
CREATE TABLE IF NOT EXISTS platform_settings (
  setting_key   text PRIMARY KEY,
  setting_value text NOT NULL,
  updated_by    uuid REFERENCES users(user_id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Nettoyage des bases existantes : l'ancien taux forfaitaire n'est plus lu.
DELETE FROM platform_settings WHERE setting_key = 'commission_rate';

-- Protection brute-force / credential stuffing sur les endpoints d'auth.
-- Côté base : partagé entre toutes les instances serverless.
CREATE TABLE IF NOT EXISTS login_attempts (
  attempt_key  text NOT NULL,          -- hash de l'e-mail ou de l'IP
  succeeded    boolean NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts (attempt_key, created_at);

-- Motifs de refus d'offre (alimentent l'analyse commerciale, spec §14)
CREATE TABLE IF NOT EXISTS rfq_refusals (
  refusal_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id       uuid NOT NULL REFERENCES rfqs(rfq_id) ON DELETE CASCADE,
  quote_id     uuid REFERENCES quotes(quote_id) ON DELETE SET NULL,
  refused_by   uuid REFERENCES users(user_id),
  motif        text NOT NULL,
  comment      text,
  rfq_closed   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refusals_rfq ON rfq_refusals (rfq_id);

-- Colonnes de cotation absentes du schéma initial (conformité périmètre)
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS fees_to_specify  boolean NOT NULL DEFAULT false;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS scope_comparable boolean NOT NULL DEFAULT true;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS non_compliance_reason text;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS conditions text;

-- Séquence du numéro d'affaire mondial : TR-2026-000001
CREATE SEQUENCE IF NOT EXISTS deal_number_seq;

-- Recherches (spec §66)
CREATE INDEX IF NOT EXISTS idx_rfqs_origin_city ON rfqs (origin_city);
CREATE INDEX IF NOT EXISTS idx_rfqs_dest_city   ON rfqs (destination_city);

COMMIT;

/* ============================================================
   Migrations (idempotentes) — incrément 3 : notifications
   transactionnelles + vérification d'e-mail
   ============================================================ */
BEGIN;

-- Colonne de vérification d'e-mail sur l'utilisateur
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

-- Vérification d'e-mail à l'inscription : jeton haché (un vol de
-- la base ne donne pas de lien de vérification utilisable).
CREATE TABLE IF NOT EXISTS email_verifications (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  email      text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_verif_user ON email_verifications (user_id);

-- Outbox transactionnelle : l'e-mail est écrit DANS LA MÊME
-- TRANSACTION que l'événement métier (jamais d'envoi direct au sein
-- d'une requête : échec réseau = événement perdu). Un worker (cron
-- Vercel) draine la file avec backoff exponentiel et verrouillage
-- optimiste — robuste face aux instances serverless multiples.
CREATE TABLE IF NOT EXISTS outbox_emails (
  email_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedupe_key        text UNIQUE,           -- anti double-envoi sur rejeu
  event_type        text NOT NULL,         -- rfq_created, recommendation_ready, ...
  entity_type       text,                  -- rfqs, deals, companies...
  entity_id         uuid,
  recipient_email   text NOT NULL,
  recipient_user_id uuid,
  subject           text NOT NULL,
  body_text         text NOT NULL,
  body_html         text NOT NULL,
  status            text NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','SENDING','SENT','LOGGED','FAILED')),
  attempts          int NOT NULL DEFAULT 0,
  last_error        text,
  locked_at         timestamptz,
  sent_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Horodatage du prochain essai (backoff : 30 s, 2 min, 10 min, 1 h)
ALTER TABLE outbox_emails ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_emails (status, next_attempt_at);

COMMIT;

/* ============================================================
   Migrations (idempotentes) — incrément 4 : preuve d'acceptation
   des conditions générales
   ============================================================ */
BEGIN;

-- Une ligne par acceptation, jamais réécrite. La version en vigueur
-- est définie côté serveur (api/_lib/terms.js) ; la version stockée
-- est celle du serveur, jamais celle annoncée par le client.
CREATE TABLE IF NOT EXISTS terms_acceptances (
  acceptance_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  company_id       uuid REFERENCES companies(company_id) ON DELETE SET NULL,
  document_type    text NOT NULL
                   CHECK (document_type IN ('SHIPPER_TERMS','CARRIER_TERMS')),
  document_version text NOT NULL,
  accepted_at      timestamptz NOT NULL DEFAULT now(),
  ip_address       text,
  user_agent       text,
  context          text NOT NULL DEFAULT 'REGISTRATION'
                   CHECK (context IN ('REGISTRATION','REACCEPTANCE'))
);

CREATE INDEX IF NOT EXISTS idx_terms_user ON terms_acceptances (user_id, accepted_at DESC);
CREATE INDEX IF NOT EXISTS idx_terms_document ON terms_acceptances (document_type, document_version);

COMMENT ON TABLE terms_acceptances IS
  'Preuve d''acceptation des CGU : version, horodatage, IP, agent. Une ligne par acceptation, non modifiable.';

-- La preuve ne peut pas être réécrite. La suppression du compte
-- reste possible (cascade sur users) : le trigger ne vise que UPDATE.
CREATE OR REPLACE FUNCTION terms_acceptances_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'terms_acceptances est en écriture seule';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_terms_acceptances_immutable ON terms_acceptances;
CREATE TRIGGER trg_terms_acceptances_immutable
  BEFORE UPDATE ON terms_acceptances
  FOR EACH ROW EXECUTE FUNCTION terms_acceptances_immutable();

COMMIT;
