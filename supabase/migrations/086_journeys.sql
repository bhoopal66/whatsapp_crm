-- ============================================================
-- 086: journey bot host (module 016, "Welcome to Close")
--
-- The engine in src/lib/journeys is pure: one event in, a new file and
-- a list of actions out. This migration is the host's half of the
-- contract in src/lib/journeys/ports.ts.
--
-- * journey_files — one row per journey; `body` is the whole engine
--   JourneyFile, the other columns are projections of it kept by
--   journey_commit() so the cron and the screens can query without
--   parsing JSON: next_timer_at is the earliest body.timers[].fireAt,
--   closed_at is set once the outcome is WON or NOT_WON (PARKED stays
--   open). At most one open file per contact.
-- * journey_commit() is JourneyStore.commit, and the only writer of a
--   file after it is created. One function because the three writes —
--   the file at version+1, the processed event id, the actions as
--   pending outbox rows — must land together or not at all (supabase-js
--   has no transactions). The file row is locked first, so two commits
--   of one file serialise; then a replayed event id answers
--   'duplicate' BEFORE the version is compared (a redelivered webhook
--   must not look like a race and be retried); then a stale version
--   answers 'conflict'. Neither writes anything.
-- * journey_outbox is the transactional outbox the runner drains in
--   `seq` order; seq continues across commits of a file. A SEND's
--   notBefore is copied to not_before so the cron can find due items.
-- * journey_pending_opt_out() lets the delivery-time consent re-check
--   see an opt-out committed on any of the contact's files but not yet
--   applied to contacts.opted_out_at.
-- * journey_optin_claims holds the once-per-contact, ever, claim of
--   the opt-in welcome (journey_claim_optin_welcome(), atomic).
-- * The consent register lives on contacts beside 076's opted_out_at:
--   marketing opt-in (with its source) and do-not-contact. A guard
--   trigger decides who may write them, and every change of the three
--   stamps is appended to contact_consent_events by a trigger, so the
--   history cannot be skipped by a writer that forgets to log it.
-- * callback_requests is the queue the Yeastar module (015) consumes
--   for REQUEST_CALLBACK; task_id has no FK because the tasks table
--   ships on another branch.
--
-- Tenancy is a composite FK on (id, account_id) wherever a row points
-- at a contact or a conversation, so a row can never pair one
-- account's id with another account's contact (062's rule). Screens
-- read through RLS — journey rows, consent events and callbacks follow
-- the contact's visibility (can_view_contact, 072) — and nothing but
-- the service role writes them. supabase/ci/verify-journeys.sql
-- asserts all of it.
--
-- Re-runnable: IF NOT EXISTS everywhere, CREATE OR REPLACE, DROP
-- TRIGGER / POLICY IF EXISTS.
-- ============================================================

-- Targets of the composite FKs below.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_id_account_key
  ON public.contacts (id, account_id);
CREATE UNIQUE INDEX IF NOT EXISTS conversations_id_account_key
  ON public.conversations (id, account_id);

-- ------------------------------------------------------------
-- Settings: members read, admins write
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.journey_settings (
  account_id             uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled                boolean NOT NULL DEFAULT false,
  workflow_key           text NOT NULL DEFAULT 'taamul_welcome_to_close.v1',
  start_on_first_inbound boolean NOT NULL DEFAULT false,
  -- E.164 number behind the CALL_TAAMUL phone button.
  taamul_did             text NULL CHECK (taamul_did ~ '^\+[1-9][0-9]{6,14}$'),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid NULL
);
ALTER TABLE public.journey_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.journey_settings FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.journey_settings_stamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  RETURN new;
END
$$;
DROP TRIGGER IF EXISTS journey_settings_stamp ON public.journey_settings;
CREATE TRIGGER journey_settings_stamp
  BEFORE INSERT OR UPDATE ON public.journey_settings
  FOR EACH ROW EXECUTE FUNCTION public.journey_settings_stamp();

DROP POLICY IF EXISTS journey_settings_select ON public.journey_settings;
DROP POLICY IF EXISTS journey_settings_insert ON public.journey_settings;
DROP POLICY IF EXISTS journey_settings_update ON public.journey_settings;
CREATE POLICY journey_settings_select ON public.journey_settings
  FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id()));
CREATE POLICY journey_settings_insert ON public.journey_settings
  FOR INSERT TO authenticated
  WITH CHECK (account_id = (SELECT public.current_account_id())
              AND (SELECT public.current_role_rank()) >= 4);
CREATE POLICY journey_settings_update ON public.journey_settings
  FOR UPDATE TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND (SELECT public.current_role_rank()) >= 4)
  WITH CHECK (account_id = (SELECT public.current_account_id())
              AND (SELECT public.current_role_rank()) >= 4);
GRANT SELECT, INSERT, UPDATE ON public.journey_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.journey_settings TO service_role;

-- ------------------------------------------------------------
-- Journey files, processed events, outbox, opt-in welcome claims
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.journey_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL,
  contact_id      uuid NOT NULL,
  conversation_id uuid NULL,
  workflow_key    text NOT NULL,
  product         text NULL CHECK (product IN ('POS', 'ACCOUNT', 'LOAN')),
  state           text NOT NULL,
  entry           text NULL CHECK (entry IN ('INBOUND', 'COLD')),
  outcome_kind    text NULL CHECK (outcome_kind IN ('WON', 'NOT_WON', 'PARKED')),
  body            jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  version         integer NOT NULL DEFAULT 0,
  next_timer_at   timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz NULL,
  CONSTRAINT journey_files_contact_fkey FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts (id, account_id) ON DELETE CASCADE,
  CONSTRAINT journey_files_conversation_fkey FOREIGN KEY (conversation_id, account_id)
    REFERENCES public.conversations (id, account_id) ON DELETE SET NULL (conversation_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS journey_files_one_open
  ON public.journey_files (account_id, contact_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS journey_files_next_timer
  ON public.journey_files (next_timer_at) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS journey_files_contact
  ON public.journey_files (contact_id, account_id);
CREATE INDEX IF NOT EXISTS journey_files_conversation
  ON public.journey_files (conversation_id) WHERE conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.journey_processed_events (
  file_id      uuid NOT NULL REFERENCES public.journey_files(id) ON DELETE CASCADE,
  event_id     text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, event_id)
);

CREATE TABLE IF NOT EXISTS public.journey_outbox (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id      uuid NOT NULL REFERENCES public.journey_files(id) ON DELETE CASCADE,
  account_id   uuid NOT NULL,
  seq          integer NOT NULL,
  action       jsonb NOT NULL CHECK (jsonb_typeof(action -> 'type') = 'string'),
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'delivered', 'dropped')),
  drop_reason  text NULL,
  not_before   timestamptz NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz NULL,
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text NULL,
  UNIQUE (file_id, seq)
);
CREATE INDEX IF NOT EXISTS journey_outbox_pending
  ON public.journey_outbox (file_id, seq) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.journey_optin_claims (
  contact_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  claim_id   text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journey_optin_claims_contact_fkey FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts (id, account_id) ON DELETE CASCADE
);

-- Members read the files of contacts they can see; only the service
-- role (the runner) writes. The other three are the runner's alone.
ALTER TABLE public.journey_files            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_processed_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_outbox           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_optin_claims     ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.journey_files, public.journey_processed_events,
  public.journey_outbox, public.journey_optin_claims
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.journey_files TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.journey_files,
  public.journey_processed_events, public.journey_outbox,
  public.journey_optin_claims TO service_role;

DROP POLICY IF EXISTS journey_files_select ON public.journey_files;
CREATE POLICY journey_files_select ON public.journey_files
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND (
      (SELECT public.current_role_rank()) >= 4
      OR EXISTS (
        SELECT 1 FROM public.contacts c
        WHERE c.id = journey_files.contact_id
          AND public.can_view_contact(c.account_id, c.id, c.user_id)
      )
    )
  );

-- JourneyStore.commit (ports.ts): 'duplicate' | 'conflict' | 'ok'.
CREATE OR REPLACE FUNCTION public.journey_commit(
  p_file_id uuid,
  p_expected_version integer,
  p_file jsonb,
  p_event_id text,
  p_actions jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row  public.journey_files%ROWTYPE;
  v_kind text;
  v_seq  integer;
BEGIN
  IF p_file_id IS NULL OR p_expected_version IS NULL
     OR coalesce(p_event_id, '') = ''
     OR jsonb_typeof(p_file) IS DISTINCT FROM 'object'
     OR p_file ->> 'id' IS DISTINCT FROM p_file_id::text
     OR jsonb_typeof(p_file -> 'state') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_file -> 'timers') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_actions) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'journey_commit: malformed arguments for file %', p_file_id
      USING ERRCODE = '22023';
  END IF;

  -- Lock first: a concurrent commit of this file waits here, and then
  -- sees the other's processed event and version.
  SELECT * INTO v_row FROM public.journey_files WHERE id = p_file_id FOR UPDATE;

  -- A replay is a duplicate whatever the version says.
  IF EXISTS (SELECT 1 FROM public.journey_processed_events
             WHERE file_id = p_file_id AND event_id = p_event_id) THEN
    RETURN 'duplicate';
  END IF;
  -- A missing file (its contact was deleted) is a conflict: the
  -- runner reloads and finds nothing.
  IF v_row.id IS NULL OR v_row.version <> p_expected_version THEN
    RETURN 'conflict';
  END IF;
  IF p_file ->> 'contactId' IS DISTINCT FROM v_row.contact_id::text THEN
    RAISE EXCEPTION 'journey_commit: file % belongs to another contact', p_file_id
      USING ERRCODE = '22023';
  END IF;

  v_kind := p_file -> 'outcome' ->> 'kind';
  UPDATE public.journey_files SET
    state         = p_file ->> 'state',
    product       = p_file ->> 'product',
    entry         = p_file ->> 'entry',
    outcome_kind  = v_kind,
    body          = jsonb_set(p_file, '{version}', to_jsonb(p_expected_version + 1)),
    version       = p_expected_version + 1,
    next_timer_at = (SELECT min((t ->> 'fireAt')::timestamptz)
                     FROM jsonb_array_elements(p_file -> 'timers') t),
    closed_at     = CASE WHEN v_kind IN ('WON', 'NOT_WON')
                         THEN coalesce(v_row.closed_at, now()) END,
    updated_at    = now()
  WHERE id = p_file_id;

  INSERT INTO public.journey_processed_events (file_id, event_id)
  VALUES (p_file_id, p_event_id);

  SELECT coalesce(max(seq), 0) INTO v_seq
  FROM public.journey_outbox WHERE file_id = p_file_id;
  -- clock_timestamp(): two commits in one transaction still order.
  INSERT INTO public.journey_outbox
    (file_id, account_id, seq, action, not_before, committed_at)
  SELECT p_file_id, v_row.account_id, v_seq + a.ord::integer, a.value,
         CASE WHEN a.value ->> 'type' = 'SEND'
              THEN (a.value ->> 'notBefore')::timestamptz END,
         clock_timestamp()
  FROM jsonb_array_elements(p_actions) WITH ORDINALITY AS a(value, ord);

  RETURN 'ok';
END
$$;

-- The optedOut of the contact's most recently committed SET_OPT_OUT
-- that is still pending, on any of its files; NULL when none is.
CREATE OR REPLACE FUNCTION public.journey_pending_opt_out(p_contact_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT (o.action ->> 'optedOut')::boolean
  FROM public.journey_outbox o
  JOIN public.journey_files f ON f.id = o.file_id
  WHERE f.contact_id = p_contact_id
    AND o.status = 'pending'
    AND o.action ->> 'type' = 'SET_OPT_OUT'
  ORDER BY o.committed_at DESC, o.seq DESC
  LIMIT 1
$$;

-- True iff the contact's opt-in welcome was unclaimed (now claimed by
-- p_claim_id) or is already claimed by this same id (a redelivery).
CREATE OR REPLACE FUNCTION public.journey_claim_optin_welcome(
  p_contact_id uuid,
  p_claim_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF coalesce(p_claim_id, '') = '' THEN
    RAISE EXCEPTION 'journey_claim_optin_welcome: empty claim id'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.journey_optin_claims (contact_id, account_id, claim_id)
  SELECT c.id, c.account_id, p_claim_id
  FROM public.contacts c WHERE c.id = p_contact_id
  ON CONFLICT (contact_id) DO NOTHING;
  RETURN coalesce((SELECT claim_id = p_claim_id
                   FROM public.journey_optin_claims
                   WHERE contact_id = p_contact_id), false);
END
$$;

REVOKE ALL ON FUNCTION public.journey_commit(uuid, integer, jsonb, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.journey_pending_opt_out(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.journey_claim_optin_welcome(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.journey_commit(uuid, integer, jsonb, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.journey_pending_opt_out(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.journey_claim_optin_welcome(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.journey_settings_stamp() FROM PUBLIC, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- Consent register on contacts
-- ------------------------------------------------------------
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS marketing_opt_in_at     timestamptz NULL,
  ADD COLUMN IF NOT EXISTS marketing_opt_in_source text NULL,
  ADD COLUMN IF NOT EXISTS do_not_contact_at       timestamptz NULL,
  ADD COLUMN IF NOT EXISTS do_not_contact_reason   text NULL;

COMMENT ON COLUMN public.contacts.marketing_opt_in_at IS
  'When the customer agreed to marketing messages; needs marketing_opt_in_source (migration 086).';
COMMENT ON COLUMN public.contacts.do_not_contact_at IS
  'Do not call or message this customer; set by an agent who can see them, cleared only by an admin (migration 086).';

-- Who may write the opt-in and do-not-contact. The service role and
-- server jobs (no signed-in user) may write anything; an agent or
-- above who can see the contact may set or withdraw an opt-in and set
-- do-not-contact; only an admin clears do-not-contact. An opt-in
-- always names its source, whoever writes it. 076's guard still owns
-- opted_out_at.
CREATE OR REPLACE FUNCTION public.contacts_consent_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  o_optin  timestamptz;
  o_source text;
  o_dnc    timestamptz;
  o_reason text;
BEGIN
  IF tg_op = 'UPDATE' THEN
    o_optin := old.marketing_opt_in_at;  o_source := old.marketing_opt_in_source;
    o_dnc   := old.do_not_contact_at;    o_reason := old.do_not_contact_reason;
  END IF;

  IF new.marketing_opt_in_at IS NOT NULL
     AND nullif(btrim(new.marketing_opt_in_source), '') IS NULL THEN
    RAISE EXCEPTION 'A marketing opt-in must name its source'
      USING ERRCODE = '23514';
  END IF;

  IF new.marketing_opt_in_at IS NOT DISTINCT FROM o_optin
     AND new.marketing_opt_in_source IS NOT DISTINCT FROM o_source
     AND new.do_not_contact_at IS NOT DISTINCT FROM o_dnc
     AND new.do_not_contact_reason IS NOT DISTINCT FROM o_reason THEN
    RETURN new;
  END IF;

  IF auth.uid() IS NULL OR COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN new;
  END IF;

  IF o_dnc IS NOT NULL AND new.do_not_contact_at IS NULL THEN
    IF public.is_account_member(new.account_id, 'admin') THEN
      RETURN new;
    END IF;
    RAISE EXCEPTION 'Only an admin can clear do-not-contact'
      USING ERRCODE = '42501';
  END IF;

  IF public.is_account_member(new.account_id, 'agent')
     AND public.can_view_contact(new.account_id, new.id, new.user_id) THEN
    RETURN new;
  END IF;
  RAISE EXCEPTION 'Only an agent who can see this customer can change their marketing consent or do-not-contact'
    USING ERRCODE = '42501';
END
$$;

DROP TRIGGER IF EXISTS contacts_consent_guard ON public.contacts;
CREATE TRIGGER contacts_consent_guard
  BEFORE INSERT OR UPDATE OF marketing_opt_in_at, marketing_opt_in_source,
    do_not_contact_at, do_not_contact_reason ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_consent_guard();

-- Append-only history of the three stamps.
CREATE TABLE IF NOT EXISTS public.contact_consent_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL,
  contact_id    uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN (
                  'marketing_opt_in', 'marketing_opt_in_withdrawn',
                  'opted_out', 'resubscribed',
                  'do_not_contact_set', 'do_not_contact_cleared')),
  source        text NOT NULL,
  actor_user_id uuid NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT contact_consent_events_contact_fkey FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts (id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS contact_consent_events_contact
  ON public.contact_consent_events (contact_id, at DESC);
ALTER TABLE public.contact_consent_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_consent_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.contact_consent_events TO authenticated;
GRANT SELECT, INSERT ON public.contact_consent_events TO service_role;

DROP POLICY IF EXISTS contact_consent_events_select ON public.contact_consent_events;
CREATE POLICY contact_consent_events_select ON public.contact_consent_events
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND (
      (SELECT public.current_role_rank()) >= 4
      OR EXISTS (
        SELECT 1 FROM public.contacts c
        WHERE c.id = contact_consent_events.contact_id
          AND public.can_view_contact(c.account_id, c.id, c.user_id)
      )
    )
  );

-- Only deleting the contact (the FK cascade) removes history.
CREATE OR REPLACE FUNCTION public.contact_consent_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF tg_op = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM public.contacts WHERE id = old.contact_id) THEN
    RETURN old;
  END IF;
  RAISE EXCEPTION 'contact_consent_events is append-only'
    USING ERRCODE = '42501';
END
$$;
DROP TRIGGER IF EXISTS contact_consent_events_append_only ON public.contact_consent_events;
CREATE TRIGGER contact_consent_events_append_only
  BEFORE UPDATE OR DELETE ON public.contact_consent_events
  FOR EACH ROW EXECUTE FUNCTION public.contact_consent_events_append_only();

-- Writes the history. SECURITY DEFINER: the events table has no
-- client INSERT; auth.uid() still names the signed-in actor. The
-- source is the transaction-local app.consent_source when a server
-- path sets one, else 'manual' (a person) or 'system' (service role).
CREATE OR REPLACE FUNCTION public.contacts_consent_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_source text;
  o_optin  timestamptz;
  o_out    timestamptz;
  o_dnc    timestamptz;
BEGIN
  v_source := coalesce(
    nullif(current_setting('app.consent_source', true), ''),
    CASE WHEN v_actor IS NULL OR COALESCE(auth.role(), '') = 'service_role'
         THEN 'system' ELSE 'manual' END);
  IF tg_op = 'UPDATE' THEN
    o_optin := old.marketing_opt_in_at;
    o_out   := old.opted_out_at;
    o_dnc   := old.do_not_contact_at;
  END IF;

  IF new.marketing_opt_in_at IS DISTINCT FROM o_optin THEN
    INSERT INTO public.contact_consent_events
      (account_id, contact_id, kind, source, actor_user_id, detail)
    VALUES (new.account_id, new.id,
      CASE WHEN new.marketing_opt_in_at IS NULL
           THEN 'marketing_opt_in_withdrawn' ELSE 'marketing_opt_in' END,
      v_source, v_actor,
      jsonb_build_object('previous', o_optin, 'stamp', new.marketing_opt_in_at,
                         'opt_in_source', new.marketing_opt_in_source));
  END IF;
  IF new.opted_out_at IS DISTINCT FROM o_out THEN
    INSERT INTO public.contact_consent_events
      (account_id, contact_id, kind, source, actor_user_id, detail)
    VALUES (new.account_id, new.id,
      CASE WHEN new.opted_out_at IS NULL THEN 'resubscribed' ELSE 'opted_out' END,
      v_source, v_actor,
      jsonb_build_object('previous', o_out, 'stamp', new.opted_out_at));
  END IF;
  IF new.do_not_contact_at IS DISTINCT FROM o_dnc THEN
    INSERT INTO public.contact_consent_events
      (account_id, contact_id, kind, source, actor_user_id, detail)
    VALUES (new.account_id, new.id,
      CASE WHEN new.do_not_contact_at IS NULL
           THEN 'do_not_contact_cleared' ELSE 'do_not_contact_set' END,
      v_source, v_actor,
      jsonb_build_object('previous', o_dnc, 'stamp', new.do_not_contact_at,
                         'reason', new.do_not_contact_reason));
  END IF;
  RETURN NULL;
END
$$;

-- INSERT too: a contact created already stamped has a history.
DROP TRIGGER IF EXISTS contacts_consent_log ON public.contacts;
CREATE TRIGGER contacts_consent_log
  AFTER INSERT OR UPDATE OF marketing_opt_in_at, opted_out_at, do_not_contact_at
  ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_consent_log();

REVOKE ALL ON FUNCTION public.contacts_consent_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.contacts_consent_log() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.contact_consent_events_append_only() FROM PUBLIC, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- Callback requests (consumed by the Yeastar module, 015)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.callback_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL,
  contact_id      uuid NOT NULL,
  conversation_id uuid NULL,
  journey_file_id uuid NULL REFERENCES public.journey_files(id) ON DELETE SET NULL,
  source          text NOT NULL DEFAULT 'journey' CHECK (source IN ('journey', 'manual')),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'dialing', 'done', 'failed', 'skipped')),
  not_before      timestamptz NULL,
  -- An auth user id, like conversations.assigned_agent_id.
  assigned_to     uuid NULL,
  -- tasks.id once the tasks module lands; no FK until then.
  task_id         uuid NULL,
  -- The REQUEST_CALLBACK outbox item: delivery is idempotent on it.
  outbox_item_id  uuid NULL UNIQUE REFERENCES public.journey_outbox(id) ON DELETE SET NULL,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT callback_requests_contact_fkey FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts (id, account_id) ON DELETE CASCADE,
  CONSTRAINT callback_requests_conversation_fkey FOREIGN KEY (conversation_id, account_id)
    REFERENCES public.conversations (id, account_id) ON DELETE SET NULL (conversation_id)
);
CREATE INDEX IF NOT EXISTS callback_requests_contact
  ON public.callback_requests (contact_id, account_id);
CREATE INDEX IF NOT EXISTS callback_requests_due
  ON public.callback_requests (not_before) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS callback_requests_file
  ON public.callback_requests (journey_file_id) WHERE journey_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS callback_requests_conversation
  ON public.callback_requests (conversation_id) WHERE conversation_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_updated_at ON public.callback_requests;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.callback_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.callback_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.callback_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.callback_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.callback_requests TO service_role;

DROP POLICY IF EXISTS callback_requests_select ON public.callback_requests;
CREATE POLICY callback_requests_select ON public.callback_requests
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND (
      (SELECT public.current_role_rank()) >= 4
      OR EXISTS (
        SELECT 1 FROM public.contacts c
        WHERE c.id = callback_requests.contact_id
          AND public.can_view_contact(c.account_id, c.id, c.user_id)
      )
    )
  );
