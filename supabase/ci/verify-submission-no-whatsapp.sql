-- Behavioural regression suite for submissions without a WhatsApp
-- group (migration 136).
--
-- A 'none' row (submission_groups.wa_mode) is the CRM's record of a
-- submission with no hosting number: inserted with channel_id NULL
-- (a number is refused), its mode frozen, never claimed for a create,
-- never sent into (sg_send_begin writes nothing), ended by sg_end like
-- any group. case_account_settings.submission_whatsapp_groups defaults
-- to false and is set only by an owner/admin through
-- case_settings_set_whatsapp_groups.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back by a sentinel exception; the results survive in plpgsql
-- variables.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000136001';
  u_admin UUID := '00000000-0000-4000-8000-000000136002';
  u_agent UUID := '00000000-0000-4000-8000-000000136003';
  a_acct  UUID;
  w1      UUID;
  c1      UUID;
  g0      UUID;
  tok     UUID;
  m1      BIGINT;
  b1      BOOLEAN;
  r       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.nw_try(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        IF p_sql ILIKE 'select%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'nw-owner@example.invalid'),
    (u_admin, 'nw-admin@example.invalid'),
    (u_agent, 'nw-agent@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'NW-136-A1', 'x', 'connected', true) RETURNING id INTO w1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500136001', 'NW one')
    RETURNING id INTO c1;

  -- ---------- insert ----------
  n := n + 1;
  r := pg_temp.nw_try(format(
    'SELECT group_id::text FROM sg_open(%L, ''NW-136-C'', %L, %L, NULL, NULL, ''[]'', NULL, ''none'')',
    a_acct, c1, w1));
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := failed || format('a ''none'' submission with a hosting number was accepted (%s)', r);
  END IF;
  n := n + 1;
  r := pg_temp.nw_try(format(
    'SELECT group_id::text FROM sg_open(%L, ''NW-136-G'', %L, NULL, NULL, NULL, ''[]'', NULL)', a_acct, c1));
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := failed || format('a ''group'' submission without a hosting number was accepted (%s)', r);
  END IF;
  n := n + 1;
  r := pg_temp.nw_try(format(
    'SELECT group_id::text FROM sg_open(%L, ''NW-136-K'', NULL, NULL, NULL, NULL, ''[]'', NULL, ''none'')', a_acct));
  IF r NOT LIKE 'ERROR 23502%' THEN
    failed := failed || format('a ''none'' submission without a contact was accepted (%s)', r);
  END IF;
  n := n + 1;
  r := pg_temp.nw_try(format(
    'SELECT group_id::text FROM sg_open(%L, ''NW-136-1'', %L, NULL, ''one'', NULL, %L::jsonb, NULL, ''none'')',
    a_acct, c1, jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent'))));
  IF r LIKE 'ERROR%' OR r = 'ok' THEN
    failed := failed || format('a ''none'' submission without a number was refused (%s)', r);
    RAISE EXCEPTION 'fixture: no ''none'' group (%)', r;
  END IF;
  g0 := r::uuid;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM submission_groups WHERE id = g0 AND wa_mode = 'none' AND channel_id IS NULL
                    AND status = 'ACTIVE' AND wa_group_id IS NULL) THEN
    failed := failed || 'the ''none'' row is not stored as ACTIVE, no number, wa_mode none'::text;
  END IF;
  -- Assigned first: a subquery in the same expression would read the
  -- snapshot taken before the call.
  SELECT group_id INTO tok FROM sg_open(a_acct, 'NW-136-2', c1, w1, NULL, NULL, '[]', NULL);
  n := n + 1;
  IF (SELECT wa_mode FROM submission_groups WHERE id = tok) IS DISTINCT FROM 'group' THEN
    failed := failed || 'sg_open without p_wa_mode did not default to ''group'''::text;
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'sg_open' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    failed := failed || 'sg_open has more than one signature'::text;
  END IF;
  n := n + 1;
  IF (SELECT group_id FROM sg_open(a_acct, 'NW-136-1', c1, w1, NULL, NULL, '[]', NULL, 'group')) IS DISTINCT FROM g0
     OR (SELECT wa_mode FROM submission_groups WHERE id = g0) <> 'none' THEN
    failed := failed || 'a repeat sg_open changed the existing row''s mode'::text;
  END IF;

  -- ---------- privileges: service_role only ----------
  FOREACH r IN ARRAY ARRAY[
    'public.case_settings_set_whatsapp_groups(uuid,uuid,boolean)',
    -- 141 added p_customer_name, 142 p_coordinator_phones
    'public.sg_open(uuid,text,uuid,uuid,text,text,jsonb,uuid,text,text,text[])'] LOOP
    n := n + 1;
    IF has_function_privilege('authenticated', r, 'EXECUTE') THEN
      failed := failed || format('authenticated may execute %s', r);
    END IF;
    n := n + 1;
    IF has_function_privilege('anon', r, 'EXECUTE') THEN
      failed := failed || format('anon may execute %s', r);
    END IF;
    n := n + 1;
    IF NOT has_function_privilege('service_role', r, 'EXECUTE') THEN
      failed := failed || format('service_role may not execute %s', r);
    END IF;
  END LOOP;

  -- ---------- direct writes that would break the mode ----------
  n := n + 1;
  BEGIN
    UPDATE submission_groups SET wa_mode = 'none' WHERE id = tok;
    failed := failed || 'a ''group'' row was flipped to wa_mode ''none'' by a direct UPDATE'::text;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  n := n + 1;
  BEGIN
    UPDATE submission_groups SET wa_group_id = '1203630000000001@g.us' WHERE id = g0;
    failed := failed || 'a ''none'' row took a wa_group_id by a direct UPDATE'::text;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  -- ---------- frozen mode, no WhatsApp group ever ----------
  n := n + 1;
  r := pg_temp.nw_try(format('UPDATE submission_groups SET wa_mode = ''group'' WHERE id = %L', g0));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('wa_mode changed after insert (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.nw_try(format(
    'UPDATE submission_groups SET wa_create_claim = gen_random_uuid(), wa_create_claimed_until = now() WHERE id = %L', g0));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('a ''none'' row took a create claim directly (%s)', r); END IF;
  tok := sg_claim_create(g0, 60000);
  n := n + 1;
  IF tok IS NOT NULL THEN failed := failed || 'sg_claim_create claimed a ''none'' row'::text; END IF;
  n := n + 1;
  IF (SELECT wa_create_claim FROM submission_groups WHERE id = g0) IS NOT NULL THEN
    failed := failed || 'sg_claim_create left a claim on a ''none'' row'::text;
  END IF;

  -- ---------- no send ----------
  m1 := sg_send_begin(g0, u_agent, 'hello', 'Agent (Agent): hello');
  n := n + 1;
  IF m1 IS NOT NULL THEN failed := failed || 'sg_send_begin accepted a send into a ''none'' row'::text; END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM submission_group_messages WHERE group_id = g0) THEN
    failed := failed || 'sg_send_begin wrote a message row for a ''none'' row'::text;
  END IF;

  -- ---------- end ----------
  b1 := sg_end(g0, 'final_status');
  n := n + 1;
  IF NOT b1 THEN failed := failed || 'sg_end did not end a ''none'' row'::text; END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM submission_groups WHERE id = g0 AND status = 'ENDED' AND ended_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM submission_group_access WHERE group_id = g0 AND removed_at IS NULL) THEN
    failed := failed || 'the ended ''none'' row is not ENDED with its list closed'::text;
  END IF;

  -- ---------- the per-account switch ----------
  n := n + 1;
  IF case_submission_whatsapp_groups(a_acct) IS DISTINCT FROM false THEN
    failed := failed || 'case_submission_whatsapp_groups does not default to false'::text;
  END IF;
  n := n + 1;
  r := pg_temp.nw_try(format('SELECT case_settings_set_whatsapp_groups(%L, %L, true)::text', u_agent, a_acct));
  IF r NOT LIKE 'ERROR 42501%NOT_ALLOWED%' THEN
    failed := failed || format('an agent changed submission_whatsapp_groups (%s)', r);
  END IF;
  n := n + 1;
  r := pg_temp.nw_try(format('SELECT case_settings_set_whatsapp_groups(%L, %L, NULL)::text', u_admin, a_acct));
  IF r NOT LIKE 'ERROR 23514%SETTING_INVALID%' THEN
    failed := failed || format('a NULL submission_whatsapp_groups was accepted (%s)', r);
  END IF;
  b1 := case_settings_set_whatsapp_groups(u_admin, a_acct, true);
  n := n + 1;
  IF NOT b1 OR case_submission_whatsapp_groups(a_acct) IS DISTINCT FROM true
     OR case_managed_externally(a_acct) IS DISTINCT FROM false THEN
    failed := failed || 'the admin''s submission_whatsapp_groups was not stored alone'::text;
  END IF;
  b1 := case_settings_set(u_owner, a_acct, true);
  n := n + 1;
  IF case_submission_whatsapp_groups(a_acct) IS DISTINCT FROM true THEN
    failed := failed || 'case_settings_set reset submission_whatsapp_groups'::text;
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT136', MESSAGE = 'verify-submission-no-whatsapp rollback';
  EXCEPTION WHEN SQLSTATE 'ZT136' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'submissions without WhatsApp verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'submissions without WhatsApp verification passed (% checks)', n;
END
$verify$;
