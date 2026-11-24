-- Verifies migration 292: why a message failed is kept on the message, is
-- filled in from the cost ledger for failures already there (same account,
-- still failed, no reason yet), and is never written by a session. Runs as
-- a superuser; fixtures (mfr-) are rolled back.
DO $verify$
DECLARE
  u uuid := gen_random_uuid();
  u2 uuid := gen_random_uuid();
  acct uuid; acct2 uuid;
  c uuid; c2 uuid; cv uuid; cv2 uuid;
  n integer; got text; r record;
BEGIN
  BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      (u,  'mfr-owner@verify.local', '{"full_name": "mfr owner"}'::jsonb),
      (u2, 'mfr-other@verify.local', '{"full_name": "mfr other"}'::jsonb);
    SELECT account_id INTO acct  FROM public.profiles WHERE user_id = u  LIMIT 1;
    SELECT account_id INTO acct2 FROM public.profiles WHERE user_id = u2 LIMIT 1;
    IF acct IS NULL OR acct2 IS NULL THEN RAISE EXCEPTION '292: no fixture account'; END IF;

    INSERT INTO public.contacts (account_id, user_id, phone, name)
      VALUES (acct, u, '+971500029201', 'mfr one') RETURNING id INTO c;
    INSERT INTO public.contacts (account_id, user_id, phone, name)
      VALUES (acct2, u2, '+971500029202', 'mfr two') RETURNING id INTO c2;
    INSERT INTO public.conversations (account_id, user_id, contact_id)
      VALUES (acct, u, c) RETURNING id INTO cv;
    INSERT INTO public.conversations (account_id, user_id, contact_id)
      VALUES (acct2, u2, c2) RETURNING id INTO cv2;

    INSERT INTO public.messages
      (conversation_id, sender_type, sender_id, content_type, content_text, message_id, status, failure_reason)
    VALUES
      (cv,  'agent', u,  'template', 'mfr', 'mfr-paid',   'failed',    NULL),
      (cv,  'agent', u,  'text',     'mfr', 'mfr-words',  'failed',    NULL),
      (cv,  'agent', u,  'text',     'mfr', 'mfr-latest', 'failed',    NULL),
      (cv,  'agent', u,  'text',     'mfr', 'mfr-kept',   'failed',    'mfr kept'),
      (cv,  'agent', u,  'text',     'mfr', 'mfr-ok',     'delivered', NULL),
      (cv,  'agent', u,  'text',     'mfr', 'mfr-old',    'failed',    NULL),
      (cv2, 'agent', u2, 'text',     'mfr', 'mfr-paid',   'failed',    NULL);

    INSERT INTO public.whatsapp_message_costs
      (account_id, phone_number_id, message_id, status, recipient_wa_id,
       recipient_market, billable, raw_status, created_at)
    VALUES
      (acct, 'mfr', 'mfr-paid',   'failed', '971500029201', 'AE', false, '{"errors":[{"code":131042,"title":"x"}]}', now()),
      (acct, 'mfr', 'mfr-words',  'failed', '971500029201', 'AE', false, '{"errors":[{"code":131000,"title":"Something went wrong"}]}', now()),
      (acct, 'mfr', 'mfr-latest', 'failed', '971500029201', 'AE', false, '{"errors":[{"code":131026,"title":"x"}]}', now() - interval '1 hour'),
      (acct, 'mfr', 'mfr-kept',   'failed', '971500029201', 'AE', false, '{"errors":[{"code":131042,"title":"x"}]}', now()),
      (acct, 'mfr', 'mfr-ok',     'failed', '971500029201', 'AE', false, '{"errors":[{"code":131042,"title":"x"}]}', now()),
      (acct, 'mfr', 'mfr-old',    'failed', '971500029201', 'AE', false, '{"errors":[{"code":131042,"title":"x"}]}', now() - interval '90 days');

    n := public.backfill_message_failure_reasons();
    IF n < 3 THEN RAISE EXCEPTION '292: only % rows got a reason', n; END IF;
    FOR r IN SELECT * FROM (VALUES
        (cv,  'mfr-paid',   'Meta could not charge for this message.%(Meta 131042)'),
        (cv,  'mfr-words',  'Meta 131000: Something went wrong'),
        (cv,  'mfr-latest', 'Undeliverable:%'),
        (cv,  'mfr-kept',   'mfr kept'),
        (cv,  'mfr-ok',     '-'),
        (cv,  'mfr-old',    '-'),
        (cv2, 'mfr-paid',   '-')) v(conv, m, want)
    LOOP
      SELECT coalesce(failure_reason, '-') INTO got
        FROM public.messages WHERE conversation_id = r.conv AND message_id = r.m;
      IF got NOT LIKE r.want THEN
        RAISE EXCEPTION '292: % reads %, expected %', r.m, got, r.want;
      END IF;
    END LOOP;
    IF public.backfill_message_failure_reasons() <> 0 THEN
      RAISE EXCEPTION '292: the second run changed something';
    END IF;

    -- The column is short.
    BEGIN
      UPDATE public.messages SET failure_reason = repeat('x', 301)
       WHERE conversation_id = cv AND message_id = 'mfr-paid';
      RAISE EXCEPTION '292: a reason of 301 characters was taken';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- A session records its own message, and never a reason with it.
    PERFORM set_config('request.jwt.claim.sub', u::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', u, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.messages (conversation_id, sender_type, sender_id, content_type, content_text, message_id, status)
      VALUES (cv, 'agent', u, 'text', 'mfr', 'mfr-mine', 'sent');
    BEGIN
      INSERT INTO public.messages (conversation_id, sender_type, sender_id, content_type, content_text, message_id, status, failure_reason)
        VALUES (cv, 'agent', u, 'text', 'mfr', 'mfr-forged', 'sent', 'mfr');
      RAISE EXCEPTION '292: a session wrote a reason' USING ERRCODE = 'P0098';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.backfill_message_failure_reasons();
      RAISE EXCEPTION '292: a session ran the backfill' USING ERRCODE = 'P0098';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    RAISE EXCEPTION 'mfr rollback' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE 'verify-message-failure-reason: ok';
END $verify$;
