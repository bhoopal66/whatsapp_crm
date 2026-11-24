-- verify-team-and-row-rules.sql — migration 286, by role. Everything is
-- rolled back. Fixture prefix: rowrules286-.

DO $verify$
DECLARE
  u_own UUID := '00000000-0000-4000-8000-000000286001';
  u_a   UUID := '00000000-0000-4000-8000-000000286002'; -- in the leader's team
  u_b   UUID := '00000000-0000-4000-8000-000000286003'; -- in no team
  u_l   UUID := '00000000-0000-4000-8000-000000286004'; -- leads T; owns B
  u_g   UUID := '00000000-0000-4000-8000-000000286005'; -- bank guest
  acct UUID; b UUID; t UUID; ca UUID; cb UUID; va UUID; vb UUID; va2 UUID;
  ma UUID; pl UUID; st UUID; pl2 UUID; st2 UUID; na UUID; d UUID; un UUID;
  tb UUID; cfga UUID; ca2 UUID; bc UUID; i RECORD; f RECORD; r TEXT; cnt INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.rr_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; c bigint;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        IF p_sql ILIKE 'select%' THEN EXECUTE p_sql INTO v;
        ELSE EXECUTE p_sql; GET DIAGNOSTICS c = ROW_COUNT; v := c::text; END IF;
        RESET ROLE;
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE; v := SQLSTATE;
      END;
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claims', '', true);
      RETURN coalesce(v, 'null');
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_own, 'rowrules286-own@example.invalid'), (u_a, 'rowrules286-a@example.invalid'),
    (u_b, 'rowrules286-b@example.invalid'), (u_l, 'rowrules286-l@example.invalid'),
    (u_g, 'rowrules286-g@example.invalid');
  SELECT id INTO acct FROM accounts WHERE owner_user_id = u_own;
  SELECT id INTO b FROM accounts WHERE owner_user_id = u_l;
  UPDATE profiles SET account_id = acct, account_role = 'agent' WHERE user_id IN (u_a, u_b);
  UPDATE profiles SET account_id = acct, account_role = 'team_leader' WHERE user_id = u_l;
  UPDATE profiles SET account_id = acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_g;
  INSERT INTO profiles (user_id, account_id, account_role, full_name, email, is_active)
  VALUES (u_l, b, 'owner', 'L', 'rowrules286-l@example.invalid', false);

  INSERT INTO teams (account_id, name, leader_user_id) VALUES (acct, 'rr286', u_l) RETURNING id INTO t;
  INSERT INTO teams (account_id, name) VALUES (b, 'rr286b') RETURNING id INTO tb;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t, u_a, acct);
  INSERT INTO contacts (user_id, phone, account_id) VALUES (u_a, '+971500286001', acct) RETURNING id INTO ca;
  INSERT INTO contacts (user_id, phone, account_id) VALUES (u_b, '+971500286002', acct) RETURNING id INTO cb;
  INSERT INTO contacts (user_id, phone, account_id) VALUES (u_a, '+971500286003', acct) RETURNING id INTO ca2;
  INSERT INTO broadcasts (user_id, account_id, name, template_name) VALUES (u_l, b, 'rr286', 't') RETURNING id INTO bc;
  INSERT INTO conversations (user_id, contact_id, account_id, assigned_agent_id) VALUES (u_a, ca, acct, u_a) RETURNING id INTO va;
  INSERT INTO conversations (user_id, contact_id, account_id, assigned_agent_id) VALUES (u_b, cb, acct, u_b) RETURNING id INTO vb;
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text, created_at)
  VALUES (va, 'customer', 'text', 'hi', now() - interval '1 hour') RETURNING id INTO ma;
  INSERT INTO message_reactions (message_id, conversation_id, actor_type, emoji) VALUES (ma, va, 'customer', 'x');
  INSERT INTO pipelines (user_id, name, account_id) VALUES (u_own, 'P', acct) RETURNING id INTO pl;
  INSERT INTO pipeline_stages (pipeline_id, name) VALUES (pl, 'S') RETURNING id INTO st;
  INSERT INTO pipelines (user_id, name, account_id) VALUES (u_l, 'P2', b) RETURNING id INTO pl2;
  INSERT INTO pipeline_stages (pipeline_id, name) VALUES (pl2, 'S2') RETURNING id INTO st2;
  INSERT INTO contact_notes (contact_id, user_id, note_text, account_id) VALUES (ca, u_a, 'n', acct) RETURNING id INTO na;
  INSERT INTO deals (user_id, pipeline_id, stage_id, contact_id, title, account_id) VALUES (u_a, pl, st, ca, 'D', acct) RETURNING id INTO d;
  INSERT INTO whatsapp_config (user_id, phone_number_id, access_token, account_id)
  VALUES (u_own, 'rr286a', 'x', acct) RETURNING id INTO cfga;
  INSERT INTO team_activity_unlocks (account_id, requester_id, conversation_id, rule, reason, status, used_at, expires_at)
  VALUES (acct, u_a, va, 'quiet_hours', 'reason286', 'used', now(), now() + interval '1 hour')
  RETURNING id INTO un;

  -- ---------- as one person: want = exact answer ----------
  FOR i IN SELECT * FROM (VALUES
    (1, 'S1 leader sees their team only', u_l, format('SELECT led_teammate_user_ids()::text'), format('{%s}', u_a)),
    (2, 'S1 leads their member', u_l, format('SELECT leads_teammate(%L,%L)::text', acct, u_a), 'true'),
    (3, 'S1 leads nobody else', u_l, format('SELECT leads_teammate(%L,%L)::text', acct, u_b), 'false'),
    (4, 'S1 the leader''s chats', u_l, format('SELECT array_agg(id)::text FROM conversations WHERE account_id=%L', acct), format('{%s}', va)),
    (5, 'S1 admin saves the team', u_own, format('SELECT set_team_members(%L, ARRAY[%L,%L]::uuid[])::text', t, u_a, u_b), ''),
    (6, 'S1 admin saves it back', u_own, format('SELECT set_team_members(%L, ARRAY[%L]::uuid[])::text', t, u_a), ''),
    (7, 'S1 a guest is no team member', u_own, format('INSERT INTO team_members VALUES (%L,%L,%L)', t, u_g, acct), '42501'),
    (8, 'S1 nobody from outside', u_own, format('INSERT INTO team_members VALUES (%L,%L,%L)', t, '00000000-0000-4000-8000-0000002860ff', acct), '42501'),
    (9, 'S1 a team of another account', u_own, format('INSERT INTO team_members VALUES (%L,%L,%L)', tb, u_b, acct), '23503'),
    (10, 'S1 teams embed keeps one key', u_own, 'SELECT count(*)::text FROM pg_constraint WHERE conrelid=''public.team_members''::regclass AND confrelid=''public.teams''::regclass', '1'),
    (11, 'S1 both keys validated', u_own, 'SELECT count(*)::text FROM pg_constraint WHERE convalidated AND conname IN (''team_members_team_account_fkey'',''whatsapp_routes_config_account_fkey'')', '2'),
    (20, 'S3 forged customer reaction', u_a, format('INSERT INTO message_reactions (message_id,conversation_id,actor_type,actor_id,emoji) VALUES (%L,%L,''customer'',%L,''y'')', ma, va, u_a), '42501'),
    (21, 'S3 a colleague''s name', u_a, format('INSERT INTO message_reactions (message_id,conversation_id,actor_type,actor_id,emoji) VALUES (%L,%L,''agent'',%L,''y'')', ma, va, u_l), '42501'),
    (22, 'S3 filed under another chat', u_a, format('INSERT INTO message_reactions (message_id,conversation_id,actor_type,actor_id,emoji) VALUES (%L,%L,''agent'',%L,''y'')', ma, vb, u_a), '42501'),
    (23, 'S3 the react route upserts', u_a, format('INSERT INTO message_reactions (message_id,conversation_id,actor_type,actor_id,emoji) VALUES (%L,%L,''agent'',%L,''y'') ON CONFLICT (message_id,actor_type,actor_id) DO UPDATE SET emoji=EXCLUDED.emoji', ma, va, u_a), '1'),
    (24, 'S3 and swaps', u_a, format('INSERT INTO message_reactions (message_id,conversation_id,actor_type,actor_id,emoji) VALUES (%L,%L,''agent'',%L,''z'') ON CONFLICT (message_id,actor_type,actor_id) DO UPDATE SET conversation_id=EXCLUDED.conversation_id, emoji=EXCLUDED.emoji', ma, va, u_a), '1'),
    (25, 'S3 edits the customer''s', u_a, format('UPDATE message_reactions SET emoji=''q'' WHERE message_id=%L AND actor_type=''customer''', ma), '0'),
    (26, 'S3 deletes the customer''s', u_own, format('DELETE FROM message_reactions WHERE message_id=%L AND actor_type=''customer''', ma), '0'),
    (27, 'S3 all reactions still read', u_l, format('SELECT count(*)::text FROM message_reactions WHERE message_id=%L', ma), '2'),
    (28, 'S3 takes their own away', u_a, format('DELETE FROM message_reactions WHERE message_id=%L AND actor_type=''agent'' AND actor_id=%L', ma, u_a), '1'),
    (30, 'S4 leader rewrites', u_l, format('UPDATE contact_notes SET note_text=''x'' WHERE id=%L', na), '0'),
    (31, 'S4 admin rewrites', u_own, format('UPDATE contact_notes SET note_text=''x'' WHERE id=%L', na), '0'),
    (32, 'S4 leader deletes', u_l, format('DELETE FROM contact_notes WHERE id=%L', na), '0'),
    (33, 'S4 author edits', u_a, format('UPDATE contact_notes SET note_text=''x'' WHERE id=%L', na), '1'),
    (34, 'S4 author is frozen', u_a, format('UPDATE contact_notes SET user_id=%L WHERE id=%L', u_b, na), '42501'),
    (35, 'S4 customer is frozen', u_a, format('UPDATE contact_notes SET contact_id=%L WHERE id=%L', ca2, na), '42501'),
    (36, 'S4 anyone who sees the customer adds', u_l, format('INSERT INTO contact_notes (contact_id,user_id,note_text,account_id) VALUES (%L,%L,''m'',%L)', ca, u_l, acct), '1'),
    (37, 'S4 author deletes', u_l, format('DELETE FROM contact_notes WHERE contact_id=%L AND user_id=%L', ca, u_l), '1'),
    (38, 'S4 admin deletes', u_own, format('DELETE FROM contact_notes WHERE id=%L', na), '1'),
    (40, 'S5 new deal, hidden customer', u_a, format('INSERT INTO deals (user_id,pipeline_id,stage_id,contact_id,title,account_id) VALUES (%L,%L,%L,%L,''x'',%L)', u_a, pl, st, cb, acct), '42501'),
    (41, 'S5 new deal, hidden chat', u_a, format('INSERT INTO deals (user_id,pipeline_id,stage_id,conversation_id,title,account_id) VALUES (%L,%L,%L,%L,''x'',%L)', u_a, pl, st, vb, acct), '42501'),
    (42, 'S5 re-pointed to a hidden customer', u_a, format('UPDATE deals SET contact_id=%L WHERE id=%L', cb, d), '42501'),
    (43, 'S5 another account''s pipeline', u_own, format('INSERT INTO deals (user_id,pipeline_id,stage_id,title,account_id) VALUES (%L,%L,%L,''x'',%L)', u_own, pl2, st2, acct), '42501'),
    (44, 'S5 another account''s stage', u_a, format('UPDATE deals SET stage_id=%L WHERE id=%L', st2, d), '42501'),
    (45, 'S5 deal form adds', u_a, format('INSERT INTO deals (user_id,pipeline_id,stage_id,contact_id,conversation_id,title,account_id) VALUES (%L,%L,%L,%L,%L,''y'',%L)', u_a, pl, st, ca, va, acct), '1'),
    (46, 'S5 board moves', u_a, format('UPDATE deals SET stage_id=%L, status=''won'' WHERE id=%L', st, d), '1'),
    (47, 'S5 leader edits with the same links', u_l, format('UPDATE deals SET title=''z'', contact_id=%L, pipeline_id=%L, stage_id=%L WHERE id=%L', ca, pl, st, d), '1')
  ) AS v(o, what, who, sql, want) ORDER BY o
  LOOP
    cnt := cnt + 1;
    r := pg_temp.rr_try(i.who, i.sql);
    IF i.want <> '' AND r <> i.want OR i.want = '' AND r ~ '^[0-9A-Z]{5}$' THEN
      failed := failed || format('%s (%s, want %s)', i.what, r, i.want);
    END IF;
  END LOOP;

  -- ---------- S1: the two-workspace call, switched into B ----------
  UPDATE profiles SET is_active = false WHERE user_id = u_l AND account_id = acct;
  UPDATE profiles SET is_active = true WHERE user_id = u_l AND account_id = b;
  FOR i IN SELECT * FROM (VALUES
    ('S1 a row for a team of another workspace', format('INSERT INTO team_members VALUES (%L,%L,%L)', t, u_b, b)),
    ('S1 and for oneself', format('INSERT INTO team_members VALUES (%L,%L,%L)', t, u_l, b)),
    ('same account: a route to another workspace''s number', format('INSERT INTO whatsapp_routes (account_id,surface,config_id) VALUES (%L,''inbox'',%L)', b, cfga)),
    ('same account: a broadcast to another workspace''s customer', format('INSERT INTO broadcast_recipients (broadcast_id,contact_id) VALUES (%L,%L)', bc, ca))
  ) AS v(what, sql)
  LOOP
    cnt := cnt + 1;
    r := pg_temp.rr_try(u_l, i.sql);
    IF r NOT IN ('42501', '23503') THEN failed := failed || format('%s (%s)', i.what, r); END IF;
  END LOOP;
  UPDATE profiles SET is_active = false WHERE user_id = u_l AND account_id = b;
  UPDATE profiles SET is_active = true WHERE user_id = u_l AND account_id = acct;

  -- A row from before the rule is ignored.
  ALTER TABLE team_members DROP CONSTRAINT team_members_team_account_fkey;
  INSERT INTO team_members VALUES (t, u_b, b);
  FOR i IN SELECT * FROM (VALUES
    ('leads_teammate', format('SELECT leads_teammate(%L,%L)::text', acct, u_b)),
    ('led_teammate_user_ids', format('SELECT (%L = ANY (led_teammate_user_ids()))::text', u_b)),
    ('led_teammate_profile_ids', 'SELECT (cardinality(led_teammate_profile_ids()) <> 1)::text'),
    ('pbx_visible_user_ids', format('SELECT (%L = ANY (pbx_visible_user_ids()))::text', u_b)),
    ('contact_visibility_people', format('SELECT (%L IN (SELECT contact_visibility_people()))::text', u_b)),
    ('conversations', format('SELECT (count(*) > 0)::text FROM conversations WHERE id = %L', vb)),
    ('contacts', format('SELECT (count(*) > 0)::text FROM contacts WHERE id = %L', cb)),
    ('can_view_conversation', format('SELECT can_view_conversation(%L,%L,%L)::text', acct, u_b, u_b))
  ) AS v(what, sql)
  LOOP
    cnt := cnt + 1;
    r := pg_temp.rr_try(u_l, i.sql);
    IF r <> 'false' THEN failed := failed || format('S1 an old row still counts: %s (%s)', i.what, r); END IF;
  END LOOP;
  IF can_view_conversation_for_user(u_l, acct, u_b, u_b) THEN
    failed := failed || 'S1 an old row still counts: can_view_conversation_for_user'::text;
  END IF;

  -- Every body that joins the roster to a team names the account too.
  FOR f IN
    SELECT proname FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace AND prosrc ~ '\mteam_members\M'
       AND proname <> ALL (ARRAY['profiles_leave_account_teams', 'deactivated_member_cleanup'])
       AND (prosrc ~ '\m(tm|m)\.team_id = (t|ct)\.(id|team_id)\M(?! AND \w+\.account_id)'
            AND prosrc !~ '\mm\.account_id = (p_account|c\.account_id)\M'
            OR prosrc !~ 'account_id')
  LOOP
    failed := failed || format('S1 %s joins team_members without the account', f.proname);
  END LOOP;

  -- ---------- S2 ----------
  r := pg_temp.rr_try(u_a, format('SELECT team_activity_release_unlock(%L)::text', va));
  IF r <> 'true' THEN failed := failed || format('S2 a failed send gives it back (%s)', r); END IF;
  UPDATE team_activity_unlocks SET status = 'used', used_at = now() WHERE id = un;
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_type, content_text, created_at)
  VALUES (va, 'agent', u_a, 'text', 'out', now() + interval '1 second');
  r := pg_temp.rr_try(u_a, format('SELECT team_activity_release_unlock(%L)::text', va));
  IF r <> 'false' THEN failed := failed || format('S2 not after a message went out (%s)', r); END IF;

  -- ---------- system paths pass the deal and note rules ----------
  BEGIN
    INSERT INTO deals (user_id, pipeline_id, stage_id, contact_id, title, account_id) VALUES (u_a, pl, st, cb, 'sys', acct);
    SET LOCAL ROLE service_role;
    INSERT INTO deals (user_id, pipeline_id, stage_id, contact_id, title, account_id) VALUES (u_a, pl, st, cb, 'sys', acct);
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    failed := failed || format('S5 the system creates a deal (%s)', SQLERRM);
  END;

  RAISE EXCEPTION USING ERRCODE = 'ZT286', MESSAGE = 'rollback';
  EXCEPTION WHEN SQLSTATE 'ZT286' THEN NULL;
  END;

  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'team and row rules: % failed: %', cardinality(failed), array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'team and row rules verified (% checks)', cnt;
END
$verify$;
