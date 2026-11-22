-- ============================================================
-- 237 — Business hours, a response target and escalation (Track B,
-- item 7). Everything here is OFF until an owner or admin switches it
-- on in Settings -> Response times.
--
--   1. response_settings: the workspace's switch, time zone, business
--      hours per weekday and response target. No row = the defaults
--      (off, Asia/Dubai, Mon-Sat 09:00-18:00, 15 business minutes).
--      Members read; written only through response_settings_set
--      (owner/admin of the caller's ACTIVE workspace).
--   2. conversations.customer_waiting_since, kept by a messages trigger
--      that never fails an insert: a customer message starts a waiting
--      episode (when none is open), any agent or bot message that did
--      not fail ends it. Company chats only. A guard keeps clients from
--      writing it; closing a chat ends the episode. One bounded backfill.
--   3. The ONE definition of "waiting since"
--      (conversation_waiting_since(conversations)) and of business
--      minutes (response_business_minutes / business_minutes_between),
--      which the live view and the worklist (238) reuse.
--   4. response_escalations: the ledger that makes each level ring once
--      per waiting episode (conversation, waiting_since, level,
--      recipient).
--   5. Three bell types, appended to notifications_type_check by
--      reading its current definition (never restating the list).
--   6. response_escalation_sweep() (service role, from the automations
--      cron every 5 minutes): at the target -> the assignee; at twice
--      the target -> the assignee's team leader(s), else owners and
--      admins; an unassigned chat at the target -> owners and admins.
--
-- Re-runnable: every object is guarded or CREATE OR REPLACE of a
-- function this file owns. Applies on 235 alone and after 236.
-- Asserted by supabase/ci/verify-response-targets.sql.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Settings
-- ------------------------------------------------------------

-- The default business hours: Monday to Saturday 09:00-18:00, Sunday
-- off. One body; the column default and the readers call it, and
-- DEFAULT_RESPONSE_HOURS in src/lib/response-times/hours.ts mirrors it
-- (hours.test.ts reads this file).
CREATE OR REPLACE FUNCTION public.response_default_hours()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT '{"mon":[["09:00","18:00"]],"tue":[["09:00","18:00"]],"wed":[["09:00","18:00"]],"thu":[["09:00","18:00"]],"fri":[["09:00","18:00"]],"sat":[["09:00","18:00"]],"sun":[]}'::jsonb
$$;

-- Shape of `hours`: an object keyed by mon..sun (a missing day is
-- closed), each an array of at most 4 [start, end] pairs of "HH:MM"
-- (end may be "24:00"), each start before its end, in order and not
-- overlapping. Mirrored by validateHours in hours.ts.
CREATE OR REPLACE FUNCTION public.response_hours_valid(p_hours jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  v_key  text;
  v_day  jsonb;
  v_iv   jsonb;
  v_prev text;
  v_s    text;
  v_e    text;
BEGIN
  IF p_hours IS NULL OR jsonb_typeof(p_hours) <> 'object' THEN
    RETURN false;
  END IF;
  FOR v_key, v_day IN SELECT key, value FROM jsonb_each(p_hours) LOOP
    IF v_key NOT IN ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun') THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(v_day) <> 'array' OR jsonb_array_length(v_day) > 4 THEN
      RETURN false;
    END IF;
    v_prev := NULL;
    FOR v_iv IN SELECT value FROM jsonb_array_elements(v_day) LOOP
      IF jsonb_typeof(v_iv) <> 'array' OR jsonb_array_length(v_iv) <> 2
         OR jsonb_typeof(v_iv -> 0) <> 'string' OR jsonb_typeof(v_iv -> 1) <> 'string' THEN
        RETURN false;
      END IF;
      v_s := v_iv ->> 0;
      v_e := v_iv ->> 1;
      IF v_s !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         OR (v_e !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND v_e <> '24:00')
         OR v_s >= v_e
         OR (v_prev IS NOT NULL AND v_s < v_prev) THEN
        RETURN false;
      END IF;
      v_prev := v_e;
    END LOOP;
  END LOOP;
  RETURN true;
END $$;

CREATE TABLE IF NOT EXISTS public.response_settings (
  account_id     uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled        boolean NOT NULL DEFAULT false,
  timezone       text NOT NULL DEFAULT 'Asia/Dubai',
  hours          jsonb NOT NULL DEFAULT public.response_default_hours()
                 CONSTRAINT response_settings_hours_check
                 CHECK (public.response_hours_valid(hours)),
  target_minutes integer NOT NULL DEFAULT 15
                 CONSTRAINT response_settings_target_check
                 CHECK (target_minutes BETWEEN 1 AND 1440),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.response_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS response_settings_select ON public.response_settings;
CREATE POLICY response_settings_select ON public.response_settings
  FOR SELECT USING (public.is_account_member(account_id));

REVOKE ALL ON public.response_settings FROM anon, authenticated;
GRANT SELECT ON public.response_settings TO authenticated;
GRANT ALL ON public.response_settings TO service_role;

-- The only writer. Owner/admin of the caller's ACTIVE workspace; every
-- argument is required (the panel sends the whole form). Refusals carry
-- a HINT the route maps: not_allowed, invalid_timezone, invalid_hours,
-- invalid_target.
CREATE OR REPLACE FUNCTION public.response_settings_set(
  p_enabled        boolean,
  p_timezone       text,
  p_hours          jsonb,
  p_target_minutes integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_account uuid := public.current_account_id();
  v_row     public.response_settings;
BEGIN
  IF v_uid IS NULL OR v_account IS NULL
     OR NOT public.is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'Only an owner or admin can change response times'
      USING ERRCODE = '42501', HINT = 'not_allowed';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'enabled is required' USING ERRCODE = '22023', HINT = 'invalid_enabled';
  END IF;
  IF p_timezone IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = p_timezone) THEN
    RAISE EXCEPTION 'Unknown time zone' USING ERRCODE = '22023', HINT = 'invalid_timezone';
  END IF;
  IF NOT coalesce(public.response_hours_valid(p_hours), false) THEN
    RAISE EXCEPTION 'Business hours are not valid' USING ERRCODE = '22023', HINT = 'invalid_hours';
  END IF;
  IF p_target_minutes IS NULL OR p_target_minutes NOT BETWEEN 1 AND 1440 THEN
    RAISE EXCEPTION 'The target must be 1 to 1440 minutes'
      USING ERRCODE = '22023', HINT = 'invalid_target';
  END IF;

  INSERT INTO public.response_settings AS s
    (account_id, enabled, timezone, hours, target_minutes, updated_at, updated_by)
  VALUES (v_account, p_enabled, p_timezone, p_hours, p_target_minutes, now(), v_uid)
  ON CONFLICT (account_id) DO UPDATE
    SET enabled = EXCLUDED.enabled,
        timezone = EXCLUDED.timezone,
        hours = EXCLUDED.hours,
        target_minutes = EXCLUDED.target_minutes,
        updated_at = now(),
        updated_by = v_uid
  RETURNING s.* INTO v_row;

  RETURN jsonb_build_object(
    'enabled', v_row.enabled,
    'timezone', v_row.timezone,
    'hours', v_row.hours,
    'target_minutes', v_row.target_minutes,
    'updated_at', v_row.updated_at
  );
END $$;

REVOKE ALL ON FUNCTION public.response_settings_set(boolean, text, jsonb, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.response_settings_set(boolean, text, jsonb, integer) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2. customer_waiting_since
-- ------------------------------------------------------------

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS customer_waiting_since timestamptz;

COMMENT ON COLUMN public.conversations.customer_waiting_since IS
  'Since when the customer has been waiting for a reply (237): set by the first customer message after the last reply, cleared by any agent or bot message that did not fail and by closing the chat. Company chats only. Read it through conversation_waiting_since(conversations).';

CREATE INDEX IF NOT EXISTS conversations_customer_waiting_idx
  ON public.conversations (account_id, customer_waiting_since)
  WHERE customer_waiting_since IS NOT NULL AND personal_owner_id IS NULL;

-- Clients may not write the column: an agent clearing it would hide a
-- waiting customer from the escalation. The messages trigger raises the
-- transaction-local app.response_waiting flag for its own UPDATE;
-- server code (no auth.uid(), or the service role) passes through. A
-- client write keeps the stored value rather than failing, so a client
-- that sends a whole row back is not broken by it.
CREATE OR REPLACE FUNCTION public.conversations_waiting_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF coalesce(current_setting('app.response_waiting', true), '') = 'on'
     OR auth.uid() IS NULL
     OR coalesce(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.customer_waiting_since := NULL;
  ELSE
    NEW.customer_waiting_since := OLD.customer_waiting_since;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS conversations_waiting_guard ON public.conversations;
CREATE TRIGGER conversations_waiting_guard
  BEFORE INSERT OR UPDATE OF customer_waiting_since ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_waiting_guard();

-- Closing a chat ends its waiting episode; the next customer message
-- starts a new one.
CREATE OR REPLACE FUNCTION public.conversations_waiting_on_close()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.customer_waiting_since := NULL;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS conversations_waiting_on_close ON public.conversations;
CREATE TRIGGER conversations_waiting_on_close
  BEFORE UPDATE OF status ON public.conversations
  FOR EACH ROW
  WHEN (NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed'
        AND OLD.customer_waiting_since IS NOT NULL)
  EXECUTE FUNCTION public.conversations_waiting_on_close();

-- The messages trigger. It must never fail a message insert: any error
-- is a WARNING (the sub-transaction rolls the flag back with it). Each
-- UPDATE matches only when it changes something, so a message that
-- changes nothing locks nothing.
CREATE OR REPLACE FUNCTION public.response_note_waiting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.conversation_id IS NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    IF NEW.sender_type = 'customer' THEN
      PERFORM set_config('app.response_waiting', 'on', true);
      UPDATE public.conversations c
         SET customer_waiting_since = coalesce(NEW.created_at, now())
       WHERE c.id = NEW.conversation_id
         AND c.customer_waiting_since IS NULL
         AND c.personal_owner_id IS NULL;
      PERFORM set_config('app.response_waiting', '', true);
    ELSIF NEW.status IS DISTINCT FROM 'failed' THEN
      PERFORM set_config('app.response_waiting', 'on', true);
      UPDATE public.conversations c
         SET customer_waiting_since = NULL
       WHERE c.id = NEW.conversation_id
         AND c.customer_waiting_since IS NOT NULL;
      PERFORM set_config('app.response_waiting', '', true);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'response_note_waiting: % (%)', SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.response_note_waiting() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS messages_response_waiting ON public.messages;
CREATE TRIGGER messages_response_waiting
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.response_note_waiting();

-- One-off backfill, bounded to open company chats with a message in the
-- last 30 days: the first customer message after the last reply that
-- did not fail, when the customer wrote last. Only fills NULLs, so a
-- re-run sets nothing the trigger would not have.
UPDATE public.conversations c
   SET customer_waiting_since = w.since
  FROM (
    SELECT c2.id,
           (SELECT min(m.created_at)
              FROM public.messages m
             WHERE m.conversation_id = c2.id
               AND m.sender_type = 'customer'
               AND m.created_at >= now() - interval '30 days'
               AND (lr.at IS NULL OR m.created_at > lr.at)) AS since
      FROM public.conversations c2
      LEFT JOIN LATERAL (
        SELECT max(m.created_at) AS at
          FROM public.messages m
         WHERE m.conversation_id = c2.id
           AND m.sender_type <> 'customer'
           AND m.status <> 'failed'
      ) lr ON true
     WHERE c2.personal_owner_id IS NULL
       AND c2.status <> 'closed'
       AND c2.customer_waiting_since IS NULL
       AND c2.last_message_at >= now() - interval '30 days'
  ) w
 WHERE c.id = w.id
   AND w.since IS NOT NULL;

-- ------------------------------------------------------------
-- 3. The one definition of "waiting" and of business minutes
-- ------------------------------------------------------------

-- Since when this chat's customer has waited for a reply, or NULL: a
-- company chat (personal_owner_id IS NULL), not closed, whose customer
-- wrote last and nobody has replied since. Usable as a computed column
-- (`c.conversation_waiting_since`). Items 8 and 9 (238) read this.
CREATE OR REPLACE FUNCTION public.conversation_waiting_since(c public.conversations)
RETURNS timestamptz
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
           WHEN c.personal_owner_id IS NULL AND c.status <> 'closed'
           THEN c.customer_waiting_since
         END
$$;

GRANT EXECUTE ON FUNCTION public.conversation_waiting_since(public.conversations)
  TO authenticated, service_role;

-- Whole business minutes between two instants under the given hours
-- and time zone (NULL hours / zone = the defaults). Each weekday's
-- intervals are laid on the local calendar, so a DST change moves them
-- with the wall clock. The scan is capped at the last 62 days before
-- p_to: a longer span returns the minutes of those 62 days (a lower
-- bound, far past any target). Mirrored by businessMinutesBetween in
-- src/lib/response-times/hours.ts.
CREATE OR REPLACE FUNCTION public.response_business_minutes(
  p_hours jsonb,
  p_tz    text,
  p_from  timestamptz,
  p_to    timestamptz
)
RETURNS integer
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hours jsonb := coalesce(p_hours, public.response_default_hours());
  v_tz    text := coalesce(nullif(p_tz, ''), 'Asia/Dubai');
  v_from  timestamptz;
  v_day   date;
  v_last  date;
  v_key   text;
  v_iv    jsonb;
  v_s     timestamptz;
  v_e     timestamptz;
  v_secs  numeric := 0;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
    RETURN 0;
  END IF;
  v_from := greatest(p_from, p_to - interval '62 days');
  v_day := (v_from AT TIME ZONE v_tz)::date;
  v_last := (p_to AT TIME ZONE v_tz)::date;
  WHILE v_day <= v_last LOOP
    v_key := (ARRAY['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])[extract(isodow FROM v_day)::int];
    FOR v_iv IN SELECT value FROM jsonb_array_elements(coalesce(v_hours -> v_key, '[]'::jsonb)) LOOP
      v_s := (v_day + (v_iv ->> 0)::time) AT TIME ZONE v_tz;
      v_e := (v_day + (v_iv ->> 1)::time) AT TIME ZONE v_tz;
      v_secs := v_secs + greatest(0, extract(epoch FROM least(v_e, p_to) - greatest(v_s, v_from)));
    END LOOP;
    v_day := v_day + 1;
  END LOOP;
  RETURN floor(v_secs / 60)::integer;
END $$;

GRANT EXECUTE ON FUNCTION public.response_business_minutes(jsonb, text, timestamptz, timestamptz)
  TO authenticated, service_role;

-- The same for a workspace, with its saved hours (the defaults when it
-- has no row). SECURITY INVOKER: a caller who cannot read the row gets
-- the defaults, the service role and definer functions the real hours.
CREATE OR REPLACE FUNCTION public.business_minutes_between(
  p_account uuid,
  p_from    timestamptz,
  p_to      timestamptz
)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT public.response_business_minutes(s.hours, s.timezone, p_from, p_to)
    FROM (SELECT 1) one
    LEFT JOIN public.response_settings s ON s.account_id = p_account
$$;

GRANT EXECUTE ON FUNCTION public.business_minutes_between(uuid, timestamptz, timestamptz)
  TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4. The escalation ledger
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.response_escalations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  waiting_since    timestamptz NOT NULL,
  level            text NOT NULL
                   CONSTRAINT response_escalations_level_check
                   CHECK (level IN ('target', 'escalated', 'unassigned')),
  recipient        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  business_minutes integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT response_escalations_once
    UNIQUE (conversation_id, waiting_since, level, recipient)
);

CREATE INDEX IF NOT EXISTS response_escalations_created_idx
  ON public.response_escalations (created_at);

ALTER TABLE public.response_escalations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.response_escalations FROM anon, authenticated;
GRANT ALL ON public.response_escalations TO service_role;

-- ------------------------------------------------------------
-- 5. Bell types. Appended to the CURRENT list (whatever later
--    migrations added), never restated. Idempotent.
--      response_target_missed  to the assignee, at the target
--      response_escalated      to their leader(s) / owners and admins, at 2x
--      response_unassigned     to owners and admins, an unassigned chat at the target
--    Each row carries conversation_id and contact_id, so the bell opens
--    the chat (hrefFor). push_bell_url is not changed here (Merge need).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_def     text;
  v_new     text[] := ARRAY['response_target_missed', 'response_escalated', 'response_unassigned'];
  v_missing text[];
  v_list    text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.notifications'::regclass
     AND conname = 'notifications_type_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION '237: notifications_type_check is missing';
  END IF;
  SELECT array_agg(t) INTO v_missing
    FROM unnest(v_new) t
   WHERE position(quote_literal(t) IN v_def) = 0;
  IF v_missing IS NULL THEN
    RETURN;
  END IF;
  SELECT string_agg(quote_literal(x), ', ')
    INTO v_list
    FROM (
      SELECT DISTINCT r.m[1] AS x
        FROM regexp_matches(v_def, '''([^'']+)''', 'g') AS r(m)
      UNION
      SELECT unnest(v_missing)
    ) vals;
  ALTER TABLE public.notifications DROP CONSTRAINT notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (%s)) NOT VALID',
    v_list);
  ALTER TABLE public.notifications VALIDATE CONSTRAINT notifications_type_check;
END $$;

-- ------------------------------------------------------------
-- 6. The sweep
-- ------------------------------------------------------------

-- "2 h 10 min" / "45 min", for the bell body.
CREATE OR REPLACE FUNCTION public.response_minutes_label(p_minutes integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
           WHEN p_minutes >= 60 AND p_minutes % 60 = 0 THEN (p_minutes / 60) || ' h'
           WHEN p_minutes >= 60 THEN (p_minutes / 60) || ' h ' || (p_minutes % 60) || ' min'
           ELSE greatest(p_minutes, 0) || ' min'
         END
$$;

-- Live owners and admins of a workspace (auth user ids).
CREATE OR REPLACE FUNCTION public.response_admins(p_account uuid)
RETURNS uuid[]
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(array_agg(DISTINCT p.user_id), '{}')
    FROM public.profiles p
   WHERE p.account_id = p_account
     AND p.deactivated_at IS NULL
     AND p.account_role IN ('owner', 'admin')
$$;

-- Ring one level for one waiting episode: a ledger row per recipient
-- (ON CONFLICT: once per episode, level and person), then a bell for
-- each row actually inserted. Returns the bells written.
CREATE OR REPLACE FUNCTION public.response_ring(
  p_account    uuid,
  p_conv       uuid,
  p_contact    uuid,
  p_since      timestamptz,
  p_level      text,
  p_recipients uuid[],
  p_minutes    integer,
  p_type       text,
  p_title      text,
  p_body       text,
  p_meta       jsonb
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_recipients IS NULL OR cardinality(p_recipients) = 0 THEN
    RETURN 0;
  END IF;
  WITH ins AS (
    INSERT INTO public.response_escalations
      (account_id, conversation_id, waiting_since, level, recipient, business_minutes)
    SELECT p_account, p_conv, p_since, p_level, r, p_minutes
      FROM (SELECT DISTINCT unnest(p_recipients) AS r) x
     WHERE r IS NOT NULL
    ON CONFLICT ON CONSTRAINT response_escalations_once DO NOTHING
    RETURNING recipient
  )
  INSERT INTO public.notifications
    (account_id, user_id, type, conversation_id, contact_id, title, body, meta)
  SELECT p_account, ins.recipient, p_type, p_conv, p_contact, p_title, p_body, p_meta
    FROM ins;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION public.response_ring(uuid, uuid, uuid, timestamptz, text, uuid[], integer, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.response_admins(uuid) FROM PUBLIC, anon, authenticated;

-- For every workspace with the switch on: the open company chats whose
-- customer has waited at least the target in business minutes, oldest
-- first, at most 500 a pass. Waits that began more than 7 days ago are
-- left alone (switching on must not ring a backlog of abandoned
-- chats), and a chat is skipped once its last level has rung for the
-- episode. Each workspace runs in its own sub-transaction: one bad row
-- cannot stop the others. Ledger rows past 14 days are trimmed (an
-- episode that old can no longer ring).
CREATE OR REPLACE FUNCTION public.response_escalation_sweep()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s           record;
  c           record;
  v_mins      integer;
  v_assignee  uuid;
  v_name      text;
  v_leaders   uuid[];
  v_meta      jsonb;
  v_wait      text;
  n_accounts  integer := 0;
  n_failed    integer := 0;
  n_chats     integer := 0;
  n_bells     integer := 0;
  n_trimmed   integer := 0;
BEGIN
  FOR s IN
    SELECT r.account_id, r.timezone, r.hours, r.target_minutes
      FROM public.response_settings r
      JOIN public.accounts a ON a.id = r.account_id
     WHERE r.enabled
       AND a.archived_at IS NULL
  LOOP
    n_accounts := n_accounts + 1;
    BEGIN
      FOR c IN
        SELECT cv.id, cv.contact_id, cv.assigned_agent_id,
               cv.customer_waiting_since AS since,
               coalesce(nullif(btrim(ct.name), ''), ct.phone, 'A customer') AS who
          FROM public.conversations cv
          LEFT JOIN public.contacts ct ON ct.id = cv.contact_id
         WHERE cv.account_id = s.account_id
           AND cv.customer_waiting_since IS NOT NULL
           AND cv.personal_owner_id IS NULL
           AND cv.status <> 'closed'
           AND cv.customer_waiting_since <= now() - make_interval(mins => s.target_minutes)
           AND cv.customer_waiting_since >= now() - interval '7 days'
           AND NOT EXISTS (
             SELECT 1 FROM public.response_escalations e
              WHERE e.conversation_id = cv.id
                AND e.waiting_since = cv.customer_waiting_since
                AND e.level = CASE WHEN cv.assigned_agent_id IS NULL
                                   THEN 'unassigned' ELSE 'escalated' END)
         ORDER BY cv.customer_waiting_since
         LIMIT 500
      LOOP
        v_mins := public.response_business_minutes(s.hours, s.timezone, c.since, now());
        CONTINUE WHEN v_mins < s.target_minutes;
        n_chats := n_chats + 1;
        v_wait := public.response_minutes_label(v_mins);

        -- A live, non-guest assignee in this workspace, else none.
        SELECT p.user_id, coalesce(nullif(btrim(p.full_name), ''), p.email)
          INTO v_assignee, v_name
          FROM public.profiles p
         WHERE p.user_id = c.assigned_agent_id
           AND p.account_id = s.account_id
           AND p.deactivated_at IS NULL
           AND p.account_role <> 'bank_guest'
         LIMIT 1;
        IF NOT FOUND THEN
          v_assignee := NULL;
          v_name := NULL;
        END IF;

        v_meta := jsonb_build_object(
          'waiting_since', c.since,
          'business_minutes', v_mins,
          'target_minutes', s.target_minutes,
          'assignee_id', v_assignee);

        IF v_assignee IS NULL THEN
          n_bells := n_bells + public.response_ring(
            s.account_id, c.id, c.contact_id, c.since, 'unassigned',
            public.response_admins(s.account_id), v_mins,
            'response_unassigned',
            'A customer is waiting and nobody is assigned',
            c.who || ' has waited ' || v_wait || ' (business hours) with no one assigned.',
            v_meta || jsonb_build_object('level', 'unassigned'));
          CONTINUE;
        END IF;

        n_bells := n_bells + public.response_ring(
          s.account_id, c.id, c.contact_id, c.since, 'target',
          ARRAY[v_assignee], v_mins,
          'response_target_missed',
          'A customer is waiting for your reply',
          c.who || ' has waited ' || v_wait || ' (business hours), past the '
            || public.response_minutes_label(s.target_minutes) || ' target.',
          v_meta || jsonb_build_object('level', 'target'));

        IF v_mins >= 2 * s.target_minutes THEN
          SELECT coalesce(array_agg(DISTINCT t.leader_user_id), '{}')
            INTO v_leaders
            FROM public.team_members tm
            JOIN public.teams t ON t.id = tm.team_id AND t.account_id = s.account_id
            JOIN public.profiles lp ON lp.user_id = t.leader_user_id
                                   AND lp.account_id = s.account_id
                                   AND lp.deactivated_at IS NULL
           WHERE tm.account_id = s.account_id
             AND tm.user_id = v_assignee
             AND t.leader_user_id IS NOT NULL
             AND t.leader_user_id <> v_assignee;
          IF cardinality(v_leaders) = 0 THEN
            v_leaders := public.response_admins(s.account_id);
          END IF;
          n_bells := n_bells + public.response_ring(
            s.account_id, c.id, c.contact_id, c.since, 'escalated',
            v_leaders, v_mins,
            'response_escalated',
            'A customer has waited twice the target',
            c.who || ' has waited ' || v_wait || ' (business hours) for '
              || coalesce(v_name, 'their agent') || '.',
            v_meta || jsonb_build_object('level', 'escalated'));
        END IF;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      n_failed := n_failed + 1;
      RAISE WARNING 'response_escalation_sweep: account % failed: % (%)',
        s.account_id, SQLERRM, SQLSTATE;
    END;
  END LOOP;

  DELETE FROM public.response_escalations
   WHERE id IN (SELECT e.id FROM public.response_escalations e
                 WHERE e.created_at < now() - interval '14 days'
                 LIMIT 5000);
  GET DIAGNOSTICS n_trimmed = ROW_COUNT;

  RETURN jsonb_build_object(
    'accounts', n_accounts,
    'failed', n_failed,
    'chats', n_chats,
    'notifications', n_bells,
    'trimmed', n_trimmed);
END $$;

REVOKE ALL ON FUNCTION public.response_escalation_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.response_escalation_sweep() TO service_role;
