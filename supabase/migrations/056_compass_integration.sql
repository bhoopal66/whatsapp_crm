-- ============================================================
-- 056_compass_integration.sql — Taamul Compass (ERP) integration.
--
-- Compass is the ERP that owns the customer master. It talks to this
-- app through the public API (`/api/v1/compass/*`, docs/compass.md)
-- and needs two things stored here:
--
--   1. compass_contacts — Compass's own customer records, kept in a
--      table of their own rather than poured into `contacts`. The CRM
--      contact list is what agents work, and it is scoped per handler
--      (migrations 042/043); tens of thousands of ERP customers who
--      have never written to us do not belong in it. A Compass record
--      is linked to a CRM contact (`contact_id`) the first time Compass
--      messages that customer, which is also when a chat comes to
--      exist. Keyed by Compass's id, so a re-sync is an upsert, never a
--      duplicate.
--
--   2. compass_notifications — one row per status notification Compass
--      asked us to send, keyed by Compass's `idempotency_key`. That key
--      is what makes a retried POST safe: Compass may not see our 201
--      (timeout, restart) and will send again, and a customer must not
--      get "your account is approved" twice. The row is claimed as
--      `sending` BEFORE the gateway call, so a concurrent retry sees
--      the claim instead of racing it.
--
-- Both tables hold customer PII from the ERP, so reading them is
-- admin+ (the Compass contacts screen is admin-only too). There are no
-- INSERT/UPDATE/DELETE policies: every write comes from the API-key
-- routes, which run on the service role.
--
-- Re-runnable: CREATE ... IF NOT EXISTS / DROP POLICY IF EXISTS.
-- ============================================================

CREATE TABLE IF NOT EXISTS compass_contacts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Compass's own customer id. Opaque to us; the upsert key.
  compass_id         text NOT NULL,
  name               text,
  -- International number, digits only (the API normalises "+971 50…"
  -- on the way in, the same form `contacts.phone` uses). NULL is
  -- allowed: an ERP record without a mobile number is still a record,
  -- it just cannot be messaged.
  phone              text,
  phone_normalized   text GENERATED ALWAYS AS (
                       NULLIF(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), '')
                     ) STORED,
  email              text,
  company            text,
  -- Everything else Compass wants to keep alongside the record
  -- (branch, customer type, relationship manager, ...). Replaced
  -- wholesale on every upsert, like the other columns.
  attributes         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The CRM contact this customer became, once Compass messaged them.
  contact_id         uuid REFERENCES contacts(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compass_contacts_account_compass_id_key UNIQUE (account_id, compass_id)
);

-- Keyset pagination for the list endpoint (created_at DESC, id DESC).
CREATE INDEX IF NOT EXISTS idx_compass_contacts_account_created
  ON compass_contacts(account_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_compass_contacts_account_phone
  ON compass_contacts(account_id, phone_normalized);

ALTER TABLE compass_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS compass_contacts_select ON compass_contacts;
CREATE POLICY compass_contacts_select ON compass_contacts FOR SELECT
  USING (is_account_member(account_id, 'admin'));

COMMENT ON TABLE compass_contacts IS
  'Customer records synced from Taamul Compass (the ERP) via /api/v1/compass/contacts. Separate from contacts; linked on first message. See migration 056 and docs/compass.md.';

CREATE TABLE IF NOT EXISTS compass_notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  idempotency_key   text NOT NULL,
  compass_id        text,
  -- Free-form labels Compass supplies for its own bookkeeping, e.g.
  -- event 'application.status_changed', reference 'APP-2291'.
  event             text,
  reference         text,
  -- NULL only when the request failed before a number was known
  -- (e.g. an unknown compass_id) — the failure is still worth a row.
  phone             text,
  content_text      text,
  status            text NOT NULL DEFAULT 'sending'
                      CHECK (status IN ('sending', 'sent', 'failed')),
  message_id        uuid REFERENCES messages(id) ON DELETE SET NULL,
  conversation_id   uuid REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id        uuid REFERENCES contacts(id) ON DELETE SET NULL,
  error_code        text,
  error_message     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compass_notifications_account_key_key UNIQUE (account_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_compass_notifications_account_created
  ON compass_notifications(account_id, created_at DESC, id DESC);

ALTER TABLE compass_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS compass_notifications_select ON compass_notifications;
CREATE POLICY compass_notifications_select ON compass_notifications FOR SELECT
  USING (is_account_member(account_id, 'admin'));

COMMENT ON TABLE compass_notifications IS
  'Status notifications Taamul Compass asked us to send, one per idempotency_key. Always sent on the Whapi channel. See migration 056 and docs/compass.md.';
