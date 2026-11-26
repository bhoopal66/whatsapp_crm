-- Verifies migration 305: one row per (account, API key, key), the service
-- role only, gone with its message and its contact, and on a PDPL erase.
-- Fixtures (vmk-) are rolled back.
DO $$
DECLARE
  u uuid := gen_random_uuid();
  acct uuid;
  k uuid;
  k2 uuid;
  ct uuid;
  cv uuid;
  m uuid;
  n int;
  code text;
  who text;
  hash constant text := repeat('a', 64);
  got jsonb;
BEGIN
  BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      (u, 'vmk-owner@verify.local', '{"full_name": "vmk owner"}'::jsonb);
    SELECT account_id INTO acct FROM public.profiles WHERE user_id = u LIMIT 1;
    INSERT INTO public.api_keys (account_id, created_by, name, key_prefix, key_hash, scopes)
    VALUES (acct, u, 'vmk', 'vmk-1', 'vmk-hash-1', '{messages:send}') RETURNING id INTO k;
    INSERT INTO public.api_keys (account_id, created_by, name, key_prefix, key_hash, scopes)
    VALUES (acct, u, 'vmk', 'vmk-2', 'vmk-hash-2', '{messages:send}') RETURNING id INTO k2;
    INSERT INTO public.contacts (account_id, user_id, phone, name)
    VALUES (acct, u, '971500000305', 'vmk') RETURNING id INTO ct;
    INSERT INTO public.conversations (account_id, user_id, contact_id)
    VALUES (acct, u, ct) RETURNING id INTO cv;
    INSERT INTO public.messages (conversation_id, sender_type, content_type, content_text, status)
    VALUES (cv, 'agent', 'text', 'vmk', 'sent') RETURNING id INTO m;

    -- Clients: nothing. The service role: all it needs.
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.v1_message_keys'::regclass) THEN
      RAISE EXCEPTION '305: RLS is off';
    END IF;
    FOREACH who IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(who, 'public.v1_message_keys', 'SELECT,INSERT,UPDATE,DELETE') THEN
        RAISE EXCEPTION '305: % may touch v1_message_keys', who;
      END IF;
    END LOOP;
    FOREACH who IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', 'public.v1_message_keys', who) THEN
        RAISE EXCEPTION '305: the service role may not %', who;
      END IF;
    END LOOP;

    -- As the app: the claim, and the second request refused.
    SET LOCAL ROLE service_role;
    INSERT INTO public.v1_message_keys (account_id, api_key_id, key, request_hash, contact_id)
    VALUES (acct, k, 'vmk', hash, ct);
    BEGIN
      INSERT INTO public.v1_message_keys (account_id, api_key_id, key, request_hash)
      VALUES (acct, k, 'vmk', hash);
    EXCEPTION WHEN unique_violation THEN code := SQLSTATE;
    END;
    IF code IS DISTINCT FROM '23505' THEN RAISE EXCEPTION '305: a key was claimed twice'; END IF;
    -- Another API key has its own keys.
    INSERT INTO public.v1_message_keys (account_id, api_key_id, key, request_hash, contact_id, message_id, state, response)
    VALUES (acct, k2, 'vmk', hash, ct, m, 'sent', '{}');
    RESET ROLE;

    -- Values the app never writes.
    FOREACH who IN ARRAY ARRAY['sending', 'sent'] LOOP
      code := NULL;
      BEGIN
        UPDATE public.v1_message_keys SET state = who WHERE api_key_id = k;
      EXCEPTION WHEN check_violation THEN code := SQLSTATE;
      END;
      IF code IS NULL THEN RAISE EXCEPTION '305: state % without an answer was taken', who; END IF;
    END LOOP;

    -- Goes with its message.
    DELETE FROM public.messages WHERE id = m;
    SELECT count(*) INTO n FROM public.v1_message_keys WHERE account_id = acct;
    IF n <> 1 THEN RAISE EXCEPTION '305: % rows after the message went', n; END IF;

    -- The PDPL export names it and the erase takes it.
    IF NOT EXISTS (SELECT 1 FROM public.privacy_extensions
                    WHERE name = 'v1_message_keys' AND erase_fn = 'privacy_v1_message_keys_erase') THEN
      RAISE EXCEPTION '305: not registered in privacy_extensions';
    END IF;
    got := public.privacy_v1_message_keys_export(acct, ct);
    IF jsonb_array_length(got) <> 1 OR got->0->>'key' <> 'vmk' THEN RAISE EXCEPTION '305: export %', got; END IF;
    IF jsonb_array_length(public.privacy_v1_message_keys_export(gen_random_uuid(), ct)) <> 0 THEN
      RAISE EXCEPTION '305: export crosses accounts';
    END IF;
    got := public.privacy_v1_message_keys_erase(acct, ct);
    IF got->'counts'->>'v1_message_keys' <> '1' THEN RAISE EXCEPTION '305: erase %', got; END IF;

    -- Goes with its contact.
    INSERT INTO public.v1_message_keys (account_id, api_key_id, key, request_hash, contact_id)
    VALUES (acct, k, 'vmk', hash, ct);
    DELETE FROM public.contacts WHERE id = ct;
    SELECT count(*) INTO n FROM public.v1_message_keys WHERE account_id = acct;
    IF n <> 0 THEN RAISE EXCEPTION '305: % rows after the contact went', n; END IF;

    RAISE EXCEPTION 'vmk-rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'vmk-rollback' THEN RAISE; END IF;
  END;
END $$;
