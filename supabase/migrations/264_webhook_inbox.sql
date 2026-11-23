-- ============================================================
-- 264_webhook_inbox.sql — durable inbound WhatsApp events
--
-- The three webhook routes answered 200 and only then processed, so a
-- database error or a process kill afterwards lost the customer's
-- message for good. Each accepted event (one message or one receipt) is
-- now written here BEFORE the 200, settled once it is processed, and
-- retried by the automations cron until it is done or dead.
--
--   1. webhook_inbox, reached only through the functions below.
--   2. webhook_inbox_record: insert and lease; a redelivery of a row
--      still waiting (or dead) takes it over, one leased or done does not.
--   3. webhook_inbox_claim: due rows, FOR UPDATE SKIP LOCKED, leased.
--   4. webhook_inbox_settle: done | failed (1, 2, 5, 15, 60 min, dead
--      after 8 attempts) | unmatched (a receipt whose message has no row
--      yet: 30 s, 60 s, then done).
--   5. webhook_inbox_notify_dead: owners and admins, once per dead event.
--   6. webhook_inbox_purge, webhook_inbox_stats.
--   7. The bell type inbound_message_failed.
--
-- The payload holds the customer's words, so it is emptied the moment a
-- row is done; a done row stays 24 h only to recognise a redelivery, a
-- dead one 14 days.
--
-- Additive: the previous build neither reads nor writes any of it.
-- Re-runnable. Asserted by supabase/ci/verify-webhook-inbox.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '264 must be applied by a superuser or BYPASSRLS role';
  END IF;
END $$;

-- ---------- 1. The table ----------

CREATE TABLE IF NOT EXISTS public.webhook_inbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  channel          uuid NOT NULL,
  provider         text NOT NULL CHECK (provider IN ('whapi', 'meta', 'openwa')),
  -- The replay key (src/lib/edge), so both agree on what one event is.
  event_key        text NOT NULL CHECK (char_length(event_key) BETWEEN 1 AND 512),
  kind             text NOT NULL CHECK (kind IN ('message', 'status', 'own_send', 'group_message')),
  payload          jsonb NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at       timestamptz,
  done_at          timestamptz,
  dead_at          timestamptz,
  dead_notified_at timestamptz,
  last_error       text CHECK (char_length(last_error) <= 200),
  CONSTRAINT webhook_inbox_event_key UNIQUE (provider, channel, event_key),
  -- A removed number takes its rows along: without its credentials
  -- nothing can process them. Same account, as 062 does elsewhere.
  CONSTRAINT webhook_inbox_channel_fkey FOREIGN KEY (channel, account_id)
    REFERENCES public.whatsapp_config (id, account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS webhook_inbox_due_idx
  ON public.webhook_inbox (next_attempt_at)
  WHERE done_at IS NULL AND dead_at IS NULL;
CREATE INDEX IF NOT EXISTS webhook_inbox_done_idx
  ON public.webhook_inbox (done_at) WHERE done_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS webhook_inbox_dead_idx
  ON public.webhook_inbox (dead_at) WHERE dead_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS webhook_inbox_account_idx
  ON public.webhook_inbox (account_id);
CREATE INDEX IF NOT EXISTS webhook_inbox_channel_idx
  ON public.webhook_inbox (channel, account_id);

ALTER TABLE public.webhook_inbox ENABLE ROW LEVEL SECURITY;  -- no policy: no client row, ever
ALTER TABLE public.webhook_inbox FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.webhook_inbox FROM PUBLIC, anon, authenticated, service_role;

-- ---------- 2. Record ----------

-- p_events: [{account_id, channel, provider, event_key, kind, payload}].
-- Every row is written or none. `state`: 'new' and 'retaken' are leased
-- to the caller, who processes and settles them; 'busy' is another
-- worker's; 'done' was processed already.
CREATE OR REPLACE FUNCTION public.webhook_inbox_record(p_events jsonb)
RETURNS TABLE (event_key text, id uuid, attempt integer, state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  e     jsonb;
  v_row public.webhook_inbox%ROWTYPE;
BEGIN
  IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' THEN
    RAISE EXCEPTION 'p_events must be an array' USING ERRCODE = '22023';
  END IF;
  -- In key order, so two deliveries holding the same events never
  -- deadlock on each other's row locks.
  FOR e IN
    SELECT x FROM jsonb_array_elements(p_events) x
     ORDER BY x->>'provider', x->>'channel', x->>'event_key'
  LOOP
    INSERT INTO public.webhook_inbox
      (account_id, channel, provider, event_key, kind, payload, attempts, claimed_at)
    VALUES
      ((e->>'account_id')::uuid, (e->>'channel')::uuid, e->>'provider',
       e->>'event_key', e->>'kind', e->'payload', 1, now())
    ON CONFLICT ON CONSTRAINT webhook_inbox_event_key DO NOTHING
    RETURNING * INTO v_row;
    IF FOUND THEN
      RETURN QUERY SELECT v_row.event_key, v_row.id, v_row.attempts, 'new'::text;
      CONTINUE;
    END IF;

    -- A redelivery of a row nobody is working: waiting for its retry,
    -- left by a killed process, or dead (its attempts start again).
    UPDATE public.webhook_inbox w
       SET claimed_at = now(),
           attempts = CASE WHEN w.dead_at IS NULL THEN w.attempts + 1 ELSE 1 END,
           dead_at = NULL,
           dead_notified_at = NULL
     WHERE w.provider = e->>'provider'
       AND w.channel = (e->>'channel')::uuid
       AND w.event_key = e->>'event_key'
       AND w.done_at IS NULL
       AND (w.claimed_at IS NULL OR w.claimed_at < now() - interval '5 minutes')
    RETURNING * INTO v_row;
    IF FOUND THEN
      RETURN QUERY SELECT v_row.event_key, v_row.id, v_row.attempts, 'retaken'::text;
      CONTINUE;
    END IF;

    RETURN QUERY
      SELECT w.event_key, w.id, w.attempts,
             CASE WHEN w.done_at IS NULL THEN 'busy' ELSE 'done' END
        FROM public.webhook_inbox w
       WHERE w.provider = e->>'provider'
         AND w.channel = (e->>'channel')::uuid
         AND w.event_key = e->>'event_key';
  END LOOP;
END $$;

-- ---------- 3. Claim ----------

-- Due rows, oldest first, leased for five minutes: longer than one event
-- can take, so a slow first attempt is not run twice, and a killed one
-- comes back. A lease that ran out on the last attempt is dead (a
-- receipt is simply done: it is never worth a bell).
CREATE OR REPLACE FUNCTION public.webhook_inbox_claim(p_limit integer DEFAULT 1)
RETURNS TABLE (
  id uuid, account_id uuid, channel uuid, provider text, event_key text,
  kind text, payload jsonb, received_at timestamptz, attempt integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  UPDATE public.webhook_inbox w
     SET claimed_at = NULL,
         done_at = CASE WHEN w.kind = 'status' THEN now() END,
         dead_at = CASE WHEN w.kind <> 'status' THEN now() END,
         payload = CASE WHEN w.kind = 'status' THEN '{}'::jsonb ELSE w.payload END,
         last_error = coalesce(w.last_error, 'processing did not finish')
   WHERE w.id IN (
     SELECT x.id FROM public.webhook_inbox x
      WHERE x.done_at IS NULL AND x.dead_at IS NULL AND x.attempts >= 8
        AND x.claimed_at < now() - interval '5 minutes'
      FOR UPDATE SKIP LOCKED);

  RETURN QUERY
  UPDATE public.webhook_inbox w
     SET claimed_at = now(), attempts = w.attempts + 1
   WHERE w.id IN (
     SELECT x.id FROM public.webhook_inbox x
      WHERE x.done_at IS NULL AND x.dead_at IS NULL AND x.attempts < 8
        AND x.next_attempt_at <= now()
        AND (x.claimed_at IS NULL OR x.claimed_at < now() - interval '5 minutes')
      ORDER BY x.received_at
      LIMIT greatest(1, least(coalesce(p_limit, 1), 50))
      FOR UPDATE SKIP LOCKED)
  RETURNING w.id, w.account_id, w.channel, w.provider, w.event_key,
            w.kind, w.payload, w.received_at, w.attempts;
END $$;

-- ---------- 4. Settle ----------

-- `p_attempt` is the attempt the caller holds: a worker whose lease was
-- taken over cannot fail the row under the new one. Done is accepted from
-- either, since the event is processed. Answers the row's new state
-- (done | retry | dead), or NULL when nothing was changed.
CREATE OR REPLACE FUNCTION public.webhook_inbox_settle(
  p_id uuid, p_attempt integer, p_outcome text, p_error text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state text;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('done', 'failed', 'unmatched') THEN
    RAISE EXCEPTION 'unknown outcome' USING ERRCODE = '22023';
  END IF;

  IF p_outcome = 'done' OR (p_outcome = 'unmatched' AND p_attempt >= 3) THEN
    UPDATE public.webhook_inbox w
       SET done_at = now(), dead_at = NULL, claimed_at = NULL, payload = '{}'::jsonb,
           last_error = CASE WHEN p_outcome = 'unmatched' THEN 'no message for this receipt'
                             ELSE left(p_error, 200) END
     WHERE w.id = p_id AND w.done_at IS NULL
       AND (p_outcome = 'done' OR w.attempts = p_attempt)
    RETURNING 'done' INTO v_state;
    RETURN v_state;
  END IF;

  UPDATE public.webhook_inbox w
     SET claimed_at = NULL,
         last_error = left(coalesce(p_error, CASE WHEN p_outcome = 'unmatched'
                                                  THEN 'no message for this receipt' END), 200),
         dead_at = CASE WHEN w.attempts >= 8 AND w.kind <> 'status' THEN now() END,
         done_at = CASE WHEN w.attempts >= 8 AND w.kind = 'status' THEN now() END,
         payload = CASE WHEN w.attempts >= 8 AND w.kind = 'status' THEN '{}'::jsonb ELSE w.payload END,
         next_attempt_at = now() + CASE
           WHEN p_outcome = 'unmatched' AND p_attempt <= 1 THEN interval '30 seconds'
           WHEN p_outcome = 'unmatched' THEN interval '60 seconds'
           ELSE (ARRAY[interval '1 min', interval '2 min', interval '5 min',
                       interval '15 min', interval '60 min'])[least(greatest(w.attempts, 1), 5)]
         END
   WHERE w.id = p_id AND w.done_at IS NULL AND w.dead_at IS NULL
     AND w.attempts = p_attempt
  RETURNING CASE WHEN w.done_at IS NOT NULL THEN 'done'
                 WHEN w.dead_at IS NOT NULL THEN 'dead' ELSE 'retry' END
    INTO v_state;
  RETURN v_state;
END $$;

-- ---------- 5. Dead events ring once ----------

-- One bell per owner/admin for the account's newly dead events, marked
-- in the same statement so a second cron cannot ring again. No customer
-- text. Answers one row per account for the app's one log line.
CREATE OR REPLACE FUNCTION public.webhook_inbox_notify_dead()
RETURNS TABLE (account_id uuid, events integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  r record;
BEGIN
  FOR r IN
    WITH marked AS (
      UPDATE public.webhook_inbox w SET dead_notified_at = now()
       WHERE w.id IN (
         SELECT x.id FROM public.webhook_inbox x
          WHERE x.dead_at IS NOT NULL AND x.dead_notified_at IS NULL
          FOR UPDATE SKIP LOCKED)
      RETURNING w.account_id, w.channel)
    SELECT m.account_id, count(*)::integer AS n,
           (array_agg(m.channel))[1] AS channel
      FROM marked m GROUP BY m.account_id
  LOOP
    INSERT INTO public.notifications (account_id, user_id, type, title, body, meta)
    SELECT DISTINCT r.account_id, p.user_id, 'inbound_message_failed',
           CASE WHEN r.n = 1 THEN 'A WhatsApp message could not be saved'
                ELSE r.n || ' WhatsApp messages could not be saved' END,
           'It was retried for several hours. Ask the customer to send it again, and tell whoever runs the server.',
           jsonb_build_object('channel_id', r.channel, 'events', r.n)
      FROM public.profiles p
     WHERE p.account_id = r.account_id
       AND p.deactivated_at IS NULL
       AND p.account_role IN ('owner', 'admin');
    account_id := r.account_id;
    events := r.n;
    RETURN NEXT;
  END LOOP;
END $$;

-- ---------- 6. Purge and stats ----------

CREATE OR REPLACE FUNCTION public.webhook_inbox_purge()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM public.webhook_inbox w
   WHERE w.done_at < now() - interval '24 hours'
      OR w.dead_at < now() - interval '14 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION public.webhook_inbox_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'pending', count(*) FILTER (WHERE w.dead_at IS NULL),
    'dead', count(*) FILTER (WHERE w.dead_at IS NOT NULL),
    'oldest_pending_age_seconds',
      coalesce(extract(epoch FROM now() - min(w.received_at) FILTER (WHERE w.dead_at IS NULL))::bigint, 0))
    FROM public.webhook_inbox w
   WHERE w.done_at IS NULL
$$;

REVOKE ALL ON FUNCTION public.webhook_inbox_record(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.webhook_inbox_claim(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.webhook_inbox_settle(uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.webhook_inbox_notify_dead() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.webhook_inbox_purge() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.webhook_inbox_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.webhook_inbox_record(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.webhook_inbox_claim(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.webhook_inbox_settle(uuid, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.webhook_inbox_notify_dead() TO service_role;
GRANT EXECUTE ON FUNCTION public.webhook_inbox_purge() TO service_role;
GRANT EXECUTE ON FUNCTION public.webhook_inbox_stats() TO service_role;

-- ---------- 7. The bell type ----------

-- Appended to the CHECK as it stands (237's way), never restated.
DO $$
DECLARE
  v_def  text;
  v_list text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.notifications'::regclass
     AND conname = 'notifications_type_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION '264: notifications_type_check is missing';
  END IF;
  IF position(quote_literal('inbound_message_failed') IN v_def) > 0 THEN
    RETURN;
  END IF;
  SELECT string_agg(quote_literal(x), ', ') INTO v_list
    FROM (
      SELECT DISTINCT r.m[1] AS x
        FROM regexp_matches(v_def, '''([^'']+)''', 'g') AS r(m)
      UNION
      SELECT 'inbound_message_failed'
    ) vals;
  ALTER TABLE public.notifications DROP CONSTRAINT notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (%s)) NOT VALID',
    v_list);
  ALTER TABLE public.notifications VALIDATE CONSTRAINT notifications_type_check;
END $$;

NOTIFY pgrst, 'reload schema';
