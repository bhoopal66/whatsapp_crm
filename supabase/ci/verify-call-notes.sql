-- ============================================================
-- Migration 294: after a transfer, everyone who answered a leg of a call
-- (calls.meta.answered_user_ids) may see it and write its note, in their
-- active account; nobody else gains anything, a leader of one of them
-- included. And pbx_save_call_note: the same people, only the fields sent,
-- a note only over the text its writer last saw. And pbx_link_call_contact:
-- the same people, but only the call's person and a team leader move a
-- call off the contact it has. Leaves nothing behind (everything in one rolled-back block).
-- ============================================================
DO $verify$
DECLARE
  u_own uuid := gen_random_uuid();
  u_a uuid := gen_random_uuid();
  u_b uuid := gen_random_uuid();
  u_c uuid := gen_random_uuid();
  u_lead uuid := gen_random_uuid();
  u_view uuid := gen_random_uuid();
  u_x uuid := gen_random_uuid();
  a_acct uuid; a_x uuid; t_team uuid; k uuid; k_bad uuid; k_json text;
  failed text[] := '{}'; n int := 0; r text;
  what text; who uuid; want text; seen text;
  k_co uuid; k_co2 uuid; k_co_x uuid; k_int uuid; k_call uuid; k_was uuid; k_pick uuid;
  fields jsonb; stored text; by_now uuid; row_now text; said jsonb;
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pcn_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; st text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claims', '', true);
        PERFORM set_config('request.jwt.claim.sub', '', true);
        RETURN coalesce(nullif(v, ''), 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
        RESET ROLE;
        PERFORM set_config('request.jwt.claims', '', true);
        PERFORM set_config('request.jwt.claim.sub', '', true);
        RETURN st;
      END;
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_own, 'pcn-own@example.invalid'), (u_a, 'pcn-a@example.invalid'),
    (u_b, 'pcn-b@example.invalid'), (u_c, 'pcn-c@example.invalid'),
    (u_lead, 'pcn-lead@example.invalid'), (u_view, 'pcn-view@example.invalid'),
    (u_x, 'pcn-x@example.invalid');
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_own;
  SELECT id INTO a_x FROM accounts WHERE owner_user_id = u_x;
  IF a_acct IS NULL OR a_x IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_a, u_b, u_c);
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_view;
  INSERT INTO teams (account_id, name, leader_user_id)
  VALUES (a_acct, 'pcn-team', u_lead) RETURNING id INTO t_team;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t_team, u_b, a_acct);

  -- An outbound call of A's, transferred to B (and, wrongly, to a
  -- viewer's and an outsider's id): nobody rang by an inbound leg.
  INSERT INTO calls (account_id, pbx_call_id, direction, user_id, status, meta)
  VALUES (a_acct, 'pcn-1', 'outbound', u_a, 'answered',
          jsonb_build_object('answered_user_ids', jsonb_build_array(u_a, u_b, u_view, u_x)))
  RETURNING id INTO k;
  -- A malformed list (an object) opens nothing.
  INSERT INTO calls (account_id, pbx_call_id, direction, user_id, status, meta)
  VALUES (a_acct, 'pcn-2', 'outbound', u_a, 'answered',
          jsonb_build_object('answered_user_ids', jsonb_build_object(u_b::text, true)))
  RETURNING id INTO k_bad;
  SELECT to_jsonb(c)::text INTO k_json FROM calls c WHERE c.id = k;

  FOR what, who, want, seen IN VALUES
    ('the call''s person', u_a, 'ok', '1'),
    ('the one it was transferred to', u_b, 'ok', '1'),
    ('a colleague who did not answer', u_c, 'P0002', '0'),
    ('the leader of one who answered', u_lead, 'P0002', '0'),
    ('a viewer in the list', u_view, '42501', '1'),
    ('another account''s person in the list', u_x, 'P0002', '0')
  LOOP
    r := pg_temp.pcn_try(who, format('SELECT pbx_set_disposition(%L, ''call_back'', ''pcn note'')', k));
    n := n + 1;
    IF r <> want THEN failed := array_append(failed, format('%s saves: %s, not %s', what, r, want)); END IF;
    r := pg_temp.pcn_try(who, format('SELECT count(*) FROM calls WHERE id = %L', k));
    n := n + 1;
    IF r <> seen THEN failed := array_append(failed, format('%s sees: %s, not %s', what, r, seen)); END IF;
    -- The policy and the one-call function agree.
    r := pg_temp.pcn_try(who, format(
      'SELECT pbx_can_view_call(jsonb_populate_record(NULL::calls, %L::jsonb))::text', k_json));
    n := n + 1;
    IF r IS DISTINCT FROM (seen = '1')::text THEN
      failed := array_append(failed, format('%s: pbx_can_view_call says %s', what, r));
    END IF;
  END LOOP;
  -- pbx_save_call_note refuses and admits as pbx_set_disposition.
  FOR what, who, want IN VALUES
    ('the call''s person', u_a, 'ok'),
    ('the one it was transferred to', u_b, 'ok'),
    ('the owner', u_own, 'ok'),
    ('a colleague who did not answer', u_c, 'P0002'),
    ('the leader of one who answered', u_lead, 'P0002'),
    ('a viewer in the list', u_view, '42501'),
    ('another account''s person in the list', u_x, 'P0002')
  LOOP
    r := pg_temp.pcn_try(who, format(
      'SELECT pbx_save_call_note(%L, ''{"disposition": "interested"}'') ->> ''disposition''', k));
    n := n + 1;
    IF (CASE WHEN r = 'interested' THEN 'ok' ELSE r END) <> want THEN
      failed := array_append(failed, format('%s saves a note: %s, not %s', what, r, want));
    END IF;
  END LOOP;

  -- Each from a stored note of `stored` by `by_now` and an outcome of
  -- call_back: what the answer is, and what the row holds after.
  FOR what, who, stored, by_now, fields, want, row_now IN VALUES
    ('a note over the text seen', u_b, 'one', u_a,
     '{"notes": " two ", "notes_seen": "one"}'::jsonb, 'two', 'two|call_back|b'),
    ('a first note', u_b, NULL, NULL, '{"notes": "two", "notes_seen": null}', 'two', 'two|call_back|b'),
    ('a note over text never seen', u_b, 'one', u_a,
     '{"notes": "two", "notes_seen": null}', 'conflict:one', 'one|call_back|a'),
    ('a note over text changed since', u_b, 'three', u_a,
     '{"notes": "two", "notes_seen": "one"}', 'conflict:three', 'three|call_back|a'),
    ('over the writer''s own, changed since', u_b, 'three', u_b,
     '{"notes": "two", "notes_seen": "one"}', 'conflict:three', 'three|call_back|b'),
    ('a note someone cleared since', u_b, NULL, u_a,
     '{"notes": "two", "notes_seen": "one"}', 'conflict:', '|call_back|a'),
    ('the text already stored', u_b, 'two', u_a,
     '{"notes": "two ", "notes_seen": "one"}', 'two', 'two|call_back|a'),
    ('a conflict with an outcome', u_b, 'three', u_a,
     '{"notes": "two", "notes_seen": "one", "disposition": "interested"}', 'conflict:three', 'three|call_back|a'),
    ('both', u_b, 'one', u_a,
     '{"notes": "two", "notes_seen": "one", "disposition": null}', 'two', 'two||b'),
    ('clearing', u_b, 'one', u_a, '{"notes": null, "notes_seen": "one"}', '', '|call_back|b'),
    ('an outcome alone', u_b, 'one', u_a, '{"disposition": "interested"}', 'one', 'one|interested|a'),
    ('an old tab over a colleague''s', u_b, 'one', u_a, '{"notes": "two"}', 'conflict:one', 'one|call_back|a'),
    ('an old tab over its own', u_b, 'one', u_b, '{"notes": "two"}', 'two', 'two|call_back|b'),
    ('an old tab over an empty one', u_b, NULL, u_a, '{"notes": "two"}', 'two', 'two|call_back|b'),
    ('nothing', u_b, 'one', u_a, '{"notes_seen": "one"}', '22023', 'one|call_back|a'),
    ('not an object', u_b, 'one', u_a, '["notes"]', '22023', 'one|call_back|a'),
    ('a note that is not text', u_b, 'one', u_a, '{"notes": 5, "notes_seen": "one"}', '22023', 'one|call_back|a'),
    ('an unknown outcome', u_b, 'one', u_a, '{"disposition": "sold"}', '22023', 'one|call_back|a'),
    ('too long a note', u_b, 'one', u_a,
     jsonb_build_object('notes', repeat('x', 4001), 'notes_seen', 'one'), '22023', 'one|call_back|a')
  LOOP
    UPDATE calls SET notes = stored, disposition = 'call_back', notes_updated_by = by_now,
                     notes_updated_at = '2026-01-01T00:00:00Z' WHERE id = k;
    r := pg_temp.pcn_try(who, format('SELECT pbx_save_call_note(%L, %L)', k, fields));
    IF r LIKE '{%' THEN
      said := r::jsonb;
      r := CASE WHEN (said -> 'conflict') = 'true' THEN 'conflict:' ELSE '' END
           || COALESCE(said ->> 'notes', '');
    END IF;
    n := n + 1;
    IF r <> want THEN failed := array_append(failed, format('%s: answered %s, not %s', what, r, want)); END IF;
    SELECT format('%s|%s|%s', c.notes, c.disposition,
                  CASE c.notes_updated_by WHEN u_a THEN 'a' WHEN u_b THEN 'b' END) INTO r
      FROM calls c WHERE c.id = k;
    n := n + 1;
    IF r <> row_now THEN failed := array_append(failed, format('%s: stored %s, not %s', what, r, row_now)); END IF;
    -- The stamp moves with the note and only with it.
    n := n + 1;
    IF (SELECT (c.notes IS DISTINCT FROM stored)
               <> (c.notes_updated_at > '2026-01-02') FROM calls c WHERE c.id = k) THEN
      failed := array_append(failed, format('%s: the wrong stamp', what));
    END IF;
  END LOOP;
  -- Who may name the call's customer. Two contacts of everyone's here and
  -- one of the other account.
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_b, '971500294001', 'pcn one') RETURNING id INTO k_co;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_b, '971500294002', 'pcn two') RETURNING id INTO k_co2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_x, u_x, '971500294003', 'pcn other') RETURNING id INTO k_co_x;
  INSERT INTO calls (account_id, pbx_call_id, direction, user_id, status, meta)
  VALUES (a_acct, 'pcn-3', 'internal', u_a, 'answered',
          jsonb_build_object('answered_user_ids', jsonb_build_array(u_b)))
  RETURNING id INTO k_int;
  UPDATE contacts SET user_id = u_a WHERE id = k_co2;
  FOR what, who, k_call, k_was, k_pick, want IN VALUES
    ('the one it was transferred to, no contact yet', u_b, k, NULL::uuid, k_co, 'ok'),
    ('the same pick again', u_b, k, k_co, k_co, 'ok'),
    ('the one it was transferred to, over a contact', u_b, k, k_co2, k_co, '42501'),
    ('the call''s person, over a contact', u_a, k, k_co, k_co2, 'ok'),
    ('the owner, over a contact', u_own, k, k_co, k_co2, 'ok'),
    ('a viewer in the list', u_view, k, NULL, k_co, '42501'),
    ('a colleague who did not answer', u_c, k, NULL, k_co, 'P0002'),
    ('the leader of one who answered', u_lead, k, NULL, k_co, 'P0002'),
    ('another account''s person in the list', u_x, k, NULL, k_co_x, 'P0002'),
    ('a contact of another account', u_b, k, NULL, k_co_x, 'P0002'),
    ('a contact the caller cannot see', u_b, k, NULL, k_co2, 'P0002'),
    ('an internal call', u_b, k_int, NULL, k_co, '22023'),
    ('through a list that is an object', u_b, k_bad, NULL, k_co, 'P0002')
  LOOP
    UPDATE calls SET contact_id = k_was WHERE id = k_call;
    r := pg_temp.pcn_try(who, format('SELECT pbx_link_call_contact(%L, %L)', k_call, k_pick));
    n := n + 1;
    IF r <> want THEN failed := array_append(failed, format('%s links: %s, not %s', what, r, want)); END IF;
    n := n + 1;
    IF (SELECT c.contact_id FROM calls c WHERE c.id = k_call)
       IS DISTINCT FROM (CASE WHEN want = 'ok' THEN k_pick ELSE k_was END) THEN
      failed := array_append(failed, format('%s links: the wrong contact stored', what));
    END IF;
  END LOOP;
  UPDATE calls SET contact_id = NULL WHERE id = k;
  -- An erased call is an error, never a conflict.
  UPDATE calls SET erased_at = now(), recording_state = 'erased', disposition = NULL, notes = NULL WHERE id = k;
  r := pg_temp.pcn_try(u_a, format('SELECT pbx_save_call_note(%L, ''{"notes": "x"}'')', k));
  n := n + 1;
  IF r <> '55000' THEN failed := array_append(failed, ('a note on an erased call: ' || r)::text); END IF;
  r := pg_temp.pcn_try(u_own, format('SELECT pbx_link_call_contact(%L, %L)', k, k_co));
  n := n + 1;
  IF r <> '55000' THEN failed := array_append(failed, ('a contact on an erased call: ' || r)::text); END IF;
  r := pg_temp.pcn_try(u_b, format('SELECT pbx_save_call_note(%L, ''{"notes": "x"}'')', k_bad));
  n := n + 1;
  IF r <> 'P0002' THEN failed := array_append(failed, ('a note through a list that is an object: ' || r)::text); END IF;

  r := pg_temp.pcn_try(u_b, format('SELECT count(*) FROM calls WHERE id = %L', k_bad))
    || pg_temp.pcn_try(u_b, format('SELECT pbx_set_disposition(%L, NULL, ''x'')', k_bad));
  n := n + 1;
  IF r <> '0P0002' THEN failed := array_append(failed, ('a list that is an object opens the call: ' || r)::text); END IF;

  -- The list grants writing, so no session may write it.
  r := pg_temp.pcn_try(u_c, format(
    'UPDATE calls SET meta = jsonb_build_object(''answered_user_ids'', jsonb_build_array(%L)) WHERE id = %L RETURNING id', u_c, k));
  n := n + 1;
  IF (SELECT meta -> 'answered_user_ids' ? u_c::text FROM calls WHERE id = k)
     OR has_column_privilege('authenticated', 'public.calls', 'meta', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.calls', 'meta', 'INSERT') THEN
    failed := array_append(failed, ('a session can write calls.meta: ' || r)::text);
  END IF;
  n := n + 1;
  IF has_function_privilege('authenticated', 'public.pbx_answered_call(public.calls)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pbx_set_disposition(uuid, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pbx_can_view_call(public.calls)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pbx_save_call_note(uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pbx_link_call_contact(uuid, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pbx_link_call_contact(uuid, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pbx_save_call_note(uuid, jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pbx_set_disposition(uuid, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pbx_can_view_call(public.calls)', 'EXECUTE') THEN
    failed := array_append(failed, 'function grants'::text);
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT294', MESSAGE = 'verify-call-notes rollback';
  EXCEPTION WHEN SQLSTATE 'ZT294' THEN
    NULL;
  END;
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'call notes verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'call notes verification passed (% checks)', n;
END
$verify$;
