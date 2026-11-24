-- Migration 296: the home screen's figures.
-- A failed send is no outgoing message and answers nobody. Fixture prefix
-- hmf-; everything is rolled back. Read as a signed-in owner.

DO $verify$
DECLARE
  u UUID := gen_random_uuid();
  a UUID; cv UUID; ct UUID;
  -- A fixed Wednesday, so no pair crosses a day or a week.
  t0 CONSTANT TIMESTAMPTZ := '2031-01-08 12:00+00';
  since CONSTANT TIMESTAMPTZ := '2031-01-06 00:00+00';
  x TEXT;
  n INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.hmf_ok(p_ok boolean, p_what text) RETURNS text
    LANGUAGE sql AS $b$ SELECT CASE WHEN p_ok IS TRUE THEN NULL ELSE p_what END $b$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES (u, 'hmf-owner@example.test');
  INSERT INTO public.accounts (name, owner_user_id, default_currency)
  VALUES ('hmf-acct', u, 'AED') RETURNING id INTO a;
  UPDATE public.profiles SET account_id = a, account_role = 'owner' WHERE user_id = u;
  INSERT INTO public.contacts (account_id, user_id, phone, name)
  VALUES (a, u, '971500002960', 'hmf') RETURNING id INTO ct;
  INSERT INTO public.conversations (account_id, user_id, contact_id)
  VALUES (a, u, ct) RETURNING id INTO cv;

  -- ---------- 1. A failed send ----------
  -- Asked at 0; a person's send fails at 5, a bot's at 10; the reply that
  -- arrives is at 30. Asked again at 60; the only answer fails at 65.
  INSERT INTO public.messages (conversation_id, sender_type, sender_id, content_type, content_text, status, created_at) VALUES
    (cv, 'customer', NULL, 'text', 'q',    'delivered', t0),
    (cv, 'agent',    u,    'text', 'lost', 'failed',    t0 + interval '5 minutes'),
    (cv, 'bot',      NULL, 'text', 'lost', 'failed',    t0 + interval '10 minutes'),
    (cv, 'agent',    u,    'text', 'a',    'sent',      t0 + interval '30 minutes'),
    (cv, 'customer', NULL, 'text', 'q2',   'delivered', t0 + interval '60 minutes'),
    (cv, 'agent',    u,    'text', 'lost', 'failed',    t0 + interval '65 minutes');

  PERFORM set_config('request.jwt.claim.sub', u::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT string_agg(incoming || '/' || outgoing, ',') INTO x
    FROM public.dashboard_message_series(since, 'UTC');
  RESET ROLE;
  failed := array_append(failed, pg_temp.hmf_ok(x = '2/1', 'messages in/out, expected 2/1: ' || coalesce(x, 'none'))); n := n + 1;
  SET LOCAL ROLE authenticated;
  SELECT coalesce(sum(samples), 0) || '/' || round(coalesce(sum(total_minutes), 0)) INTO x
    FROM public.dashboard_response_time(since, 'UTC', since, since - interval '7 days');
  RESET ROLE;
  failed := array_append(failed, pg_temp.hmf_ok(x = '1/30', 'response samples/minutes, expected 1/30: ' || coalesce(x, 'none'))); n := n + 1;

  failed := array_append(failed, pg_temp.hmf_ok(
    NOT has_function_privilege('anon', 'public.dashboard_message_series(timestamptz,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.dashboard_response_time(timestamptz,text,timestamptz,timestamptz)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.dashboard_message_series(timestamptz,text)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.dashboard_response_time(timestamptz,text,timestamptz,timestamptz)', 'EXECUTE')
    AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                       AND proname LIKE 'dashboard\_%' AND prosecdef),
    'privileges and security')); n := n + 1;

  RAISE EXCEPTION 'HMF_ROLLBACK';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'HMF_ROLLBACK' THEN RAISE; END IF;
  END;

  failed := array_remove(failed, NULL);
  IF n < 3 THEN RAISE EXCEPTION 'verify-home-figures: only % checks ran', n; END IF;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'verify-home-figures: % of % failed: %', cardinality(failed), n, array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'verify-home-figures: % checks passed', n;
END $verify$;
