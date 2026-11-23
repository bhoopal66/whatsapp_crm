-- Behavioural regression suite for the webhook inbox (migration 264).
-- ONE statement on purpose (the pinned CLI rejects several); fixtures are
-- rolled back through a sentinel.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000264001';
  u_admin UUID := '00000000-0000-4000-8000-000000264002';
  u_agent UUID := '00000000-0000-4000-8000-000000264003';
  a_acct  UUID;
  c_num   UUID;
  ev      JSONB;
  r       RECORD;
  t       TEXT;
  v_id    UUID;
  v_dead  UUID;
  i       INT;
  n       INT := 0;
  failed  TEXT[] := '{}';
  waits   INT[] := ARRAY[1, 2, 5, 15, 60, 60, 60];
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.wi_ok(p_ok boolean, p_what text) RETURNS text
    LANGUAGE sql AS $b$ SELECT CASE WHEN p_ok IS TRUE THEN NULL ELSE p_what END $b$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'wi-owner@example.test'), (u_admin, 'wi-admin@example.test'),
    (u_agent, 'wi-agent@example.test');
  INSERT INTO public.accounts (name, owner_user_id) VALUES ('wi-acct', u_owner) RETURNING id INTO a_acct;
  UPDATE public.profiles SET account_id = a_acct, account_role = 'owner' WHERE user_id = u_owner;
  UPDATE public.profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE public.profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;
  INSERT INTO public.whatsapp_config (user_id, account_id, phone_number_id, access_token, provider, status)
  VALUES (u_owner, a_acct, 'wi-session', 'x', 'openwa', 'connected') RETURNING id INTO c_num;

  ev := jsonb_build_object('account_id', a_acct, 'channel', c_num, 'provider', 'openwa',
    'event_key', 'wi-1', 'kind', 'message', 'payload', jsonb_build_object('text', 'secret words'));

  -- record: new, then busy while leased, retaken once the lease lapsed
  SELECT * INTO r FROM public.webhook_inbox_record(jsonb_build_array(ev));
  v_id := r.id;
  failed := array_append(failed, pg_temp.wi_ok(r.state = 'new' AND r.attempt = 1, 'record new')); n := n + 1;
  SELECT * INTO r FROM public.webhook_inbox_record(jsonb_build_array(ev));
  failed := array_append(failed, pg_temp.wi_ok(r.state = 'busy' AND r.id = v_id, 'record busy')); n := n + 1;
  SELECT count(*) INTO i FROM public.webhook_inbox_claim(50);
  failed := array_append(failed, pg_temp.wi_ok(i = 0, 'claim respects the lease')); n := n + 1;
  UPDATE public.webhook_inbox SET claimed_at = now() - interval '6 minutes' WHERE id = v_id;
  SELECT * INTO r FROM public.webhook_inbox_record(jsonb_build_array(ev));
  failed := array_append(failed, pg_temp.wi_ok(r.state = 'retaken' AND r.attempt = 2, 'record retaken')); n := n + 1;

  -- a stale attempt cannot fail the row
  failed := array_append(failed, pg_temp.wi_ok(public.webhook_inbox_settle(v_id, 1, 'failed', 'x') IS NULL, 'stale failure refused')); n := n + 1;

  -- back-off, each step, then dead at the eighth attempt
  UPDATE public.webhook_inbox SET attempts = 1 WHERE id = v_id;
  FOR i IN 1..7 LOOP
    t := public.webhook_inbox_settle(v_id, i, 'failed', repeat('e', 300));
    SELECT * INTO r FROM public.webhook_inbox WHERE id = v_id;
    failed := array_append(failed, pg_temp.wi_ok(
      t = 'retry' AND r.claimed_at IS NULL AND length(r.last_error) = 200
      AND r.next_attempt_at = now() + make_interval(mins => waits[i]), 'back-off ' || i)); n := n + 1;
    failed := array_append(failed, pg_temp.wi_ok(
      NOT EXISTS (SELECT 1 FROM public.webhook_inbox_claim(50)), 'not due ' || i)); n := n + 1;
    UPDATE public.webhook_inbox SET next_attempt_at = now() WHERE id = v_id;
    SELECT * INTO r FROM public.webhook_inbox_claim(50);
    failed := array_append(failed, pg_temp.wi_ok(
      r.id = v_id AND r.attempt = i + 1 AND r.payload->>'text' = 'secret words', 'claimed ' || i)); n := n + 1;
  END LOOP;
  t := public.webhook_inbox_settle(v_id, 8, 'failed', 'x');
  failed := array_append(failed, pg_temp.wi_ok(t = 'dead', 'dead at 8')); n := n + 1;
  failed := array_append(failed, pg_temp.wi_ok(NOT EXISTS (SELECT 1 FROM public.webhook_inbox_claim(50)), 'dead not claimed')); n := n + 1;

  -- the bell: owner and admin, once, no customer text
  SELECT * INTO r FROM public.webhook_inbox_notify_dead() d WHERE d.account_id = a_acct;
  failed := array_append(failed, pg_temp.wi_ok(r.events = 1, 'notify one')); n := n + 1;
  PERFORM public.webhook_inbox_notify_dead();
  SELECT count(*) INTO i FROM public.notifications WHERE account_id = a_acct AND type = 'inbound_message_failed';
  failed := array_append(failed, pg_temp.wi_ok(i = 2, 'two bells, once')); n := n + 1;
  failed := array_append(failed, pg_temp.wi_ok(NOT EXISTS (
    SELECT 1 FROM public.notifications WHERE account_id = a_acct
       AND (user_id = u_agent OR title || coalesce(body, '') || coalesce(meta::text, '') LIKE '%secret words%')), 'bell recipients and text')); n := n + 1;
  failed := array_append(failed, pg_temp.wi_ok((public.webhook_inbox_stats()->>'dead')::int >= 1, 'stats dead')); n := n + 1;

  -- a dead event redelivered starts again, and done empties the payload
  SELECT * INTO r FROM public.webhook_inbox_record(jsonb_build_array(ev));
  failed := array_append(failed, pg_temp.wi_ok(r.state = 'retaken' AND r.attempt = 1, 'dead revived')); n := n + 1;
  t := public.webhook_inbox_settle(v_id, 1, 'done', NULL);
  SELECT * INTO r FROM public.webhook_inbox WHERE id = v_id;
  failed := array_append(failed, pg_temp.wi_ok(t = 'done' AND r.payload = '{}'::jsonb AND r.dead_at IS NULL, 'done empties')); n := n + 1;
  failed := array_append(failed, pg_temp.wi_ok(public.webhook_inbox_settle(v_id, 1, 'failed', 'x') IS NULL, 'done is final')); n := n + 1;
  SELECT * INTO r FROM public.webhook_inbox_record(jsonb_build_array(ev));
  failed := array_append(failed, pg_temp.wi_ok(r.state = 'done', 'redelivery of done')); n := n + 1;

  -- a receipt with no message: 30 s, 60 s, then done
  SELECT * INTO r FROM public.webhook_inbox_record(jsonb_build_array(ev || '{"event_key":"wi-2","kind":"status"}'));
  v_id := r.id;
  t := public.webhook_inbox_settle(v_id, 1, 'unmatched');
  SELECT * INTO r FROM public.webhook_inbox WHERE id = v_id;
  failed := array_append(failed, pg_temp.wi_ok(t = 'retry' AND r.next_attempt_at = now() + interval '30 seconds', 'unmatched 1')); n := n + 1;
  UPDATE public.webhook_inbox SET next_attempt_at = now() WHERE id = v_id;
  PERFORM public.webhook_inbox_claim(50);
  t := public.webhook_inbox_settle(v_id, 2, 'unmatched');
  SELECT * INTO r FROM public.webhook_inbox WHERE id = v_id;
  failed := array_append(failed, pg_temp.wi_ok(t = 'retry' AND r.next_attempt_at = now() + interval '60 seconds', 'unmatched 2')); n := n + 1;
  UPDATE public.webhook_inbox SET next_attempt_at = now() WHERE id = v_id;
  PERFORM public.webhook_inbox_claim(50);
  t := public.webhook_inbox_settle(v_id, 3, 'unmatched');
  failed := array_append(failed, pg_temp.wi_ok(t = 'done', 'unmatched 3 done')); n := n + 1;

  -- killed on the last attempt: a message is dead, a receipt is done
  INSERT INTO public.webhook_inbox (account_id, channel, provider, event_key, kind, payload, attempts, claimed_at)
  VALUES (a_acct, c_num, 'openwa', 'wi-3', 'message', '{}', 8, now() - interval '6 minutes') RETURNING id INTO v_dead;
  INSERT INTO public.webhook_inbox (account_id, channel, provider, event_key, kind, payload, attempts, claimed_at)
  VALUES (a_acct, c_num, 'openwa', 'wi-4', 'status', '{}', 8, now() - interval '6 minutes') RETURNING id INTO v_id;
  PERFORM public.webhook_inbox_claim(50);
  failed := array_append(failed, pg_temp.wi_ok((SELECT dead_at IS NOT NULL FROM public.webhook_inbox WHERE id = v_dead), 'killed message dead')); n := n + 1;
  failed := array_append(failed, pg_temp.wi_ok((SELECT done_at IS NOT NULL AND dead_at IS NULL FROM public.webhook_inbox WHERE id = v_id), 'killed receipt done')); n := n + 1;

  -- purge
  UPDATE public.webhook_inbox SET dead_at = now() - interval '15 days' WHERE id = v_dead;
  UPDATE public.webhook_inbox SET done_at = now() - interval '23 hours' WHERE id = v_id;
  PERFORM public.webhook_inbox_purge();
  failed := array_append(failed, pg_temp.wi_ok(NOT EXISTS (SELECT 1 FROM public.webhook_inbox WHERE id = v_dead), 'old dead purged')); n := n + 1;
  failed := array_append(failed, pg_temp.wi_ok(EXISTS (SELECT 1 FROM public.webhook_inbox WHERE id = v_id), 'recent done kept')); n := n + 1;
  UPDATE public.webhook_inbox SET done_at = now() - interval '25 hours' WHERE id = v_id;
  PERFORM public.webhook_inbox_purge();
  failed := array_append(failed, pg_temp.wi_ok(NOT EXISTS (SELECT 1 FROM public.webhook_inbox WHERE id = v_id), 'old done purged')); n := n + 1;

  -- another account's number is refused
  BEGIN
    PERFORM public.webhook_inbox_record(jsonb_build_array(
      ev || jsonb_build_object('event_key', 'wi-5', 'account_id', gen_random_uuid())));
    failed := array_append(failed, 'foreign account accepted');
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  n := n + 1;

  -- privileges: RLS on and forced, no policy, functions service role only
  failed := array_append(failed, pg_temp.wi_ok((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
    WHERE oid = 'public.webhook_inbox'::regclass), 'rls forced')); n := n + 1;
  failed := array_append(failed, pg_temp.wi_ok(NOT EXISTS (SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'webhook_inbox'), 'no policy')); n := n + 1;
  FOR r IN SELECT x FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) x LOOP
    failed := array_append(failed, pg_temp.wi_ok(
      NOT has_table_privilege(r.x, 'public.webhook_inbox', 'SELECT,INSERT,UPDATE,DELETE'), 'table grant ' || r.x)); n := n + 1;
  END LOOP;
  FOR r IN SELECT p.oid, p.proname, p.prosecdef, p.proconfig FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'webhook\_inbox\_%' LOOP
    failed := array_append(failed, pg_temp.wi_ok(
      r.prosecdef AND r.proconfig @> ARRAY['search_path=""']
      AND has_function_privilege('service_role', r.oid, 'EXECUTE')
      AND NOT has_function_privilege('anon', r.oid, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', r.oid, 'EXECUTE'), 'function ' || r.proname)); n := n + 1;
  END LOOP;

  RAISE EXCEPTION 'wi_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'wi_rollback' THEN RAISE; END IF;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'webhook inbox verification failed: % of %: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'webhook inbox verification passed (% checks)', n;
END
$verify$;
