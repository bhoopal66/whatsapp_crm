-- ============================================================
-- 293_webhook_off_bell.sql — a webhook endpoint never goes off in one bad
-- minute or in silence, and a queued event or message is not lost on the way.
--
--  1. webhook_endpoints.first_failure_at: when the present streak began.
--     record_webhook_failure (RESTATES 028's) switches an endpoint off only
--     when the streak is long enough AND spans 30 minutes; the outbox sends
--     ten at a time, so a burst alone reached the count within a minute.
--     A trigger ends the streak when failure_count is set to 0 (a success,
--     as any build writes it) and when an endpoint is switched on again: a
--     session may not write first_failure_at (289).
--  2. The flip to off rings the live owners and admins once
--     (webhook_disabled, opens Settings -> API).
--  3. webhook_outbox_release(id): a claimed event whose endpoints could not
--     be read goes back to the queue. Nothing was sent, so delivery stays
--     at most once. Not after 24 hours, so a row cannot block for ever.
--  4. webhook_inbox_waiting(channel): how many messages of a number are
--     still unprocessed; removing the number deletes them (264's CASCADE).
--
-- Re-running 028 puts the old record_webhook_failure back: re-run 293.
-- Apply after 292, before the build, as a superuser or BYPASSRLS role.
-- Additive for the previous build. Re-runnable. verify-webhook-off-bell.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '293 must be applied by a superuser or BYPASSRLS role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.notifications'::regclass
                  AND conname = 'notifications_type_check')
     OR position('WHEN n.type = ''retention_failed'' THEN' IN
                 pg_get_functiondef('public.push_bell_url(public.notifications)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '293: notifications_type_check or push_bell_url is not as 282 left it';
  END IF;
  IF to_regclass('public.webhook_inbox') IS NULL OR to_regclass('public.webhook_event_outbox') IS NULL THEN
    RAISE EXCEPTION '293: apply 134 and 264 first';
  END IF;
END $$;

-- ---------- 2: the bell type and where it leads ----------

DO $$
DECLARE
  v_def  text := (SELECT pg_get_constraintdef(oid) FROM pg_constraint
                   WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check');
  v_fn   text := pg_get_functiondef('public.push_bell_url(public.notifications)'::regprocedure);
  v_list text;
BEGIN
  -- Every type the constraint has now, plus ours (as 274, 282).
  IF position('''webhook_disabled''' IN v_def) = 0 THEN
    SELECT string_agg(quote_literal(x), ', ') INTO v_list
      FROM (SELECT DISTINCT q.m[1] AS x FROM regexp_matches(v_def, '''([^'']+)''', 'g') AS q(m)
            UNION SELECT 'webhook_disabled') vals;
    ALTER TABLE public.notifications DROP CONSTRAINT notifications_type_check;
    EXECUTE format('ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (%s)) NOT VALID', v_list);
    ALTER TABLE public.notifications VALIDATE CONSTRAINT notifications_type_check;
  END IF;
  IF position('webhook_disabled' IN v_fn) = 0 THEN
    EXECUTE replace(v_fn, 'WHEN n.type = ''retention_failed'' THEN',
      'WHEN n.type = ''webhook_disabled'' THEN
      RETURN CASE WHEN v_role IN (''owner'', ''admin'') THEN ''/settings?tab=api'' ELSE ''/notifications'' END;
    WHEN n.type = ''retention_failed'' THEN');
  END IF;
END $$;

-- ---------- 1: the streak ----------

ALTER TABLE public.webhook_endpoints ADD COLUMN IF NOT EXISTS first_failure_at timestamptz NULL;
COMMENT ON COLUMN public.webhook_endpoints.first_failure_at IS
  'When the present run of failed deliveries began; NULL when the last one succeeded. Written by record_webhook_failure and webhook_endpoint_streak. Migration 293.';

CREATE OR REPLACE FUNCTION public.webhook_endpoint_streak()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.is_active AND NOT OLD.is_active THEN
    NEW.failure_count := 0;
  END IF;
  IF NEW.failure_count = 0 THEN
    NEW.first_failure_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS webhook_endpoints_streak ON public.webhook_endpoints;
CREATE TRIGGER webhook_endpoints_streak
  BEFORE UPDATE OF is_active, failure_count ON public.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION public.webhook_endpoint_streak();

-- One failed delivery. Only ever switches off. The row lock serialises
-- deliveries running at once, so no increment is lost and one caller sees
-- the flip. The bell names the host only (a URL may carry a token).
CREATE OR REPLACE FUNCTION public.record_webhook_failure(endpoint_id uuid, max_failures integer)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  e     public.webhook_endpoints%ROWTYPE;
  v_off boolean;
BEGIN
  SELECT * INTO e FROM public.webhook_endpoints w WHERE w.id = endpoint_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_off := e.is_active AND e.failure_count + 1 >= max_failures
           AND coalesce(e.first_failure_at <= now() - interval '30 minutes', false);
  UPDATE public.webhook_endpoints w
     SET failure_count = e.failure_count + 1,
         first_failure_at = coalesce(e.first_failure_at, now()),
         is_active = e.is_active AND NOT v_off
   WHERE w.id = e.id;
  IF v_off THEN
    BEGIN
      INSERT INTO public.notifications (account_id, user_id, type, title, body, meta)
      SELECT DISTINCT e.account_id, p.user_id, 'webhook_disabled', 'A webhook was switched off',
             coalesce(substring(e.url FROM '^https?://(?:[^/?#@]*@)?([^/?#]+)'), 'The receiver')
               || ' failed every delivery for 30 minutes or more, so no more events are sent to it. Fix the receiver, then switch the webhook on again through the API.',
             jsonb_build_object('endpoint_id', e.id)
        FROM public.profiles p
       WHERE p.account_id = e.account_id AND p.deactivated_at IS NULL AND p.account_role IN ('owner', 'admin');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'webhook_disabled bell for endpoint % not rung: % (%)', e.id, SQLERRM, SQLSTATE;
    END;
  END IF;
END;
$$;

-- ---------- 3: give a claimed event back ----------

CREATE OR REPLACE FUNCTION public.webhook_outbox_release(p_id bigint)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.webhook_event_outbox o SET delivered_at = NULL
   WHERE o.id = p_id AND o.delivered_at IS NOT NULL AND o.created_at > now() - interval '24 hours';
  RETURN FOUND;
END;
$$;

-- ---------- 4: messages of a number not processed yet ----------

-- A receipt ('status') is not a message: nobody misses it.
CREATE OR REPLACE FUNCTION public.webhook_inbox_waiting(p_channel uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT count(*)::integer FROM public.webhook_inbox w
   WHERE w.channel = p_channel AND w.done_at IS NULL AND w.dead_at IS NULL AND w.kind <> 'status'
$$;

REVOKE ALL ON FUNCTION public.webhook_endpoint_streak(), public.record_webhook_failure(uuid, integer),
  public.webhook_outbox_release(bigint), public.webhook_inbox_waiting(uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_webhook_failure(uuid, integer), public.webhook_outbox_release(bigint),
  public.webhook_inbox_waiting(uuid)
TO service_role;

RESET lock_timeout;

NOTIFY pgrst, 'reload schema';
