-- Verifies migration 301: broadcast_stop (who, from which status, counts),
-- and that the write-ahead mark holds only while a campaign is sending.
-- Fixtures (cst-) are rolled back.
DO $$
DECLARE
  u uuid := gen_random_uuid();
  a uuid := gen_random_uuid();
  acct uuid;
  b uuid;
  s text;
  r uuid;
  got jsonb;
  n int;
  code text;
  mark constant text := 'May have been sent - WhatsApp did not confirm it so it is not sent again';
BEGIN
  BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      (u, 'cst-owner@verify.local', '{"full_name": "cst owner"}'::jsonb),
      (a, 'cst-agent@verify.local', '{"full_name": "cst agent"}'::jsonb);
    SELECT account_id INTO acct FROM public.profiles WHERE user_id = u LIMIT 1;
    UPDATE public.profiles SET account_id = acct, account_role = 'agent' WHERE user_id = a;
    INSERT INTO public.broadcasts (user_id, account_id, name, template_name, status)
    VALUES (u, acct, 'cst', 'cst', 'sending') RETURNING id INTO b;
    INSERT INTO public.broadcast_recipients (broadcast_id, status, error_message) VALUES
      (b, 'delivered', NULL), (b, 'sent', NULL), (b, 'failed', 'no'), (b, 'pending', mark);
    INSERT INTO public.broadcast_recipients (broadcast_id, status) VALUES (b, 'pending') RETURNING id INTO r;

    -- Sending: the mark is written.
    UPDATE public.broadcast_recipients SET error_message = mark WHERE id = r;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION '301: mark refused while sending'; END IF;
    UPDATE public.broadcast_recipients SET error_message = NULL WHERE id = r;

    -- An agent may not stop it.
    PERFORM set_config('request.jwt.claim.sub', a::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    code := NULL;
    BEGIN
      PERFORM public.broadcast_stop(b);
    EXCEPTION WHEN OTHERS THEN code := SQLSTATE;
    END;
    RESET ROLE;
    IF code IS DISTINCT FROM '42501' THEN RAISE EXCEPTION '301: agent stop gave %', code; END IF;

    -- The admin may.
    PERFORM set_config('request.jwt.claim.sub', u::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    got := public.broadcast_stop(b);
    code := NULL;
    BEGIN
      PERFORM public.broadcast_stop(b);
    EXCEPTION WHEN OTHERS THEN code := SQLSTATE;
    END;
    RESET ROLE;
    IF got <> '{"sent": 2, "remaining": 1}'::jsonb THEN RAISE EXCEPTION '301: counts %', got; END IF;
    IF code IS DISTINCT FROM '55000' THEN RAISE EXCEPTION '301: second stop gave %', code; END IF;
    SELECT status INTO s FROM public.broadcasts WHERE id = b;
    IF s <> 'stopped' THEN RAISE EXCEPTION '301: status %', s; END IF;

    -- Stopped: the mark is not written and the row stays pending...
    UPDATE public.broadcast_recipients SET error_message = mark WHERE id = r;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION '301: marked after a stop'; END IF;
    -- ...but the message already out is still recorded, either way.
    UPDATE public.broadcast_recipients SET status = 'failed', error_message = mark
     WHERE broadcast_id = b AND status = 'pending' AND error_message = mark;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION '301: the stamp after a send was held back'; END IF;

    -- Scheduled may be stopped; the rest may not.
    UPDATE public.broadcasts SET status = 'scheduled' WHERE id = b;
    PERFORM public.broadcast_stop(b);
    FOREACH s IN ARRAY ARRAY['draft', 'sent', 'failed'] LOOP
      UPDATE public.broadcasts SET status = s WHERE id = b;
      code := NULL;
      BEGIN
        PERFORM public.broadcast_stop(b);
      EXCEPTION WHEN OTHERS THEN code := SQLSTATE;
      END;
      IF code IS DISTINCT FROM '55000' THEN RAISE EXCEPTION '301: stop from % gave %', s, code; END IF;
    END LOOP;
    RAISE EXCEPTION 'cst-rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'cst-rollback' THEN RAISE; END IF;
  END;
END $$;
SELECT 'campaign stop ok' AS result;
