-- Behavioural regression suite for migration 321: the in-chat AI
-- assistant's switch and usage mode.
--
-- Asserts: the switch is off by default (no row, and a fresh row is
-- off); an agent cannot turn it on (neither through the function nor by
-- writing the table); a team leader cannot either; an admin can, and
-- only for their ACTIVE account; a member of another workspace cannot
-- read it; a member of the same workspace can; anon cannot run the
-- setter; the usage log takes 'chat_assist' and keeps 290's list.
--
-- ONE statement on purpose (the pinned CLI rejects several); fixtures
-- are rolled back through a sentinel. Fixture emails: ca321-*.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000321001';
  u_admin  UUID := '00000000-0000-4000-8000-000000321002';
  u_agent  UUID := '00000000-0000-4000-8000-000000321003';
  u_leader UUID := '00000000-0000-4000-8000-000000321004';
  u_owner2 UUID := '00000000-0000-4000-8000-000000321005';
  a_acct UUID; b_acct UUID;
  r TEXT;
  n INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ca_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; c bigint;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        IF p_sql ILIKE 'select%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
          GET DIAGNOSTICS c = ROW_COUNT;
          v := c::text;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'null');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR: ' || SQLERRM;
      END;
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'ca321-owner@example.invalid'),
    (u_admin,  'ca321-admin@example.invalid'),
    (u_agent,  'ca321-agent@example.invalid'),
    (u_leader, 'ca321-leader@example.invalid'),
    (u_owner2, 'ca321-owner2@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_owner2;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_leader;

  -- ---------- off by default ----------
  IF EXISTS (SELECT 1 FROM inbox_assistant_settings WHERE account_id IN (a_acct, b_acct) AND enabled) THEN
    failed := failed || 'switch on by default'::text; END IF; n := n + 1;
  INSERT INTO inbox_assistant_settings (account_id) VALUES (b_acct);
  IF (SELECT enabled FROM inbox_assistant_settings WHERE account_id = b_acct) THEN
    failed := failed || 'a fresh row is on'::text; END IF; n := n + 1;
  DELETE FROM inbox_assistant_settings WHERE account_id = b_acct;

  -- ---------- a non-admin cannot turn it on ----------
  r := pg_temp.ca_try(u_agent, 'select public.inbox_assistant_set_enabled(true)::text');
  IF r NOT LIKE 'ERROR:%' OR EXISTS (SELECT 1 FROM inbox_assistant_settings WHERE account_id = a_acct AND enabled) THEN
    failed := failed || ('agent set the switch: ' || r); END IF; n := n + 1;
  r := pg_temp.ca_try(u_leader, 'select public.inbox_assistant_set_enabled(true)::text');
  IF r NOT LIKE 'ERROR:%' OR EXISTS (SELECT 1 FROM inbox_assistant_settings WHERE account_id = a_acct AND enabled) THEN
    failed := failed || ('team leader set the switch: ' || r); END IF; n := n + 1;
  r := pg_temp.ca_try(u_agent, 'insert into public.inbox_assistant_settings (account_id, enabled) values (''' || a_acct || ''', true)');
  IF r NOT LIKE 'ERROR:%' THEN failed := failed || ('agent inserted settings: ' || r); END IF; n := n + 1;
  r := pg_temp.ca_try(u_owner, 'insert into public.inbox_assistant_settings (account_id, enabled) values (''' || a_acct || ''', true)');
  IF r NOT LIKE 'ERROR:%' THEN failed := failed || ('owner wrote the table directly: ' || r); END IF; n := n + 1;

  -- ---------- an admin can, for their active account only ----------
  r := pg_temp.ca_try(u_admin, 'select (public.inbox_assistant_set_enabled(true))->>''enabled''');
  IF r <> 'true' OR NOT EXISTS (SELECT 1 FROM inbox_assistant_settings WHERE account_id = a_acct AND enabled
                                   AND updated_by = u_admin) THEN
    failed := failed || ('admin could not turn it on: ' || r); END IF; n := n + 1;
  IF EXISTS (SELECT 1 FROM inbox_assistant_settings WHERE account_id = b_acct) THEN
    failed := failed || 'admin wrote another account'::text; END IF; n := n + 1;

  -- An agent cannot turn it off again either.
  r := pg_temp.ca_try(u_agent, 'select public.inbox_assistant_set_enabled(false)::text');
  IF r NOT LIKE 'ERROR:%' OR NOT EXISTS (SELECT 1 FROM inbox_assistant_settings WHERE account_id = a_acct AND enabled) THEN
    failed := failed || ('agent turned it off: ' || r); END IF; n := n + 1;
  r := pg_temp.ca_try(u_agent, 'update public.inbox_assistant_settings set enabled = false');
  IF r NOT LIKE 'ERROR:%' AND r <> '0' THEN failed := failed || ('agent updated settings: ' || r); END IF; n := n + 1;

  -- ---------- who reads it ----------
  r := pg_temp.ca_try(u_agent, 'select enabled::text from public.inbox_assistant_settings where account_id = ''' || a_acct || '''');
  IF r <> 'true' THEN failed := failed || ('member cannot read the switch: ' || r); END IF; n := n + 1;
  r := pg_temp.ca_try(u_owner2, 'select count(*)::text from public.inbox_assistant_settings where account_id = ''' || a_acct || '''');
  IF r <> '0' THEN failed := failed || ('another workspace reads the switch: ' || r); END IF; n := n + 1;

  -- The owner turns it off again.
  r := pg_temp.ca_try(u_owner, 'select (public.inbox_assistant_set_enabled(false))->>''enabled''');
  IF r <> 'false' THEN failed := failed || ('owner could not turn it off: ' || r); END IF; n := n + 1;
  r := pg_temp.ca_try(u_owner, 'select public.inbox_assistant_set_enabled(null)::text');
  IF r NOT LIKE 'ERROR:%' THEN failed := failed || ('null accepted: ' || r); END IF; n := n + 1;

  -- ---------- grants ----------
  IF has_function_privilege('anon', 'public.inbox_assistant_set_enabled(boolean)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.inbox_assistant_settings', 'INSERT')
     OR has_table_privilege('authenticated', 'public.inbox_assistant_settings', 'UPDATE')
     OR has_table_privilege('anon', 'public.inbox_assistant_settings', 'SELECT') THEN
    failed := failed || 'grants'::text; END IF; n := n + 1;

  -- ---------- usage mode ----------
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'ai_usage_log_mode_check'))
       !~ 'auto_reply.*draft.*translate.*hr_agent.*kb_learn.*chat_assist'
     OR NOT (SELECT convalidated FROM pg_constraint WHERE conname = 'ai_usage_log_mode_check') THEN
    failed := failed || 'usage mode check'::text; END IF; n := n + 1;
  INSERT INTO ai_usage_log (account_id, conversation_id, mode, provider, model, prompt_tokens, completion_tokens, total_tokens)
  VALUES (a_acct, NULL, 'chat_assist', 'openai', 'gpt-4o-mini', 10, 5, 15);
  BEGIN
    INSERT INTO ai_usage_log (account_id, conversation_id, mode, provider, model, prompt_tokens, completion_tokens, total_tokens)
    VALUES (a_acct, NULL, 'chat_assist_x', 'openai', 'gpt-4o-mini', 10, 5, 15);
    failed := failed || 'usage mode accepts anything'::text;
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  n := n + 1;

  RAISE EXCEPTION 'CA_ROLLBACK';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'CA_ROLLBACK' THEN RAISE; END IF;
  END;

  IF n <> 17 THEN RAISE EXCEPTION 'verify-chat-assist: only % checks ran', n; END IF;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'verify-chat-assist failed: %', array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'verify-chat-assist: % checks passed', n;
END $verify$;
