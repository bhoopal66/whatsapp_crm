-- ============================================================
-- 188_meta_number_health.sql — Meta number protection and spend
-- control, WATCH-ONLY.
--
-- What it is. The database half of "number protection": a record of
-- what Meta's webhooks say about the account's Cloud API number and
-- its templates (account_update, phone_number_quality_update,
-- message_template_quality_update, message_template_status_update),
-- the number's current health and an assessed sending state, each
-- template's quality and status, and two read-only figures: marketing
-- templates sent on the number in a day (the daily ramp) and Meta spend
-- per won (Approved) case.
--
-- WATCH-ONLY BY DEFAULT. Nothing here blocks, defers or changes a
-- send. No trigger is added to any existing table and no existing
-- function is replaced: the send paths, the webhook routes, the cost
-- ledger (051) and broadcasts behave exactly as before. The assessed
-- state is a record, not a gate. meta_protection_settings.enforce is
-- the switch a later change may read before it acts on any of this; it
-- defaults to false, only an owner may turn it on, and with no row it
-- reads as false.
--
-- Writers. No client role writes any table here. Every write is a
-- SECURITY DEFINER function granted to the service role only (the
-- Meta webhook side and the routes, which check the caller first):
--   meta_health_event_record    append one event; a repeated
--                               (account, dedup_key) returns false
--   meta_number_state_set       compare-and-set on updated_at
--   meta_template_health_set    forward-only on the event time
--   meta_protection_set_enforce owner only (p_actor)
--   meta_protection_set_marketing_cap  owner or admin (p_actor)
-- Readers. Owners and admins of the account read the four tables
-- through RLS (is_account_member(account_id, 'admin'), 051's rule for
-- the cost ledger); everyone else sees nothing.
--
-- The ramp count and the spend figure read the 051 ledger, which is
-- Meta's own word on each message's pricing category and cost; see the
-- functions. The spend figure reads cases (RLS-forced, 122), so, as
-- 122 and 178, this must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE … IF NOT EXISTS, guarded constraints,
-- CREATE OR REPLACE, DROP POLICY IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '188 must be applied by a superuser or BYPASSRLS role (its functions write RLS-forced tables and read cases)';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Health events (append-only)
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.meta_health_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- The account's Meta row. NULL once that number is disconnected: the
  -- record outlives the row.
  config_id   uuid NULL,
  kind        text NOT NULL,
  dedup_key   text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.meta_health_events DROP CONSTRAINT IF EXISTS meta_health_events_kind_check;
ALTER TABLE public.meta_health_events ADD CONSTRAINT meta_health_events_kind_check
  CHECK (kind IN ('account_update', 'phone_number_quality_update',
                  'message_template_quality_update', 'message_template_status_update'));
ALTER TABLE public.meta_health_events DROP CONSTRAINT IF EXISTS meta_health_events_dedup_key_check;
ALTER TABLE public.meta_health_events ADD CONSTRAINT meta_health_events_dedup_key_check
  CHECK (dedup_key !~ '^[[:space:]]*$' AND char_length(dedup_key) <= 512);
ALTER TABLE public.meta_health_events DROP CONSTRAINT IF EXISTS meta_health_events_payload_check;
ALTER TABLE public.meta_health_events ADD CONSTRAINT meta_health_events_payload_check
  CHECK (jsonb_typeof(payload) = 'object');
ALTER TABLE public.meta_health_events DROP CONSTRAINT IF EXISTS meta_health_events_dedup_key;
ALTER TABLE public.meta_health_events ADD CONSTRAINT meta_health_events_dedup_key
  UNIQUE (account_id, dedup_key);
ALTER TABLE public.meta_health_events DROP CONSTRAINT IF EXISTS meta_health_events_config_fkey;
ALTER TABLE public.meta_health_events ADD CONSTRAINT meta_health_events_config_fkey
  FOREIGN KEY (config_id, account_id) REFERENCES public.whatsapp_config (id, account_id)
  ON DELETE SET NULL (config_id);

CREATE INDEX IF NOT EXISTS meta_health_events_account_received_idx
  ON public.meta_health_events (account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS meta_health_events_config_idx
  ON public.meta_health_events (config_id) WHERE config_id IS NOT NULL;

-- Append-only. The one exception is a foreign-key action (depth > 1:
-- the RI trigger's own statement): disconnecting the number nulls
-- config_id and nothing else, and deleting the account removes its
-- rows. Without it, either would fail and disconnecting a number would
-- stop working. No client role can fire a trigger chain into here.
CREATE OR REPLACE FUNCTION public.meta_health_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND pg_trigger_depth() > 1
     AND NEW.config_id IS NULL
     AND (to_jsonb(NEW) - 'config_id') = (to_jsonb(OLD) - 'config_id') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1
     AND NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = OLD.account_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'meta_health_events is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege', HINT = 'APPEND_ONLY';
END;
$$;

CREATE OR REPLACE TRIGGER meta_health_events_append_only
  BEFORE UPDATE OR DELETE ON public.meta_health_events
  FOR EACH ROW EXECUTE FUNCTION public.meta_health_events_append_only();
CREATE OR REPLACE TRIGGER meta_health_events_no_truncate
  BEFORE TRUNCATE ON public.meta_health_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.meta_health_events_append_only();

-- ------------------------------------------------------------
-- 2. Number state (one row per Meta number, compare-and-set)
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.meta_number_state (
  config_id            uuid PRIMARY KEY,
  account_id           uuid NOT NULL,
  quality_rating       text NULL,
  messaging_limit_tier text NULL,
  account_status       text NULL,
  assessed_state       text NOT NULL DEFAULT 'NORMAL',
  reasons              jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.meta_number_state DROP CONSTRAINT IF EXISTS meta_number_state_config_fkey;
ALTER TABLE public.meta_number_state ADD CONSTRAINT meta_number_state_config_fkey
  FOREIGN KEY (config_id, account_id) REFERENCES public.whatsapp_config (id, account_id) ON DELETE CASCADE;
ALTER TABLE public.meta_number_state DROP CONSTRAINT IF EXISTS meta_number_state_quality_check;
ALTER TABLE public.meta_number_state ADD CONSTRAINT meta_number_state_quality_check
  CHECK (quality_rating IS NULL OR quality_rating IN ('GREEN', 'YELLOW', 'RED', 'UNKNOWN'));
ALTER TABLE public.meta_number_state DROP CONSTRAINT IF EXISTS meta_number_state_tier_check;
ALTER TABLE public.meta_number_state ADD CONSTRAINT meta_number_state_tier_check
  CHECK (messaging_limit_tier IS NULL OR (messaging_limit_tier !~ '^[[:space:]]*$' AND char_length(messaging_limit_tier) <= 64));
ALTER TABLE public.meta_number_state DROP CONSTRAINT IF EXISTS meta_number_state_status_check;
ALTER TABLE public.meta_number_state ADD CONSTRAINT meta_number_state_status_check
  CHECK (account_status IS NULL OR (account_status !~ '^[[:space:]]*$' AND char_length(account_status) <= 64));
ALTER TABLE public.meta_number_state DROP CONSTRAINT IF EXISTS meta_number_state_assessed_check;
ALTER TABLE public.meta_number_state ADD CONSTRAINT meta_number_state_assessed_check
  CHECK (assessed_state IN ('NORMAL', 'THROTTLED', 'MARKETING_PAUSED', 'ALL_PAUSED'));
ALTER TABLE public.meta_number_state DROP CONSTRAINT IF EXISTS meta_number_state_reasons_check;
ALTER TABLE public.meta_number_state ADD CONSTRAINT meta_number_state_reasons_check
  CHECK (jsonb_typeof(reasons) = 'array');

CREATE INDEX IF NOT EXISTS meta_number_state_account_idx ON public.meta_number_state (account_id);

-- ------------------------------------------------------------
-- 3. Template health (one row per template name and language)
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.meta_template_health (
  account_id    uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  template_name text NOT NULL,
  language      text NOT NULL,
  quality       text NULL,
  status        text NULL,
  paused_until  timestamptz NULL,
  -- The time of the newest event applied (Meta's, else receipt time).
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, template_name, language)
);

ALTER TABLE public.meta_template_health DROP CONSTRAINT IF EXISTS meta_template_health_name_check;
ALTER TABLE public.meta_template_health ADD CONSTRAINT meta_template_health_name_check
  CHECK (template_name !~ '^[[:space:]]*$' AND char_length(template_name) <= 512
         AND language !~ '^[[:space:]]*$' AND char_length(language) <= 32);
ALTER TABLE public.meta_template_health DROP CONSTRAINT IF EXISTS meta_template_health_quality_check;
ALTER TABLE public.meta_template_health ADD CONSTRAINT meta_template_health_quality_check
  CHECK (quality IS NULL OR quality IN ('GREEN', 'YELLOW', 'RED', 'UNKNOWN'));
ALTER TABLE public.meta_template_health DROP CONSTRAINT IF EXISTS meta_template_health_status_check;
ALTER TABLE public.meta_template_health ADD CONSTRAINT meta_template_health_status_check
  CHECK (status IS NULL OR (status !~ '^[[:space:]]*$' AND char_length(status) <= 64));

-- ------------------------------------------------------------
-- 4. Settings (enforcement off by default)
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.meta_protection_settings (
  account_id          uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enforce             boolean NOT NULL DEFAULT false,
  daily_marketing_cap integer NULL,
  updated_by          uuid NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.meta_protection_settings DROP CONSTRAINT IF EXISTS meta_protection_settings_cap_check;
ALTER TABLE public.meta_protection_settings ADD CONSTRAINT meta_protection_settings_cap_check
  CHECK (daily_marketing_cap IS NULL OR daily_marketing_cap >= 0);

COMMENT ON COLUMN public.meta_protection_settings.enforce IS
  'Whether number protection may act on sends. Default off: migration 188 only records and assesses; nothing reads this yet. Owner only.';
COMMENT ON COLUMN public.meta_protection_settings.daily_marketing_cap IS
  'An owner/admin cap on marketing templates per Meta number per UTC day. NULL = no cap of our own. Advisory while enforce is off. Migration 188.';

-- ------------------------------------------------------------
-- 5. RLS: forced; owners/admins of the account read; no client writes
-- ------------------------------------------------------------

ALTER TABLE public.meta_health_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_health_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.meta_number_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_number_state FORCE ROW LEVEL SECURITY;
ALTER TABLE public.meta_template_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_template_health FORCE ROW LEVEL SECURITY;
ALTER TABLE public.meta_protection_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_protection_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_health_events_select ON public.meta_health_events;
CREATE POLICY meta_health_events_select ON public.meta_health_events FOR SELECT
  USING (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_number_state_select ON public.meta_number_state;
CREATE POLICY meta_number_state_select ON public.meta_number_state FOR SELECT
  USING (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_template_health_select ON public.meta_template_health;
CREATE POLICY meta_template_health_select ON public.meta_template_health FOR SELECT
  USING (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS meta_protection_settings_select ON public.meta_protection_settings;
CREATE POLICY meta_protection_settings_select ON public.meta_protection_settings FOR SELECT
  USING (public.is_account_member(account_id, 'admin'));

REVOKE ALL ON public.meta_health_events, public.meta_number_state, public.meta_template_health,
  public.meta_protection_settings
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.meta_health_events, public.meta_number_state, public.meta_template_health,
  public.meta_protection_settings
  TO authenticated, service_role;
REVOKE ALL ON SEQUENCE public.meta_health_events_id_seq FROM PUBLIC, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 6. Writers (service role)
-- ------------------------------------------------------------

-- The account's Meta row, or a CONFIG_INVALID refusal.
CREATE OR REPLACE FUNCTION public.meta_health_config_account(p_config uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
BEGIN
  SELECT w.account_id INTO v_account
    FROM public.whatsapp_config w
   WHERE w.id = p_config AND w.provider = 'meta';
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'CONFIG_INVALID: % is not a Meta number', p_config
      USING ERRCODE = 'check_violation', HINT = 'CONFIG_INVALID';
  END IF;
  RETURN v_account;
END;
$$;

-- Append one event. The caller derives p_dedup_key from the webhook
-- entry (a redelivery carries the same key); a repeat writes nothing
-- and returns false.
CREATE OR REPLACE FUNCTION public.meta_health_event_record(p_account uuid, p_config uuid, p_kind text,
  p_dedup_key text, p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id bigint;
BEGIN
  IF public.meta_health_config_account(p_config) IS DISTINCT FROM p_account THEN
    RAISE EXCEPTION 'CONFIG_INVALID: % is not a Meta number of %', p_config, p_account
      USING ERRCODE = 'check_violation', HINT = 'CONFIG_INVALID';
  END IF;
  INSERT INTO public.meta_health_events (account_id, config_id, kind, dedup_key, payload)
  VALUES (p_account, p_config, p_kind, p_dedup_key, coalesce(p_payload, '{}'::jsonb))
  ON CONFLICT ON CONSTRAINT meta_health_events_dedup_key DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

-- Compare-and-set (the package's version CAS, on updated_at). The
-- caller passes the updated_at it read, or NULL when it read no row.
-- Returns the new updated_at, or NULL when another writer got there
-- first (stale): nothing is written, and the caller re-reads and
-- retries. updated_at always moves forward, by at least a microsecond,
-- so two writes never leave the same value behind.
CREATE OR REPLACE FUNCTION public.meta_number_state_set(p_config uuid, p_expected_updated_at timestamptz,
  p_quality_rating text, p_messaging_limit_tier text, p_account_status text, p_assessed_state text,
  p_reasons jsonb)
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
  v_at      timestamptz;
BEGIN
  v_account := public.meta_health_config_account(p_config);
  IF p_expected_updated_at IS NULL THEN
    INSERT INTO public.meta_number_state AS s (config_id, account_id, quality_rating, messaging_limit_tier,
      account_status, assessed_state, reasons, updated_at)
    VALUES (p_config, v_account, p_quality_rating, p_messaging_limit_tier, p_account_status,
            coalesce(p_assessed_state, 'NORMAL'), coalesce(p_reasons, '[]'::jsonb), clock_timestamp())
    ON CONFLICT (config_id) DO NOTHING
    RETURNING s.updated_at INTO v_at;
  ELSE
    UPDATE public.meta_number_state s
       SET quality_rating = p_quality_rating,
           messaging_limit_tier = p_messaging_limit_tier,
           account_status = p_account_status,
           assessed_state = coalesce(p_assessed_state, 'NORMAL'),
           reasons = coalesce(p_reasons, '[]'::jsonb),
           updated_at = greatest(clock_timestamp(), s.updated_at + interval '1 microsecond')
     WHERE s.config_id = p_config AND s.updated_at = p_expected_updated_at
    RETURNING s.updated_at INTO v_at;
  END IF;
  RETURN v_at;
END;
$$;

-- One template's quality and/or status. p_at is the event's time (Meta's,
-- else receipt time); an event older than the row's newest is ignored and
-- returns false. A NULL quality or status keeps the stored one: a quality
-- update carries no status and the reverse. paused_until follows the
-- status: a status update sets it (NULL clears it).
CREATE OR REPLACE FUNCTION public.meta_template_health_set(p_account uuid, p_template_name text,
  p_language text, p_quality text, p_status text, p_paused_until timestamptz, p_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_account IS NULL OR p_at IS NULL OR (p_quality IS NULL AND p_status IS NULL) THEN
    RAISE EXCEPTION 'TEMPLATE_HEALTH_INVALID: an account, a time and a quality or status are required'
      USING ERRCODE = 'check_violation', HINT = 'TEMPLATE_HEALTH_INVALID';
  END IF;
  INSERT INTO public.meta_template_health AS t (account_id, template_name, language, quality, status,
    paused_until, updated_at)
  VALUES (p_account, p_template_name, p_language, p_quality, p_status,
          CASE WHEN p_status IS NOT NULL THEN p_paused_until END, p_at)
  ON CONFLICT (account_id, template_name, language) DO UPDATE
    SET quality = coalesce(EXCLUDED.quality, t.quality),
        status = coalesce(EXCLUDED.status, t.status),
        paused_until = CASE WHEN p_status IS NOT NULL THEN EXCLUDED.paused_until ELSE t.paused_until END,
        updated_at = EXCLUDED.updated_at
    WHERE t.updated_at <= EXCLUDED.updated_at;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

-- ------------------------------------------------------------
-- 7. Settings: getter and setters (181's shape: service role, p_actor)
-- ------------------------------------------------------------

-- The account's settings; the defaults (enforce off, no cap) with no row.
CREATE OR REPLACE FUNCTION public.meta_protection_settings_get(p_account uuid)
RETURNS TABLE (enforce boolean, daily_marketing_cap integer, updated_by uuid, updated_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(s.enforce, false), s.daily_marketing_cap, s.updated_by, s.updated_at
    FROM (SELECT 1) one
    LEFT JOIN public.meta_protection_settings s ON s.account_id = p_account
$$;

-- p_actor's live role in p_account (any of their rows there, active or
-- not, as case_account_role), or NULL.
CREATE OR REPLACE FUNCTION public.meta_protection_actor_role(p_account uuid, p_actor uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.account_role::text
    FROM public.profiles p
   WHERE p.user_id = p_actor AND p.account_id = p_account
     AND p.deactivated_at IS NULL
     AND p.account_role <> 'bank_guest'
$$;

-- Enforcement: owners only. Returns the stored value.
CREATE OR REPLACE FUNCTION public.meta_protection_set_enforce(p_actor uuid, p_account uuid, p_on boolean)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF public.meta_protection_actor_role(p_account, p_actor) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'NOT_ALLOWED: % may not change number protection enforcement of %', p_actor, p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_on IS NULL THEN
    RAISE EXCEPTION 'SETTING_INVALID: enforce must be true or false'
      USING ERRCODE = 'check_violation', HINT = 'SETTING_INVALID';
  END IF;
  INSERT INTO public.meta_protection_settings AS s (account_id, enforce, updated_by, updated_at)
  VALUES (p_account, p_on, p_actor, now())
  ON CONFLICT (account_id) DO UPDATE
    SET enforce = EXCLUDED.enforce, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  RETURN p_on;
END;
$$;

-- The daily marketing cap: owners and admins. NULL clears it. Returns
-- the stored value.
CREATE OR REPLACE FUNCTION public.meta_protection_set_marketing_cap(p_actor uuid, p_account uuid, p_cap integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  v_role := public.meta_protection_actor_role(p_account, p_actor);
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'NOT_ALLOWED: % may not change the marketing cap of %', p_actor, p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_cap IS NOT NULL AND p_cap < 0 THEN
    RAISE EXCEPTION 'SETTING_INVALID: the cap must be 0 or more, or NULL'
      USING ERRCODE = 'check_violation', HINT = 'SETTING_INVALID';
  END IF;
  INSERT INTO public.meta_protection_settings AS s (account_id, daily_marketing_cap, updated_by, updated_at)
  VALUES (p_account, p_cap, p_actor, now())
  ON CONFLICT (account_id) DO UPDATE
    SET daily_marketing_cap = EXCLUDED.daily_marketing_cap, updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;
  RETURN p_cap;
END;
$$;

-- ------------------------------------------------------------
-- 8. Ramp and spend reads (service role)
-- ------------------------------------------------------------

-- Marketing templates sent on a Meta number on one UTC day (the
-- package's daily scopes key on the UTC day). Source: the 051 ledger,
-- the only place that holds Meta's own pricing category per message
-- (Meta may categorise a template differently from our
-- message_templates.category, and it is Meta's category that its
-- limits and charges follow). One send = one (message, recipient): a
-- message counts on the day of its earliest sent/delivered/read receipt
-- (Meta's timestamp, else arrival), so a late read receipt does not
-- count it again on a later day. Failed sends are not counted. Only
-- what Meta has reported is counted: a send whose receipts have not
-- arrived yet is not in the figure.
CREATE OR REPLACE FUNCTION public.meta_marketing_sent_today(p_config uuid, p_day date)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH w AS (
    -- meta_health_config_account refuses a number that is not Meta's.
    SELECT c.account_id, c.phone_number_id
      FROM public.whatsapp_config c
     WHERE c.id = p_config AND c.account_id = public.meta_health_config_account(p_config)
  ), r AS (
    SELECT l.message_id, l.recipient_wa_id, l.category,
           CASE WHEN l.raw_status->>'timestamp' ~ '^[0-9]{1,12}$'
                THEN to_timestamp((l.raw_status->>'timestamp')::bigint)
                ELSE l.created_at END AS at
      FROM public.whatsapp_message_costs l
      JOIN w ON w.account_id = l.account_id AND w.phone_number_id = l.phone_number_id
     WHERE l.status IN ('sent', 'delivered', 'read')
  ), first_receipt AS (
    SELECT r.message_id, r.recipient_wa_id, min(r.at) AS at, bool_or(r.category = 'marketing') AS marketing
      FROM r
     GROUP BY r.message_id, r.recipient_wa_id
  )
  SELECT count(*)::integer
    FROM first_receipt f
   WHERE f.marketing
     AND f.at >= (p_day::timestamp AT TIME ZONE 'UTC')
     AND f.at <  ((p_day + 1)::timestamp AT TIME ZONE 'UTC')
$$;

-- Meta spend per won case. Won = the account's cases with outcome
-- 'Approved' closed in [p_from, p_to). A won case's spend is the billed
-- cost (051: delivered, billable) of every Meta message to its customer
-- (cases.contact_id, else its submission group's contact) delivered up
-- to the case's win, however long before p_from. The link from a ledger
-- row to a customer is the message: ledger wamid -> messages.message_id
-- -> its conversation's contact, in the same account. other_spend_usd
-- is the billed cost delivered in the window that went to anyone else
-- or could not be linked (a deal-room group message has no messages
-- row). A customer with two won cases counts its spend once and both
-- cases. A billed message whose rate is unknown (cost NULL, 051) is
-- never counted as 0: it is reported in unknown_cost_messages instead.
CREATE OR REPLACE FUNCTION public.meta_cost_per_won_case(p_account uuid, p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v jsonb;
BEGIN
  IF p_account IS NULL OR p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN
    RAISE EXCEPTION 'RANGE_INVALID: an account and a range with from before to are required'
      USING ERRCODE = 'check_violation', HINT = 'RANGE_INVALID';
  END IF;
  WITH won AS (
    SELECT c.id, coalesce(c.contact_id, g.contact_id) AS contact_id, c.closed_at
      FROM public.cases c
      LEFT JOIN public.submission_groups g ON g.id = c.group_id AND g.account_id = c.account_id
     WHERE c.account_id = p_account AND c.outcome = 'Approved'
       AND c.closed_at >= p_from AND c.closed_at < p_to
  ), won_contacts AS (
    SELECT w.contact_id, max(w.closed_at) AS won_at
      FROM won w WHERE w.contact_id IS NOT NULL GROUP BY w.contact_id
  ), billed AS (
    SELECT l.id, l.cost_usd, l.delivered_at,
           (SELECT v.contact_id
              FROM public.messages m
              JOIN public.conversations v ON v.id = m.conversation_id
             WHERE m.message_id = l.message_id AND v.account_id = l.account_id
             ORDER BY m.created_at, m.id
             LIMIT 1) AS contact_id
      FROM public.whatsapp_message_costs l
     WHERE l.account_id = p_account AND l.status = 'delivered' AND l.billable
       AND l.delivered_at < p_to
  ), tagged AS (
    SELECT b.*, (wc.contact_id IS NOT NULL) AS for_won,
           (b.delivered_at >= p_from) AS in_window
      FROM billed b
      LEFT JOIN won_contacts wc ON wc.contact_id = b.contact_id AND b.delivered_at <= wc.won_at
  )
  SELECT jsonb_build_object(
           'won_cases', (SELECT count(*) FROM won),
           'won_spend_usd', coalesce((SELECT sum(t.cost_usd) FROM tagged t WHERE t.for_won), 0),
           'cost_per_won_case_usd', CASE WHEN (SELECT count(*) FROM won) = 0 THEN NULL
             ELSE round(coalesce((SELECT sum(t.cost_usd) FROM tagged t WHERE t.for_won), 0)
                        / (SELECT count(*) FROM won), 6) END,
           'other_spend_usd', coalesce((SELECT sum(t.cost_usd) FROM tagged t
                                         WHERE NOT t.for_won AND t.in_window), 0),
           'unknown_cost_messages', (SELECT count(*) FROM tagged t
                                      WHERE t.cost_usd IS NULL AND (t.for_won OR t.in_window)))
    INTO v;
  RETURN v;
END;
$$;

-- ------------------------------------------------------------
-- 9. Function privileges: service role only
-- ------------------------------------------------------------

REVOKE ALL ON FUNCTION public.meta_health_events_append_only()
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.meta_health_config_account(uuid),
  public.meta_health_event_record(uuid, uuid, text, text, jsonb),
  public.meta_number_state_set(uuid, timestamptz, text, text, text, text, jsonb),
  public.meta_template_health_set(uuid, text, text, text, text, timestamptz, timestamptz),
  public.meta_protection_settings_get(uuid),
  public.meta_protection_actor_role(uuid, uuid),
  public.meta_protection_set_enforce(uuid, uuid, boolean),
  public.meta_protection_set_marketing_cap(uuid, uuid, integer),
  public.meta_marketing_sent_today(uuid, date),
  public.meta_cost_per_won_case(uuid, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.meta_health_event_record(uuid, uuid, text, text, jsonb),
  public.meta_number_state_set(uuid, timestamptz, text, text, text, text, jsonb),
  public.meta_template_health_set(uuid, text, text, text, text, timestamptz, timestamptz),
  public.meta_protection_settings_get(uuid),
  public.meta_protection_set_enforce(uuid, uuid, boolean),
  public.meta_protection_set_marketing_cap(uuid, uuid, integer),
  public.meta_marketing_sent_today(uuid, date),
  public.meta_cost_per_won_case(uuid, timestamptz, timestamptz)
  TO service_role;
