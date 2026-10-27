-- ============================================================
-- 139_taamul_sales_interested.sql — "contact marked as interested"
-- webhooks from the Taamul sales app (opendesk.taamul.ae).
--
-- When a sales agent marks a contact Interested, the sales app POSTs one
-- signed event to POST /api/taamul-sales/webhook (docs/taamul-sales.md).
-- The route verifies it and calls taamul_sales_record_interested(),
-- which in ONE transaction:
--
--  * claims the event id in taamul_sales_events (its primary key). A
--    replayed or concurrent duplicate inserts nothing and returns
--    'duplicate', so a retry is a no-op. The row keeps the raw payload:
--    it is the per-mark history (agent, call notes, lead) of a contact.
--  * upserts the sales app's contact into taamul_sales_contacts, keyed
--    by (account_id, taamul_contact_id). Delivery is unordered, so the
--    snapshot columns are only rewritten by an event at least as new as
--    the one they came from; interested_count and first_interested_at
--    count every event.
--
-- Like compass_contacts (056), these customers are kept apart from the
-- CRM's contacts, so agents' contact lists are not flooded: nothing here
-- writes `contacts`. Admins see them under OpenDesk in the sidebar.
--
-- An error anywhere rolls the whole call back, the route answers 503 and
-- the sales app redelivers, so a failed event is never marked seen.
--
-- Both tables hold customer personal data: admins and owners of the
-- workspace may read them (056's rule for Compass customers); only the
-- service role writes them or runs the function.
--
-- Re-runnable: IF NOT EXISTS, CREATE OR REPLACE.
-- ============================================================

SET lock_timeout = '5s';

-- ---------- 1. The sales app's contacts ----------

CREATE TABLE IF NOT EXISTS public.taamul_sales_contacts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- contact.id in the sales app.
  taamul_contact_id    text NOT NULL,
  customer_name        text NULL,
  company_name         text NULL,
  -- Digits with country code (971501234567); NULL when unusable.
  phone                text NULL,
  -- As the sales app sent it (0501234567).
  phone_raw            text NULL,
  additional_phones    text[] NOT NULL DEFAULT '{}',
  trade_license_number text NULL,
  industry             text NULL,
  area                 text NULL,
  city                 text NULL,
  is_existing_customer boolean NULL,
  agent_id             text NULL,
  agent_username       text NULL,
  agent_name           text NULL,
  agent_email          text NULL,
  agent_team           text NULL,
  call_feedback_id     text NULL,
  called_at            timestamptz NULL,
  call_notes           text NULL,
  lead_id              text NULL,
  lead_status          text NULL,
  lead_created_at      timestamptz NULL,
  interested_count     integer NOT NULL DEFAULT 0,
  first_interested_at  timestamptz NULL,
  -- occurred_at of the event the snapshot columns came from.
  last_interested_at   timestamptz NULL,
  last_event_id        text NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, taamul_contact_id)
);

CREATE INDEX IF NOT EXISTS taamul_sales_contacts_recent_idx
  ON public.taamul_sales_contacts (account_id, last_interested_at DESC);

COMMENT ON TABLE public.taamul_sales_contacts IS
  'Contacts the Taamul sales app (OpenDesk) marked Interested (139), one row per sales-app contact, latest event''s details. Separate from contacts. Admins read; service role writes.';

-- ---------- 2. Every event received ----------

CREATE TABLE IF NOT EXISTS public.taamul_sales_events (
  -- event_id in the sales app: the same across its retries.
  event_id          text PRIMARY KEY,
  account_id        uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  event_type        text NOT NULL,
  occurred_at       timestamptz NOT NULL,
  taamul_contact_id text NOT NULL,
  delivery_id       text NULL,
  payload           jsonb NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS taamul_sales_events_contact_idx
  ON public.taamul_sales_events (account_id, taamul_contact_id, occurred_at DESC);

COMMENT ON TABLE public.taamul_sales_events IS
  'Each Taamul sales-app event once (139): the dedupe key and the raw payload. Admins read; service role writes.';

ALTER TABLE public.taamul_sales_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.taamul_sales_events   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS taamul_sales_contacts_select ON public.taamul_sales_contacts;
CREATE POLICY taamul_sales_contacts_select ON public.taamul_sales_contacts FOR SELECT
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS taamul_sales_events_select ON public.taamul_sales_events;
CREATE POLICY taamul_sales_events_select ON public.taamul_sales_events FOR SELECT
  USING (is_account_member(account_id, 'admin'));

REVOKE ALL ON public.taamul_sales_contacts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.taamul_sales_events   FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.taamul_sales_contacts TO authenticated;
GRANT SELECT ON public.taamul_sales_events   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.taamul_sales_contacts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.taamul_sales_events   TO service_role;

-- ---------- 3. Recording one event ----------

-- p_fields keys (all optional, text unless noted): customer_name,
-- company_name, phone, phone_raw, additional_phones (array),
-- trade_license_number, industry, area, city, is_existing_customer
-- (boolean), agent_id, agent_username, agent_name, agent_email,
-- agent_team, call_feedback_id, called_at, call_notes, lead_id,
-- lead_status, lead_created_at.
CREATE OR REPLACE FUNCTION public.taamul_sales_record_interested(
  p_account_id        uuid,
  p_event_id          text,
  p_event_type        text,
  p_occurred_at       timestamptz,
  p_taamul_contact_id text,
  p_fields            jsonb,
  p_payload           jsonb,
  p_delivery_id       text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_rows int;
  f      jsonb := coalesce(p_fields, '{}'::jsonb);
BEGIN
  INSERT INTO taamul_sales_events
    (event_id, account_id, event_type, occurred_at, taamul_contact_id,
     delivery_id, payload)
  VALUES
    (p_event_id, p_account_id, p_event_type, p_occurred_at,
     p_taamul_contact_id, p_delivery_id, p_payload)
  ON CONFLICT (event_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN 'duplicate';
  END IF;

  INSERT INTO taamul_sales_contacts (account_id, taamul_contact_id)
  VALUES (p_account_id, p_taamul_contact_id)
  ON CONFLICT (account_id, taamul_contact_id) DO NOTHING;

  -- Every event counts, whatever order it arrives in.
  UPDATE taamul_sales_contacts
     SET interested_count    = interested_count + 1,
         first_interested_at = LEAST(coalesce(first_interested_at, p_occurred_at), p_occurred_at),
         updated_at          = now()
   WHERE account_id = p_account_id
     AND taamul_contact_id = p_taamul_contact_id;

  -- Only an event at least as new as the snapshot rewrites it.
  UPDATE taamul_sales_contacts
     SET customer_name        = f->>'customer_name',
         company_name         = f->>'company_name',
         phone                = f->>'phone',
         phone_raw            = f->>'phone_raw',
         additional_phones    = coalesce(
                                  ARRAY(SELECT jsonb_array_elements_text(
                                    CASE WHEN jsonb_typeof(f->'additional_phones') = 'array'
                                         THEN f->'additional_phones' ELSE '[]'::jsonb END)),
                                  '{}'),
         trade_license_number = f->>'trade_license_number',
         industry             = f->>'industry',
         area                 = f->>'area',
         city                 = f->>'city',
         is_existing_customer = (f->>'is_existing_customer')::boolean,
         agent_id             = f->>'agent_id',
         agent_username       = f->>'agent_username',
         agent_name           = f->>'agent_name',
         agent_email          = f->>'agent_email',
         agent_team           = f->>'agent_team',
         call_feedback_id     = f->>'call_feedback_id',
         called_at            = (f->>'called_at')::timestamptz,
         call_notes           = f->>'call_notes',
         lead_id              = f->>'lead_id',
         lead_status          = f->>'lead_status',
         lead_created_at      = (f->>'lead_created_at')::timestamptz,
         last_interested_at   = p_occurred_at,
         last_event_id        = p_event_id
   WHERE account_id = p_account_id
     AND taamul_contact_id = p_taamul_contact_id
     AND (last_interested_at IS NULL OR last_interested_at <= p_occurred_at);

  RETURN 'recorded';
END;
$$;

COMMENT ON FUNCTION public.taamul_sales_record_interested(uuid, text, text, timestamptz, text, jsonb, jsonb, text) IS
  'Records one Taamul sales-app event (139): ''duplicate'' when its event_id was already recorded, else ''recorded''. Service role only.';

REVOKE ALL ON FUNCTION public.taamul_sales_record_interested(uuid, text, text, timestamptz, text, jsonb, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.taamul_sales_record_interested(uuid, text, text, timestamptz, text, jsonb, jsonb, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
