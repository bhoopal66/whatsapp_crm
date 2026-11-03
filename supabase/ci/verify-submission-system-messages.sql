-- Behavioural regression suite for automatic messages in a submission
-- group (migration 170).
--
-- sg_send_begin_system writes a pending 'out' row with no sender
-- (system_kind welcome | status_update, system_key unique per group),
-- or answers {"refused": CODE}. A group ENDED by a final status
-- ('FINAL_STATUS:%' / 'CASE_%') keeps a close hold of sg_close_hold()
-- after ended_at, inside which status_update (never welcome, never a
-- staff send) may still be posted; sg_close_hold_until states the same
-- rule for the WhatsApp close. Staff rows keep 115's shape.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back by a sentinel exception; the results survive in plpgsql
-- variables.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000170001';
  a_acct  UUID;
  w1      UUID;
  c1      UUID;
  g0      UUID;
  g1      UUID;
  g2      UUID;
  g3      UUID;
  tok     UUID;
  m1      BIGINT;
  b1      BOOLEAN;
  j       JSONB;
  t1      TIMESTAMPTZ;
  r       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sm_try(p_sql text)
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
  INSERT INTO auth.users (id, email) VALUES (u_owner, 'sm-owner@example.invalid') ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'SM-170-A1', 'x', 'connected', true) RETURNING id INTO w1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500170001', 'SM one')
    RETURNING id INTO c1;
  SELECT group_id INTO g0 FROM sg_open(a_acct, 'SM-170-0', c1, NULL, NULL, NULL, '[]', NULL, 'none');
  SELECT group_id INTO g1 FROM sg_open(a_acct, 'SM-170-1', c1, w1, NULL, NULL, '[]', NULL);
  SELECT group_id INTO g2 FROM sg_open(a_acct, 'SM-170-2', c1, w1, NULL, NULL, '[]', NULL);
  SELECT group_id INTO g3 FROM sg_open(a_acct, 'SM-170-3', c1, w1, NULL, NULL, '[]', NULL);
  IF g0 IS NULL OR g1 IS NULL OR g2 IS NULL OR g3 IS NULL THEN
    RAISE EXCEPTION 'fixture: sg_open returned no group';
  END IF;

  -- ---------- before the WhatsApp group exists ----------
  j := sg_send_begin_system(g1, 'welcome', 'welcome', 'Welcome');
  n := n + 1;
  IF j->>'refused' IS DISTINCT FROM 'GROUP_NOT_READY' THEN
    failed := failed || format('a welcome before wa_group_id was not GROUP_NOT_READY (%s)', j);
  END IF;
  tok := sg_claim_create(g1, 60000);
  b1 := sg_attach_wa_group(g1, '120363000000170001@g.us', NULL, tok);
  tok := sg_claim_create(g2, 60000);
  b1 := sg_attach_wa_group(g2, '120363000000170002@g.us', NULL, tok);
  tok := sg_claim_create(g3, 60000);
  b1 := sg_attach_wa_group(g3, '120363000000170003@g.us', NULL, tok);
  IF EXISTS (SELECT 1 FROM submission_groups WHERE id IN (g1, g2, g3) AND wa_group_id IS NULL) THEN
    RAISE EXCEPTION 'fixture: a WhatsApp group was not attached';
  END IF;

  -- ---------- welcome, once ----------
  j := sg_send_begin_system(g1, 'welcome', 'welcome', 'Welcome to your submission group');
  m1 := (j->>'id')::bigint;
  n := n + 1;
  IF m1 IS NULL OR j ? 'refused' THEN
    failed := failed || format('the welcome did not begin (%s)', j);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM submission_group_messages
                  WHERE id = m1 AND group_id = g1 AND direction = 'out' AND sender_user_id IS NULL
                    AND system_kind = 'welcome' AND system_key = 'welcome' AND send_status = 'pending'
                    AND body = 'Welcome to your submission group' AND prefixed_body = body
                    AND NOT post_end) THEN
    failed := failed || 'the welcome row does not have the system shape'::text;
  END IF;
  j := sg_send_begin_system(g1, 'welcome', 'welcome', 'Welcome again');
  n := n + 1;
  IF j->>'refused' IS DISTINCT FROM 'DUPLICATE' OR (j->>'id')::bigint IS DISTINCT FROM m1
     OR j->>'send_status' IS DISTINCT FROM 'pending' THEN
    failed := failed || format('a second welcome was not DUPLICATE of the first (%s)', j);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM submission_group_messages WHERE group_id = g1) <> 1 THEN
    failed := failed || 'a duplicate welcome wrote a row'::text;
  END IF;
  b1 := sg_settle_send(m1, 'sent', 'WA-170-W1');
  n := n + 1;
  IF NOT b1 OR (SELECT send_status FROM submission_group_messages WHERE id = m1) <> 'sent' THEN
    failed := failed || 'sg_settle_send did not settle a system row'::text;
  END IF;

  -- ---------- bad input ----------
  FOREACH r IN ARRAY ARRAY[
    format('SELECT sg_send_begin_system(%L, ''other'', ''k1'', ''x'')->>''refused''', g1),
    format('SELECT sg_send_begin_system(%L, ''status_update'', %L, ''x'')->>''refused''', g1, E' \t\n'),
    format('SELECT sg_send_begin_system(%L, ''status_update'', ''k1'', %L)->>''refused''', g1, E'\t '),
    format('SELECT sg_send_begin_system(%L, ''status_update'', %L, ''x'')->>''refused''', g1, repeat('k', 241))] LOOP
    n := n + 1;
    IF pg_temp.sm_try(r) IS DISTINCT FROM 'BAD_INPUT' THEN
      failed := failed || format('not BAD_INPUT: %s -> %s', r, pg_temp.sm_try(r));
    END IF;
  END LOOP;
  j := sg_send_begin_system(gen_random_uuid(), 'status_update', 'k1', 'x');
  n := n + 1;
  IF j->>'refused' IS DISTINCT FROM 'NOT_FOUND' THEN
    failed := failed || format('an unknown group was not NOT_FOUND (%s)', j);
  END IF;
  j := sg_send_begin_system(g0, 'welcome', 'welcome', 'Welcome');
  n := n + 1;
  IF j->>'refused' IS DISTINCT FROM 'NO_WHATSAPP_GROUP' THEN
    failed := failed || format('a ''none'' group was not NO_WHATSAPP_GROUP (%s)', j);
  END IF;

  -- ---------- status_update on an ACTIVE group ----------
  j := sg_send_begin_system(g1, 'status_update', 'sub-1:submitted', 'Submitted to the bank');
  n := n + 1;
  IF (j->>'id') IS NULL OR j ? 'refused' THEN
    failed := failed || format('a status_update on an ACTIVE group did not begin (%s)', j);
  END IF;
  n := n + 1;
  IF sg_close_hold_until(g1) IS NOT NULL THEN
    failed := failed || 'an ACTIVE group has a close hold'::text;
  END IF;

  -- ---------- the close hold after a final status ----------
  b1 := sg_end(g1, 'FINAL_STATUS:APPROVED');
  SELECT ended_at INTO t1 FROM submission_groups WHERE id = g1;
  n := n + 1;
  IF NOT b1 OR sg_close_hold_until(g1) IS DISTINCT FROM t1 + interval '2 days' THEN
    failed := failed || format('sg_close_hold_until after FINAL_STATUS is %s, not ended_at + 2 days', sg_close_hold_until(g1));
  END IF;
  n := n + 1;
  IF sg_close_hold() IS DISTINCT FROM interval '2 days' THEN
    failed := failed || 'sg_close_hold() is not 2 days'::text;
  END IF;
  j := sg_send_begin_system(g1, 'status_update', 'sub-1:approved', 'Approved');
  n := n + 1;
  IF (j->>'id') IS NULL OR j ? 'refused' THEN
    failed := failed || format('a status_update inside the close hold did not begin (%s)', j);
  END IF;
  j := sg_send_begin_system(g1, 'welcome', 'welcome-2', 'Welcome');
  n := n + 1;
  IF j->>'refused' IS DISTINCT FROM 'ENDED' THEN
    failed := failed || format('a welcome on an ENDED group was not ENDED (%s)', j);
  END IF;
  j := sg_send_begin_system(g1, 'welcome', 'welcome', 'Welcome');
  n := n + 1;
  IF j->>'refused' IS DISTINCT FROM 'DUPLICATE' OR (j->>'id')::bigint IS DISTINCT FROM m1
     OR j->>'send_status' IS DISTINCT FROM 'sent' THEN
    failed := failed || format('a repeated welcome after the end was not DUPLICATE/sent (%s)', j);
  END IF;
  n := n + 1;
  r := pg_temp.sm_try(format(
    'INSERT INTO submission_group_messages (group_id, account_id, direction, sender_user_id, body, prefixed_body, send_status)
     VALUES (%L, %L, ''out'', %L, ''hi'', ''Owner: hi'', ''pending'')', g1, a_acct, u_owner));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := failed || format('a staff row went into a group in its close hold (%s)', r);
  END IF;

  -- CASE_% ends hold too.
  b1 := sg_end(g3, 'CASE_DECLINED');
  n := n + 1;
  IF sg_close_hold_until(g3) IS NULL THEN
    failed := failed || 'a CASE_ end has no close hold'::text;
  END IF;

  -- ---------- past the hold ----------
  ALTER TABLE submission_groups DISABLE TRIGGER submission_groups_guard;
  ALTER TABLE submission_groups DISABLE TRIGGER submission_groups_archived_guard;
  UPDATE submission_groups SET ended_at = ended_at - interval '3 days' WHERE id = g1;
  ALTER TABLE submission_groups ENABLE TRIGGER submission_groups_archived_guard;
  ALTER TABLE submission_groups ENABLE TRIGGER submission_groups_guard;
  j := sg_send_begin_system(g1, 'status_update', 'sub-1:late', 'Late');
  n := n + 1;
  IF j->>'refused' IS DISTINCT FROM 'ENDED' THEN
    failed := failed || format('a status_update after the close hold was not ENDED (%s)', j);
  END IF;
  n := n + 1;
  IF NOT (sg_close_hold_until(g1) < now()) THEN
    failed := failed || 'sg_close_hold_until is not past now() once the hold is over'::text;
  END IF;
  n := n + 1;
  r := pg_temp.sm_try(format(
    'INSERT INTO submission_group_messages (group_id, account_id, direction, body, prefixed_body, send_status, system_kind, system_key)
     VALUES (%L, %L, ''out'', ''x'', ''x'', ''pending'', ''status_update'', ''direct-late'')', g1, a_acct));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := failed || format('the insert guard let a status_update in after the hold (%s)', r);
  END IF;

  -- ---------- a manual end: no hold ----------
  b1 := sg_end(g2, 'MANUAL');
  j := sg_send_begin_system(g2, 'status_update', 'sub-2:approved', 'Approved');
  n := n + 1;
  IF j->>'refused' IS DISTINCT FROM 'ENDED' THEN
    failed := failed || format('a status_update after a MANUAL end was not ENDED (%s)', j);
  END IF;
  n := n + 1;
  r := pg_temp.sm_try(format(
    'INSERT INTO submission_group_messages (group_id, account_id, direction, body, prefixed_body, send_status, system_kind, system_key)
     VALUES (%L, %L, ''out'', ''x'', ''x'', ''pending'', ''status_update'', ''direct-manual'')', g2, a_acct));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := failed || format('the insert guard let a status_update in after a MANUAL end (%s)', r);
  END IF;
  n := n + 1;
  IF sg_close_hold_until(g2) IS NOT NULL THEN
    failed := failed || 'a MANUAL end has a close hold'::text;
  END IF;
  n := n + 1;
  IF sg_close_hold_until(gen_random_uuid()) IS NOT NULL THEN
    failed := failed || 'an unknown group has a close hold'::text;
  END IF;

  -- ---------- row shape ----------
  SELECT group_id INTO g2 FROM sg_open(a_acct, 'SM-170-4', c1, w1, NULL, NULL, '[]', NULL);
  n := n + 1;
  r := pg_temp.sm_try(format(
    'INSERT INTO submission_group_messages (group_id, account_id, direction, body, prefixed_body, send_status)
     VALUES (%L, %L, ''out'', ''hi'', ''hi'', ''pending'')', g2, a_acct));
  IF r NOT LIKE 'ERROR 23514%out_attributed%' THEN
    failed := failed || format('a staff out row with no sender was accepted (%s)', r);
  END IF;
  n := n + 1;
  r := pg_temp.sm_try(format(
    'INSERT INTO submission_group_messages (group_id, account_id, direction, sender_user_id, body, prefixed_body, send_status, system_kind, system_key)
     VALUES (%L, %L, ''out'', %L, ''hi'', ''hi'', ''pending'', ''welcome'', ''w'')', g2, a_acct, u_owner));
  IF r NOT LIKE 'ERROR 23514%out_attributed%' THEN
    failed := failed || format('a system row with a sender was accepted (%s)', r);
  END IF;
  n := n + 1;
  r := pg_temp.sm_try(format(
    'INSERT INTO submission_group_messages (group_id, account_id, direction, sender_kind, wa_message_id, body, system_kind, system_key)
     VALUES (%L, %L, ''in'', ''customer'', ''WA-170-IN'', ''hi'', ''welcome'', ''w'')', g2, a_acct));
  IF r NOT LIKE 'ERROR 23514%system_check%' THEN
    failed := failed || format('an inbound row with a system kind was accepted (%s)', r);
  END IF;

  -- ---------- privileges: service_role only ----------
  FOREACH r IN ARRAY ARRAY[
    'public.sg_send_begin_system(uuid,text,text,text)',
    'public.sg_close_hold_until(uuid)'] LOOP
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

  RAISE EXCEPTION USING ERRCODE = 'ZT170', MESSAGE = 'verify-submission-system-messages rollback';
  EXCEPTION WHEN SQLSTATE 'ZT170' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'submission system messages verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'submission system messages verification passed (% checks)', n;
END
$verify$;
