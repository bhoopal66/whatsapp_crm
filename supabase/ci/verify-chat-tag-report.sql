-- Behavioural regression suite for the chat tag report, its tag-change
-- log and per-person report access (migration 255).
--
-- The log is append-only, written by a trigger that never fails the
-- conversations write; only the owner grants access; the owner and a
-- live grantee read workspace-wide counts (even of chats they cannot
-- open); nobody else; aggregates only. ONE statement on purpose (the
-- pinned CLI rejects several); fixtures are rolled back through a
-- sentinel.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000255001';
  u_admin  UUID := '00000000-0000-4000-8000-000000255002';
  u_agent  UUID := '00000000-0000-4000-8000-000000255003';
  u_agent2 UUID := '00000000-0000-4000-8000-000000255004';
  u_other  UUID := '00000000-0000-4000-8000-000000255005';
  a_acct   UUID;
  b_acct   UUID;
  tag_int  UUID;
  tag_adcb UUID;
  tag_no   UUID;
  tag_hsbc UUID;
  c1 UUID; c2 UUID; c3 UUID;
  cv1 UUID; cv2 UUID; cv3 UUID;
  r        TEXT;
  j        JSONB;
  v_cnt    INT;
  n        INT := 0;
  failed   TEXT[] := '{}';
  v_from   TEXT := (now() - interval '7 days')::text;
  v_to     TEXT := (now() + interval '1 minute')::text;
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tr_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        EXECUTE p_sql INTO v;
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
    (u_owner,  'tr255-owner@example.invalid'),
    (u_admin,  'tr255-admin@example.invalid'),
    (u_agent,  'tr255-agent@example.invalid'),
    (u_agent2, 'tr255-agent2@example.invalid'),
    (u_other,  'tr255-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent2;

  INSERT INTO chat_tags (account_id, name, sub_tag_title) VALUES (a_acct, 'TR Interested', 'Bank') RETURNING id INTO tag_int;
  INSERT INTO chat_tags (account_id, parent_id, name) VALUES (a_acct, tag_int, 'TR ADCB') RETURNING id INTO tag_adcb;
  INSERT INTO chat_tags (account_id, parent_id, name) VALUES (a_acct, tag_int, 'TR HSBC') RETURNING id INTO tag_hsbc;
  INSERT INTO chat_tags (account_id, name) VALUES (a_acct, 'TR Not interested') RETURNING id INTO tag_no;

  INSERT INTO contacts (account_id, user_id, phone, name, lead_source) VALUES (a_acct, u_owner, '971500255001', 'TR one', 'ad') RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500255002', 'TR two') RETURNING id INTO c2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500255003', 'TR three') RETURNING id INTO c3;

  -- Owned by the owner, unassigned: an agent cannot open these chats.
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_owner, c1) RETURNING id INTO cv1;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_owner, c2) RETURNING id INTO cv2;
  -- Born tagged: the INSERT is logged too.
  INSERT INTO conversations (account_id, user_id, contact_id, chat_tag_id)
  VALUES (a_acct, u_owner, c3, tag_no) RETURNING id INTO cv3;

  UPDATE conversations SET chat_tag_id = tag_int, chat_sub_tag_id = tag_adcb WHERE id = cv1;
  UPDATE conversations SET chat_tag_id = tag_int WHERE id = cv2;
  UPDATE conversations SET chat_tag_id = tag_no WHERE id = cv2;
  -- A write that changes nothing about tags logs nothing.
  UPDATE conversations SET chat_tag_id = tag_no WHERE id = cv2;
  UPDATE conversations SET unread_count = 3 WHERE id = cv2;

  -- The log.
  SELECT count(*) INTO v_cnt FROM chat_tag_history WHERE conversation_id IN (cv1, cv2, cv3);
  n := n + 1;
  IF v_cnt <> 4 THEN failed := array_append(failed, 'the tag log did not hold 4 rows: ' || v_cnt); END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM chat_tag_history WHERE conversation_id = cv1 AND to_tag_id = tag_int AND to_sub_tag_id = tag_adcb AND from_tag_id IS NULL) THEN
    failed := array_append(failed, 'the main + sub-tag change was not logged as one row');
  END IF;
  n := n + 1;
  BEGIN
    UPDATE chat_tag_history SET to_tag_id = NULL WHERE conversation_id = cv1;
    failed := array_append(failed, 'the tag log accepted an UPDATE');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  n := n + 1;
  BEGIN
    DELETE FROM chat_tag_history WHERE conversation_id = cv1;
    failed := array_append(failed, 'the tag log accepted a DELETE');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    n := n + 1;
    IF has_table_privilege(r, 'public.chat_tag_history', 'SELECT')
       OR has_table_privilege(r, 'public.report_access', 'SELECT') THEN
      failed := array_append(failed, r || ' can read the tag log or report access directly');
    END IF;
  END LOOP;

  -- The trigger never fails the write: with the log made unwritable,
  -- tagging still succeeds.
  n := n + 1;
  BEGIN
    ALTER TABLE chat_tag_history ADD CONSTRAINT tr255_block CHECK (to_tag_id IS NULL) NOT VALID;
    UPDATE conversations SET chat_tag_id = tag_int WHERE id = cv3;
    IF NOT EXISTS (SELECT 1 FROM conversations WHERE id = cv3 AND chat_tag_id = tag_int) THEN
      failed := array_append(failed, 'a failing log write undid the tag change');
    END IF;
    ALTER TABLE chat_tag_history DROP CONSTRAINT tr255_block;
  EXCEPTION WHEN OTHERS THEN
    failed := array_append(failed, 'a failing log write failed the tag change: ' || SQLERRM);
  END;

  -- A sub-tag-only move (ADCB -> HSBC under the same main tag) is logged
  -- but is not a second arrival at the main tag.
  UPDATE conversations SET chat_sub_tag_id = tag_hsbc WHERE id = cv1;

  -- Access: owner yes; admin and agent no until granted.
  n := n + 1;
  r := pg_temp.tr_try(u_owner, format('SELECT chat_tag_report(%L, %L, %L)::text', v_from, v_to, 'Asia/Dubai'));
  IF r LIKE 'ERROR:%' THEN failed := array_append(failed, 'the owner could not open the tag report: ' || r); END IF;
  FOREACH r IN ARRAY ARRAY[u_admin::text, u_agent::text] LOOP
    n := n + 1;
    IF pg_temp.tr_try(r::uuid, format('SELECT chat_tag_report(%L, %L)::text', v_from, v_to)) NOT LIKE 'ERROR:%' THEN
      failed := array_append(failed, 'someone without a grant opened the tag report');
    END IF;
  END LOOP;

  -- Only the owner grants; an admin cannot, even to themselves.
  n := n + 1;
  IF pg_temp.tr_try(u_admin, format('SELECT report_access_set(%L, ARRAY[%L]::uuid[])::text', 'chat_tags', u_admin)) NOT LIKE 'ERROR:%' THEN
    failed := array_append(failed, 'an admin granted report access');
  END IF;
  n := n + 1;
  IF pg_temp.tr_try(u_admin, format('SELECT report_access_list(%L)::text', 'chat_tags')) NOT LIKE 'ERROR:%' THEN
    failed := array_append(failed, 'an admin listed report access');
  END IF;
  n := n + 1;
  IF pg_temp.tr_try(u_owner, format('SELECT report_access_set(%L, ARRAY[%L]::uuid[])::text', 'chat_tags', u_other)) NOT LIKE 'ERROR:%' THEN
    failed := array_append(failed, 'the owner granted someone from another workspace');
  END IF;
  n := n + 1;
  r := pg_temp.tr_try(u_owner, format('SELECT report_access_set(%L, ARRAY[%L]::uuid[])::text', 'chat_tags', u_agent));
  IF r <> '1' THEN failed := array_append(failed, 'the owner could not grant an agent: ' || r); END IF;
  n := n + 1;
  r := pg_temp.tr_try(u_owner, format('SELECT report_access_list(%L)::text', 'chat_tags'));
  IF r LIKE 'ERROR:%' OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(r::jsonb) e
        WHERE e->>'user_id' = u_agent::text AND (e->>'granted')::boolean) THEN
    failed := array_append(failed, 'the access list does not show the grant: ' || r);
  END IF;

  -- The grantee reads workspace-wide counts of chats they cannot open.
  n := n + 1;
  r := pg_temp.tr_try(u_agent, format('SELECT count(*)::text FROM conversations WHERE id IN (%L, %L)', cv1, cv2));
  IF r <> '0' THEN failed := array_append(failed, 'fixture: the agent can see the owner''s chats: ' || r); END IF;
  r := pg_temp.tr_try(u_agent, format('SELECT chat_tag_report(%L, %L, %L)::text', v_from, v_to, 'UTC'));
  n := n + 1;
  IF r LIKE 'ERROR:%' THEN
    failed := array_append(failed, 'a grantee could not open the tag report: ' || r);
  ELSE
    j := r::jsonb;
    n := n + 1;
    IF (SELECT sum((e->>'chats')::int) FROM jsonb_array_elements(j->'current') e WHERE (e->>'tag_id')::uuid = tag_int) <> 2 THEN
      failed := array_append(failed, 'current Interested count is not 2: ' || (j->'current')::text);
    END IF;
    n := n + 1;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'current') e
                    WHERE (e->>'tag_id')::uuid = tag_int AND (e->>'sub_tag_id')::uuid = tag_hsbc AND (e->>'chats')::int = 1) THEN
      failed := array_append(failed, 'the Interested · HSBC count is not 1');
    END IF;
    n := n + 1;
    IF (SELECT sum((e->>'chats')::int) FROM jsonb_array_elements(j->'arrivals') e WHERE (e->>'tag_id')::uuid = tag_int) <> 2 THEN
      failed := array_append(failed, 'a sub-tag-only move counted as an arrival: ' || (j->'arrivals')::text);
    END IF;
    n := n + 1;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'arrivals') e
                    WHERE (e->>'tag_id')::uuid = tag_int AND (e->>'sub_tag_id')::uuid = tag_hsbc AND (e->>'chats')::int = 1) THEN
      failed := array_append(failed, 'an arrival is not under the chat''s last sub-tag: ' || (j->'arrivals')::text);
    END IF;
    n := n + 1;
    IF (SELECT sum((e->>'chats')::int) FROM jsonb_array_elements(j->'arrivals') e WHERE (e->>'tag_id')::uuid = tag_no) <> 2 THEN
      failed := array_append(failed, 'arrivals at Not interested are not 2: ' || (j->'arrivals')::text);
    END IF;
    n := n + 1;
    IF j->>'history_since' IS NULL THEN failed := array_append(failed, 'history_since is missing'); END IF;
    n := n + 1;
    IF r ~ '971500255' OR r ~ 'TR one' THEN failed := array_append(failed, 'the report carries a phone number or a customer name'); END IF;
  END IF;

  -- A deactivated grantee loses it; another workspace never sees A's.
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_agent;
  n := n + 1;
  IF pg_temp.tr_try(u_agent, format('SELECT chat_tag_report(%L, %L)::text', v_from, v_to)) NOT LIKE 'ERROR:%' THEN
    failed := array_append(failed, 'a deactivated grantee still opened the tag report');
  END IF;
  UPDATE profiles SET deactivated_at = NULL WHERE user_id = u_agent;
  -- Since 330 deactivation keeps the grant: reactivating restores it
  -- (verify-report-access-reactivation.sql covers the rest).
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM report_access WHERE user_id = u_agent) THEN
    failed := array_append(failed, 'deactivation deleted the grantee''s report_access row');
  END IF;
  n := n + 1;
  IF pg_temp.tr_try(u_agent, format('SELECT chat_tag_report(%L, %L)::text', v_from, v_to)) LIKE 'ERROR:%' THEN
    failed := array_append(failed, 'a reactivated grantee did not get the tag report back');
  END IF;
  n := n + 1;
  r := pg_temp.tr_try(u_other, format('SELECT chat_tag_report(%L, %L)::text', v_from, v_to));
  IF r LIKE 'ERROR:%' OR r ~ 'TR Interested' THEN
    failed := array_append(failed, 'another workspace''s owner saw A''s tags or was refused: ' || r);
  END IF;
  n := n + 1;
  r := pg_temp.tr_try(u_agent2, 'SELECT report_my_access()::text');
  IF r <> '{}' THEN failed := array_append(failed, 'an ungranted agent has report keys: ' || r); END IF;
  n := n + 1;
  r := pg_temp.tr_try(u_owner, 'SELECT report_my_access()::text');
  IF r <> '{chat_tags}' THEN failed := array_append(failed, 'the owner lacks the chat_tags key: ' || r); END IF;

  -- Revoking empties the list.
  n := n + 1;
  r := pg_temp.tr_try(u_owner, format('SELECT report_access_set(%L, ARRAY[]::uuid[])::text', 'chat_tags'));
  IF r <> '0' THEN failed := array_append(failed, 'revoking did not empty the grants: ' || r); END IF;

  -- The log cascades with its conversation.
  DELETE FROM conversations WHERE id = cv3;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM chat_tag_history WHERE conversation_id = cv3) THEN
    failed := array_append(failed, 'a deleted chat left its tag log behind');
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT255', MESSAGE = 'verify-chat-tag-report rollback';
  EXCEPTION WHEN SQLSTATE 'ZT255' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'chat tag report verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'chat tag report verification passed (% checks)', n;
END
$verify$;
