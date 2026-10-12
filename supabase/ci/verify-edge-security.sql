-- Behavioural regression suite for the edge security stores (migration 084).
--
-- The Meta webhook's replay keys, the sliding-window rate limiter and
-- the admin login lockout are Postgres functions so every app instance
-- shares one window and one clock. This asserts the window (4 allowed,
-- the 5th refused with a retry hint and not recorded, the next window
-- open, scopes and keys independent, p_now honoured and the database
-- clock used without it), the two-phase replay claim (new / inflight /
-- done, confirm only with the current token, release, takeover of a
-- lapsed lease), the lockout (5 per pair, 20 per ip, a success clears
-- only its pair, locks expire), edge_purge, and that anon and
-- authenticated can neither touch the tables nor call the functions.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. Fixtures are rolled back by a sentinel exception.

DO $verify$
DECLARE
  t0     TIMESTAMPTZ := '2026-10-04 10:00:00+00';
  ms     INTERVAL := interval '1 millisecond';
  mins   INTERVAL := interval '1 minute';
  rc     RECORD;
  st     TEXT;
  ok     BOOLEAN;
  r      TEXT;
  i      INT;
  obj    TEXT;
  role_  TEXT;
  n      INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role; 'ok', or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.edge_try(p_role text, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      BEGIN
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        EXECUTE p_sql;
        RESET ROLE;
        RETURN 'ok';
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  -- ---------- sliding window ----------
  FOR i IN 0..3 LOOP
    SELECT * INTO rc FROM public.edge_rate_check('webhook.number', 'v-n1', 4, 1000, t0 + i * 100 * ms);
    n := n + 1;
    IF NOT rc.allowed OR rc.remaining <> 3 - i THEN
      failed := array_append(failed, format('window: hit %s of 4 allowed=%s remaining=%s', i + 1, rc.allowed, rc.remaining));
    END IF;
  END LOOP;
  SELECT * INTO rc FROM public.edge_rate_check('webhook.number', 'v-n1', 4, 1000, t0 + 400 * ms);
  n := n + 1;
  IF rc.allowed OR rc.retry_after_ms <> 600 THEN
    failed := array_append(failed, format('window: 5th hit allowed=%s retry_after_ms=%s (want false, 600)', rc.allowed, rc.retry_after_ms));
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM public.edge_rate_events WHERE scope = 'webhook.number' AND key = 'v-n1') <> 4 THEN
    failed := array_append(failed, 'window: a refused hit was recorded'::text);
  END IF;
  n := n + 1;
  IF NOT (SELECT allowed FROM public.edge_rate_check('webhook.ip', 'v-n1', 4, 1000, t0 + 400 * ms)) THEN
    failed := array_append(failed, 'window: another scope shares the key''s window'::text);
  END IF;
  n := n + 1;
  IF NOT (SELECT allowed FROM public.edge_rate_check('webhook.number', 'v-n2', 4, 1000, t0 + 400 * ms)) THEN
    failed := array_append(failed, 'window: another key shares the window'::text);
  END IF;
  n := n + 1;
  IF NOT (SELECT allowed FROM public.edge_rate_check('webhook.number', 'v-n1', 4, 1000, t0 + 1000 * ms)) THEN
    failed := array_append(failed, 'window: the next window is still refused (old hits not pruned)'::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM public.edge_rate_events WHERE key = 'v-n1' AND at = t0 + 100 * ms) THEN
    failed := array_append(failed, 'window: p_now was not used to stamp the hit'::text);
  END IF;
  PERFORM public.edge_rate_check('admin.ip', 'v-clock', 10, 1000);
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM public.edge_rate_events WHERE key = 'v-clock'
                  AND abs(extract(epoch FROM at - clock_timestamp())) < 60) THEN
    failed := array_append(failed, 'window: without p_now the hit is not on the database clock'::text);
  END IF;

  -- ---------- replay claim / confirm / release ----------
  st := public.edge_replay_claim('msg:v1', 'tok-1', 60, t0);
  n := n + 1;
  IF st <> 'new' THEN failed := array_append(failed, ('replay: first claim ' || st)::text); END IF;
  st := public.edge_replay_claim('msg:v1', 'tok-2', 60, t0 + interval '10 seconds');
  n := n + 1;
  IF st <> 'inflight' THEN failed := array_append(failed, ('replay: claim under a live lease ' || st)::text); END IF;
  n := n + 1;
  IF public.edge_replay_confirm('msg:v1', 'tok-2', 86400, t0 + interval '20 seconds') THEN
    failed := array_append(failed, 'replay: a losing token confirmed the key'::text);
  END IF;
  n := n + 1;
  IF NOT public.edge_replay_confirm('msg:v1', 'tok-1', 86400, t0 + interval '20 seconds') THEN
    failed := array_append(failed, 'replay: the current token could not confirm'::text);
  END IF;
  st := public.edge_replay_claim('msg:v1', 'tok-3', 60, t0 + interval '30 seconds');
  n := n + 1;
  IF st <> 'done' THEN failed := array_append(failed, ('replay: claim after confirm ' || st)::text); END IF;
  st := public.edge_replay_claim('msg:v1', 'tok-4', 60, t0 + interval '20 seconds' + interval '86400 seconds');
  n := n + 1;
  IF st <> 'new' THEN failed := array_append(failed, ('replay: claim after the 24 h TTL ' || st)::text); END IF;

  PERFORM public.edge_replay_claim('msg:v2', 'tok-a', 60, t0);
  n := n + 1;
  IF public.edge_replay_release('msg:v2', 'tok-wrong') THEN
    failed := array_append(failed, 'replay: a wrong token released the key'::text);
  END IF;
  ok := public.edge_replay_release('msg:v2', 'tok-a');
  n := n + 1;
  IF NOT ok OR EXISTS (SELECT 1 FROM public.edge_seen_keys WHERE key = 'msg:v2') THEN
    failed := array_append(failed, 'replay: release did not free the key'::text);
  END IF;
  st := public.edge_replay_claim('msg:v2', 'tok-b', 60, t0);
  n := n + 1;
  IF st <> 'new' THEN failed := array_append(failed, ('replay: claim after release ' || st)::text); END IF;
  PERFORM public.edge_replay_confirm('msg:v2', 'tok-b', 86400, t0);
  ok := public.edge_replay_release('msg:v2', 'tok-b');
  n := n + 1;
  IF ok OR NOT EXISTS (SELECT 1 FROM public.edge_seen_keys WHERE key = 'msg:v2' AND confirmed) THEN
    failed := array_append(failed, 'replay: release dropped a confirmed key'::text);
  END IF;

  PERFORM public.edge_replay_claim('msg:v3', 'tok-x', 60, t0);
  st := public.edge_replay_claim('msg:v3', 'tok-y', 60, t0 + 59999 * ms);
  n := n + 1;
  IF st <> 'inflight' THEN failed := array_append(failed, ('replay: claim 1 ms before the lease ends ' || st)::text); END IF;
  st := public.edge_replay_claim('msg:v3', 'tok-y', 60, t0 + interval '60 seconds');
  n := n + 1;
  IF st <> 'new' THEN failed := array_append(failed, ('replay: a lapsed lease was not taken over: ' || st)::text); END IF;
  n := n + 1;
  IF public.edge_replay_confirm('msg:v3', 'tok-x', 86400, t0 + interval '61 seconds') THEN
    failed := array_append(failed, 'replay: the lapsed claim''s token confirmed the key'::text);
  END IF;
  n := n + 1;
  IF NOT public.edge_replay_confirm('msg:v3', 'tok-y', 86400, t0 + interval '61 seconds') THEN
    failed := array_append(failed, 'replay: the takeover token could not confirm'::text);
  END IF;

  -- ---------- lockout ----------
  FOR i IN 1..4 LOOP
    SELECT * INTO rc FROM public.edge_auth_fail('10.84.0.1', 'u', t0 + i * mins);
    n := n + 1;
    IF rc.locked THEN failed := array_append(failed, format('lockout: locked after %s failures', i)); END IF;
  END LOOP;
  SELECT * INTO rc FROM public.edge_auth_fail('10.84.0.1', 'u', t0 + 9 * mins);
  n := n + 1;
  IF NOT rc.locked OR rc.retry_after_ms <> 900000 THEN
    failed := array_append(failed, format('lockout: 5th failure locked=%s retry_after_ms=%s (want true, 900000)', rc.locked, rc.retry_after_ms));
  END IF;
  n := n + 1;
  IF NOT (SELECT locked FROM public.edge_auth_lock_state('10.84.0.1', 'u', t0 + 9 * mins))
     OR (SELECT locked FROM public.edge_auth_lock_state('10.84.0.1', 'other', t0 + 9 * mins)) THEN
    failed := array_append(failed, 'lockout: a pair lock is not exactly that pair'::text);
  END IF;
  n := n + 1;
  IF NOT (SELECT locked FROM public.edge_auth_lock_state('10.84.0.1', 'u', t0 + 24 * mins - ms))
     OR (SELECT locked FROM public.edge_auth_lock_state('10.84.0.1', 'u', t0 + 24 * mins)) THEN
    failed := array_append(failed, 'lockout: the lock does not end after 15 minutes'::text);
  END IF;

  FOR i IN 0..18 LOOP
    SELECT * INTO rc FROM public.edge_auth_fail('10.84.0.2', 'user' || i, t0 + i * interval '1 second');
    IF rc.locked THEN EXIT; END IF;
  END LOOP;
  n := n + 1;
  IF rc.locked THEN failed := array_append(failed, 'lockout: the ip locked before 20 failures'::text); END IF;
  SELECT * INTO rc FROM public.edge_auth_fail('10.84.0.2', 'user19', t0 + interval '19 seconds');
  n := n + 1;
  IF NOT rc.locked
     OR NOT (SELECT locked FROM public.edge_auth_lock_state('10.84.0.2', 'fresh', t0 + interval '19 seconds'))
     OR (SELECT locked FROM public.edge_auth_lock_state('10.84.0.3', 'fresh', t0 + interval '19 seconds')) THEN
    failed := array_append(failed, 'lockout: 20 failures across users did not lock exactly that ip'::text);
  END IF;

  FOR i IN 1..4 LOOP
    PERFORM public.edge_auth_fail('10.84.0.4', 'B', t0);
    PERFORM public.edge_auth_fail('10.84.0.4', 'A', t0);
  END LOOP;
  PERFORM public.edge_auth_success('10.84.0.4', 'A');
  n := n + 1;
  IF NOT (SELECT locked FROM public.edge_auth_fail('10.84.0.4', 'B', t0 + ms)) THEN
    failed := array_append(failed, 'lockout: A''s success cleared B''s failures'::text);
  END IF;
  n := n + 1;
  IF (SELECT locked FROM public.edge_auth_fail('10.84.0.4', 'A', t0 + 2 * ms)) THEN
    failed := array_append(failed, 'lockout: a success did not restart its pair''s count'::text);
  END IF;
  FOR i IN 1..10 LOOP
    PERFORM public.edge_auth_fail('10.84.0.4', 'x' || i, t0 + 3 * ms);
  END LOOP;
  n := n + 1;
  IF NOT (SELECT locked FROM public.edge_auth_lock_state('10.84.0.4', 'fresh', t0 + 3 * ms)) THEN
    failed := array_append(failed, 'lockout: cleared failures stopped counting toward the ip limit'::text);
  END IF;

  -- ---------- purge ----------
  INSERT INTO public.edge_seen_keys (key, confirmed, expires_at)
  VALUES ('msg:v-live', true, t0 + interval '30 days');
  PERFORM public.edge_purge(t0 + interval '2 days');
  n := n + 1;
  IF EXISTS (SELECT 1 FROM public.edge_seen_keys WHERE key IN ('msg:v1', 'msg:v2', 'msg:v3'))
     OR NOT EXISTS (SELECT 1 FROM public.edge_seen_keys WHERE key = 'msg:v-live') THEN
    failed := array_append(failed, 'purge: seen keys not purged by expiry'::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM public.edge_rate_events WHERE at <= t0 + interval '2 days' - interval '1 hour')
     OR NOT EXISTS (SELECT 1 FROM public.edge_rate_events WHERE key = 'v-clock')
     OR EXISTS (SELECT 1 FROM public.edge_auth_failures WHERE at <= t0 + interval '2 days' - interval '1 hour')
     OR EXISTS (SELECT 1 FROM public.edge_auth_locks WHERE locked_until <= t0 + interval '2 days') THEN
    failed := array_append(failed, 'purge: rate events, failures or locks not purged by age'::text);
  END IF;

  -- ---------- hardening ----------
  n := n + 1;
  IF (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
       AND relname IN ('edge_seen_keys', 'edge_rate_events', 'edge_auth_failures', 'edge_auth_locks')
       AND relrowsecurity) <> 4
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'edge\_%') THEN
    failed := array_append(failed, 'hardening: RLS off, or a policy exists, on an edge table'::text);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'edge\_%'
       AND 'search_path=""' = ANY (proconfig) AND NOT prosecdef) <> 8 THEN
    failed := array_append(failed, 'hardening: an edge function is not SECURITY INVOKER with search_path '''''::text);
  END IF;
  FOREACH role_ IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH obj IN ARRAY ARRAY['edge_seen_keys', 'edge_rate_events', 'edge_auth_failures', 'edge_auth_locks'] LOOP
      r := pg_temp.edge_try(role_, format('SELECT 1 FROM public.%I', obj));
      n := n + 1;
      IF r NOT LIKE 'ERROR 42501: permission denied for table%' THEN
        failed := array_append(failed, format('grants: %s SELECT %s: %s', role_, obj, r));
      END IF;
      r := pg_temp.edge_try(role_, format('INSERT INTO public.%I DEFAULT VALUES', obj));
      n := n + 1;
      IF r NOT LIKE 'ERROR 42501: permission denied for table%' THEN
        failed := array_append(failed, format('grants: %s INSERT %s: %s', role_, obj, r));
      END IF;
    END LOOP;
    FOREACH obj IN ARRAY ARRAY[
      $q$SELECT * FROM public.edge_rate_check('s', 'k', 1, 1000)$q$,
      $q$SELECT public.edge_replay_claim('k', 't', 60)$q$,
      $q$SELECT public.edge_replay_confirm('k', 't', 60)$q$,
      $q$SELECT public.edge_replay_release('k', 't')$q$,
      $q$SELECT * FROM public.edge_auth_fail('1.1.1.1', 'u')$q$,
      $q$SELECT public.edge_auth_success('1.1.1.1', 'u')$q$,
      $q$SELECT * FROM public.edge_auth_lock_state('1.1.1.1', 'u')$q$,
      $q$SELECT * FROM public.edge_purge()$q$] LOOP
      r := pg_temp.edge_try(role_, obj);
      n := n + 1;
      IF r NOT LIKE 'ERROR 42501: permission denied for function%' THEN
        failed := array_append(failed, format('grants: %s may run %s: %s', role_, obj, r));
      END IF;
    END LOOP;
  END LOOP;
  r := pg_temp.edge_try('service_role',
    $q$SELECT * FROM public.edge_rate_check('v-svc', 'k', 1, 1000); SELECT 1 FROM public.edge_seen_keys$q$);
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('grants: service_role refused: ' || r)::text); END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT084', MESSAGE = 'verify-edge-security rollback';
  EXCEPTION WHEN SQLSTATE 'ZT084' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'edge security verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'edge security verification passed (% checks)', n;
END
$verify$;
