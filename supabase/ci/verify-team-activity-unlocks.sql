-- Behavioural regression suite for Team activity unlock requests
-- (migration 205).
--
-- 204 blocks a send; 205 lets the blocked person ask for a one-time
-- unlock that an owner, an admin or their team leader decides. This
-- file asserts: who may ask and every refusal (SQLSTATE and HINT), the
-- request bell (live owners/admins and the requester's leaders, never
-- the requester, a deactivated admin or another team's leader), who
-- reads the rows, who may decide and every refusal, the decision bell,
-- that no bell carries the reason, and 204's start_check spending an
-- approval exactly once (never a denied or an expired one).
--
-- Blocks come from the link_first rule alone (quiet hours, burst and
-- every other rule off): it depends on neither the clock nor history.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. Every fixture is
-- rolled back by a sentinel; the verdict lives in variables.

DO $verify$
DECLARE
  u_o   UUID := '00000000-0000-4000-8000-0000000fe100';
  u_ad  UUID := '00000000-0000-4000-8000-0000000fe101';
  u_l   UUID := '00000000-0000-4000-8000-0000000fe102';
  u_l2  UUID := '00000000-0000-4000-8000-0000000fe103';
  u_a   UUID := '00000000-0000-4000-8000-0000000fe104';
  u_b   UUID := '00000000-0000-4000-8000-0000000fe105';
  u_c   UUID := '00000000-0000-4000-8000-0000000fe106';
  u_x   UUID := '00000000-0000-4000-8000-0000000fe107';
  v_reason TEXT := 'Customer asked for the brochure link';
  acct  UUID;
  w     UUID;
  t1    UUID;
  t2    UUID;
  cv0   UUID;
  cv1   UUID;
  cv2   UUID;
  blk   UUID;
  ul1   UUID;
  ul2   UUID;
  ul3   UUID;
  j     JSONB;
  r     TEXT;
  n     INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a query as a role (and signed-in user): its value, or 'ERROR …'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.lt_val(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN v;
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  -- As a signed-in person; an error comes back as 'ERR <SQLSTATE> <HINT>',
  -- the pair the API maps.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ul_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; s text; h text;
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
        RETURN v;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, h = PG_EXCEPTION_HINT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERR ' || s || ' ' || coalesce(h, '');
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ul_req(p_uid uuid, p_block uuid, p_reason text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.ul_try(p_uid, format(
        'SELECT team_activity_request_unlock(%L::uuid, %L::text)::text', p_block, p_reason))
    $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ul_dec(p_uid uuid, p_id uuid, p_approve boolean, p_note text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.ul_try(p_uid, format(
        'SELECT team_activity_decide_unlock(%L::uuid, %L::boolean, %L::text)',
        p_id, p_approve, p_note))
    $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.lt_conv(p_acct uuid, p_owner uuid, p_channel uuid, p_name text)
    RETURNS uuid LANGUAGE plpgsql AS $body$
    DECLARE v_ct uuid; v_cv uuid;
    BEGIN
      INSERT INTO contacts (account_id, user_id, phone, name)
      VALUES (p_acct, p_owner,
              '97159' || lpad((SELECT count(*) + 1 FROM contacts WHERE account_id = p_acct)::text, 7, '0'),
              p_name)
      RETURNING id INTO v_ct;
      INSERT INTO conversations (account_id, user_id, contact_id, channel_id)
      VALUES (p_acct, p_owner, v_ct, p_channel)
      RETURNING id INTO v_cv;
      RETURN v_cv;
    END $body$
  $fn$;
  -- The 3-arg check as a signed-in person; an error comes back as {error}.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ev_chk(p_uid uuid, p_conv uuid, p_ch uuid, p_text text)
    RETURNS jsonb LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      v := pg_temp.lt_val('authenticated', p_uid, format(
             'SELECT team_activity_start_check(%L::uuid, %L::uuid, %L::text)::text',
             p_conv, p_ch, p_text));
      IF v IS NULL OR v LIKE 'ERROR%' THEN
        RETURN jsonb_build_object('error', coalesce(v, 'null'));
      END IF;
      RETURN v::jsonb;
    END $body$
  $fn$;
  -- A link_first block of p_uid in p_conv: its id, or NULL.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ul_block(p_uid uuid, p_conv uuid, p_ch uuid)
    RETURNS uuid LANGUAGE plpgsql AS $body$
    DECLARE v jsonb;
    BEGIN
      v := pg_temp.ev_chk(p_uid, p_conv, p_ch, 'Brochure: https://x.example');
      IF v ->> 'blocked' = 'true' AND v ->> 'rule' = 'link_first' THEN
        RETURN (v ->> 'block_id')::uuid;
      END IF;
      RETURN NULL;
    END $body$
  $fn$;

  -- ---------------------------------------------------------------
  -- Fixture: owner o, admin ad, deactivated admin x, leader l (team
  -- t1: a, b), leader l2 (team t2: c), agents a b c; w a company Whapi
  -- number (30 days old).
  -- ---------------------------------------------------------------
  INSERT INTO auth.users (id, email) VALUES
    (u_o, 'ul-o@example.invalid'), (u_ad, 'ul-ad@example.invalid'),
    (u_l, 'ul-l@example.invalid'), (u_l2, 'ul-l2@example.invalid'),
    (u_a, 'ul-a@example.invalid'), (u_b, 'ul-b@example.invalid'),
    (u_c, 'ul-c@example.invalid'), (u_x, 'ul-x@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO acct FROM profiles WHERE user_id = u_o;
  IF acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = acct, account_role = 'admin' WHERE user_id IN (u_ad, u_x);
  UPDATE profiles SET account_id = acct, account_role = 'team_leader' WHERE user_id IN (u_l, u_l2);
  UPDATE profiles SET account_id = acct, account_role = 'agent' WHERE user_id IN (u_a, u_b, u_c);
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_x;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, status, is_primary, created_at)
  VALUES (u_o, acct, 'whapi', 'UL-205-W', 'x', '971500205001', 'connected', true, now() - interval '30 days')
  RETURNING id INTO w;

  INSERT INTO teams (account_id, name, leader_user_id) VALUES (acct, 'UL Team 1', u_l) RETURNING id INTO t1;
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (acct, 'UL Team 2', u_l2) RETURNING id INTO t2;
  INSERT INTO team_members (team_id, user_id, account_id)
  VALUES (t1, u_a, acct), (t1, u_b, acct), (t2, u_c, acct);

  -- Master on, link_first alone; no quiet hours, no burst.
  INSERT INTO team_activity_settings
    (account_id, timezone, daily_new_chats_per_user, daily_new_chats_per_number,
     burst_new_chats_10min, max_unanswered_in_row, min_reply_rate, same_opener_max,
     quiet_hours_start, quiet_hours_end,
     block_over_limit, enforce_chase, enforce_quiet_hours, enforce_daily_user,
     enforce_reply_rate, enforce_daily_number, enforce_burst, enforce_links_first,
     enforce_same_opener, enforce_jev, enforce_auto_senders, allow_unlock_requests)
  VALUES (acct, 'UTC', 100, 100, 100, 3, 30, 2, 0, 0,
          true, false, false, false, false, false, false, true, false, false, false, true);

  cv0 := pg_temp.lt_conv(acct, u_o, w, 'UL old');
  cv1 := pg_temp.lt_conv(acct, u_o, w, 'UL main');
  cv2 := pg_temp.lt_conv(acct, u_o, w, 'UL expiry');

  -- ---------------------------------------------------------------
  -- Asking: every refusal, and none writes a row.
  -- ---------------------------------------------------------------
  blk := pg_temp.ul_block(u_a, cv1, w);
  IF blk IS NULL THEN
    RAISE EXCEPTION 'fixture: link_first did not block a in cv1';
  END IF;
  r := pg_temp.ul_req(u_b, blk, v_reason);
  n := n + 1;
  IF r IS DISTINCT FROM 'ERR 42501 not_allowed' THEN
    failed := array_append(failed, ('another person asked on a block: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.ul_req(u_a, gen_random_uuid(), v_reason);
  n := n + 1;
  IF r IS DISTINCT FROM 'ERR P0002 not_found' THEN
    failed := array_append(failed, ('unknown block: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.ul_req(u_a, blk, E' \t\n ');
  n := n + 1;
  IF r IS DISTINCT FROM 'ERR 22023 reason_length' THEN
    failed := array_append(failed, ('blank reason: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.ul_req(u_a, blk, 'abcd');
  n := n + 1;
  IF r IS DISTINCT FROM 'ERR 22023 reason_length' THEN
    failed := array_append(failed, ('4-char reason: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.ul_req(u_a, blk, repeat('x', 501));
  n := n + 1;
  IF r IS DISTINCT FROM 'ERR 22023 reason_length' THEN
    failed := array_append(failed, ('501-char reason: ' || coalesce(r, 'null'))::text);
  END IF;
  UPDATE team_activity_settings SET allow_unlock_requests = false WHERE account_id = acct;
  r := pg_temp.ul_req(u_a, blk, v_reason);
  n := n + 1;
  IF r IS DISTINCT FROM 'ERR 42501 unlocks_off' THEN
    failed := array_append(failed, ('unlock requests off: ' || coalesce(r, 'null'))::text);
  END IF;
  UPDATE team_activity_settings SET allow_unlock_requests = true WHERE account_id = acct;
  -- A block over 24 hours old.
  ul1 := pg_temp.ul_block(u_a, cv0, w);
  UPDATE team_activity_blocks SET created_at = now() - interval '25 hours' WHERE id = ul1;
  r := pg_temp.ul_req(u_a, ul1, v_reason);
  n := n + 1;
  IF ul1 IS NULL OR r IS DISTINCT FROM 'ERR 22023 block_too_old' THEN
    failed := array_append(failed, ('old block: ' || coalesce(r, 'null'))::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM team_activity_unlocks WHERE account_id = acct) THEN
    failed := array_append(failed, 'a refused request wrote a row'::text);
  END IF;

  -- ---------------------------------------------------------------
  -- Asking: the request, its row and its bells.
  -- ---------------------------------------------------------------
  r := pg_temp.ul_req(u_a, blk, v_reason);
  ul1 := CASE WHEN r ~ '^[0-9a-f-]{36}$' THEN r::uuid END;
  IF ul1 IS NULL THEN
    RAISE EXCEPTION 'request_unlock failed: %', r;
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM team_activity_unlocks u WHERE u.id = ul1
                 AND u.status = 'pending' AND u.requester_id = u_a AND u.account_id = acct
                 AND u.conversation_id = cv1 AND u.block_id = blk AND u.rule = 'link_first'
                 AND u.reason = v_reason AND u.expires_at IS NULL) THEN
    failed := array_append(failed, 'the pending row is not as asked'::text);
  END IF;
  SELECT string_agg(x.who, ',' ORDER BY x.who) INTO r
    FROM (SELECT CASE nt.user_id WHEN u_o THEN 'o' WHEN u_ad THEN 'ad' WHEN u_l THEN 'l'
                                 WHEN u_l2 THEN 'l2' WHEN u_a THEN 'a' WHEN u_x THEN 'x'
                                 ELSE nt.user_id::text END AS who
            FROM notifications nt
           WHERE nt.type = 'team_activity_unlock_request'
             AND nt.meta ->> 'unlock_id' = ul1::text) x;
  n := n + 1;
  IF r IS DISTINCT FROM 'ad,l,o' THEN
    failed := array_append(failed, ('request bell recipients (want ad,l,o): ' || coalesce(r, 'none'))::text);
  END IF;
  -- A second request for the same chat while one waits.
  blk := pg_temp.ul_block(u_a, cv1, w);
  r := pg_temp.ul_req(u_a, blk, v_reason);
  n := n + 1;
  IF blk IS NULL OR r IS DISTINCT FROM 'ERR 23505 already_pending' THEN
    failed := array_append(failed, ('second pending request: ' || coalesce(r, 'null'))::text);
  END IF;

  -- ---------------------------------------------------------------
  -- Who reads the rows: the requester, owner, admin and the
  -- requester's leader; another team's leader and agents none.
  -- ---------------------------------------------------------------
  r := concat_ws(',',
         pg_temp.lt_val('authenticated', u_a, 'SELECT count(*)::text FROM team_activity_unlocks'),
         pg_temp.lt_val('authenticated', u_o, 'SELECT count(*)::text FROM team_activity_unlocks'),
         pg_temp.lt_val('authenticated', u_ad, 'SELECT count(*)::text FROM team_activity_unlocks'),
         pg_temp.lt_val('authenticated', u_l, 'SELECT count(*)::text FROM team_activity_unlocks'),
         pg_temp.lt_val('authenticated', u_l2, 'SELECT count(*)::text FROM team_activity_unlocks'),
         pg_temp.lt_val('authenticated', u_b, 'SELECT count(*)::text FROM team_activity_unlocks'),
         pg_temp.lt_val('authenticated', u_c, 'SELECT count(*)::text FROM team_activity_unlocks'));
  n := n + 1;
  IF r IS DISTINCT FROM '1,1,1,1,0,0,0' THEN
    failed := array_append(failed, ('rows read by a,o,ad,l,l2,b,c (want 1,1,1,1,0,0,0): ' || r)::text);
  END IF;

  -- ---------------------------------------------------------------
  -- Deciding: every refusal, and none changes the row.
  -- ---------------------------------------------------------------
  r := pg_temp.ul_dec(u_a, ul1, true, NULL);
  n := n + 1;
  IF r IS DISTINCT FROM 'ERR 42501 not_allowed' THEN
    failed := array_append(failed, ('requester decided own request: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.ul_dec(u_l2, ul1, true, NULL);
  n := n + 1;
  IF r IS DISTINCT FROM 'ERR 42501 not_allowed' THEN
    failed := array_append(failed, ('another team''s leader decided: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.ul_dec(u_b, ul1, true, NULL);
  n := n + 1;
  IF r IS DISTINCT FROM 'ERR 42501 not_allowed' THEN
    failed := array_append(failed, ('an agent decided: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.ul_dec(u_l, ul1, NULL, NULL);
  n := n + 1;
  IF r IS DISTINCT FROM 'ERR 22023 invalid' THEN
    failed := array_append(failed, ('approve NULL: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.ul_dec(u_l, ul1, true, repeat('n', 501));
  n := n + 1;
  IF r IS DISTINCT FROM 'ERR 22023 note_length' THEN
    failed := array_append(failed, ('501-char note: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.ul_dec(u_l, gen_random_uuid(), true, NULL);
  n := n + 1;
  IF r IS DISTINCT FROM 'ERR P0002 not_found' THEN
    failed := array_append(failed, ('unknown request: ' || coalesce(r, 'null'))::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM team_activity_unlocks WHERE id = ul1 AND status = 'pending'
                 AND decided_by IS NULL) THEN
    failed := array_append(failed, 'a refused decision changed the row'::text);
  END IF;

  -- ---------------------------------------------------------------
  -- Deciding: the leader approves; the row, the bell; no second go.
  -- ---------------------------------------------------------------
  r := pg_temp.ul_dec(u_l, ul1, true, 'Fine, once');
  n := n + 1;
  IF r IS DISTINCT FROM 'approved' THEN
    failed := array_append(failed, ('leader approve: ' || coalesce(r, 'null'))::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM team_activity_unlocks WHERE id = ul1 AND status = 'approved'
                 AND decided_by = u_l AND decided_at IS NOT NULL AND decision_note = 'Fine, once'
                 AND used_at IS NULL
                 AND expires_at BETWEEN now() + interval '119 minutes'
                                    AND now() + interval '121 minutes') THEN
    failed := array_append(failed, 'the approved row is not as decided'::text);
  END IF;
  SELECT string_agg(nt.user_id::text || ':' || (nt.meta ->> 'status'), ',') INTO r
    FROM notifications nt
   WHERE nt.type = 'team_activity_unlock_decided' AND nt.meta ->> 'unlock_id' = ul1::text;
  n := n + 1;
  IF r IS DISTINCT FROM u_a::text || ':approved' THEN
    failed := array_append(failed, ('decided bell (want a only): ' || coalesce(r, 'none'))::text);
  END IF;
  r := pg_temp.ul_dec(u_ad, ul1, false, NULL);
  n := n + 1;
  IF r IS DISTINCT FROM 'ERR P0001 already_decided' THEN
    failed := array_append(failed, ('deciding twice: ' || coalesce(r, 'null'))::text);
  END IF;

  -- ---------------------------------------------------------------
  -- 204 spends the approval once, then blocks again.
  -- ---------------------------------------------------------------
  j := pg_temp.ev_chk(u_a, cv1, w, 'Brochure: https://x.example');
  n := n + 1;
  IF j ->> 'blocked' IS DISTINCT FROM 'false' OR j ->> 'unlock_used' IS DISTINCT FROM 'true' THEN
    failed := array_append(failed, ('approved unlock not spent: ' || j::text)::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM team_activity_unlocks WHERE id = ul1 AND status = 'used'
                 AND used_at IS NOT NULL) THEN
    failed := array_append(failed, 'the spent row is not used'::text);
  END IF;
  j := pg_temp.ev_chk(u_a, cv1, w, 'Brochure: https://x.example');
  n := n + 1;
  IF j ->> 'blocked' IS DISTINCT FROM 'true' OR j ->> 'rule' IS DISTINCT FROM 'link_first' THEN
    failed := array_append(failed, ('an unlock was spent twice: ' || j::text)::text);
  END IF;

  -- A denial (by an admin) leaves nothing to spend.
  r := pg_temp.ul_req(u_a, (j ->> 'block_id')::uuid, v_reason);
  ul2 := CASE WHEN r ~ '^[0-9a-f-]{36}$' THEN r::uuid END;
  r := pg_temp.ul_dec(u_ad, ul2, false, NULL);
  n := n + 1;
  IF ul2 IS NULL OR r IS DISTINCT FROM 'denied' THEN
    failed := array_append(failed, ('admin deny: ' || coalesce(r, 'null'))::text);
  END IF;
  j := pg_temp.ev_chk(u_a, cv1, w, 'Brochure: https://x.example');
  n := n + 1;
  IF j ->> 'blocked' IS DISTINCT FROM 'true' THEN
    failed := array_append(failed, ('a denial let the send through: ' || j::text)::text);
  END IF;

  -- An approval past expires_at is not spent.
  blk := pg_temp.ul_block(u_a, cv2, w);
  r := pg_temp.ul_req(u_a, blk, v_reason);
  ul3 := CASE WHEN r ~ '^[0-9a-f-]{36}$' THEN r::uuid END;
  r := pg_temp.ul_dec(u_o, ul3, true, NULL);
  n := n + 1;
  IF ul3 IS NULL OR r IS DISTINCT FROM 'approved' THEN
    failed := array_append(failed, ('owner approve: ' || coalesce(r, 'null'))::text);
  END IF;
  UPDATE team_activity_unlocks SET expires_at = now() - interval '1 minute' WHERE id = ul3;
  j := pg_temp.ev_chk(u_a, cv2, w, 'Brochure: https://x.example');
  n := n + 1;
  IF j ->> 'blocked' IS DISTINCT FROM 'true' OR j ->> 'unlock_used' = 'true' THEN
    failed := array_append(failed, ('an expired approval was spent: ' || j::text)::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM team_activity_unlocks WHERE id = ul3
             AND (status = 'used' OR used_at IS NOT NULL)) THEN
    failed := array_append(failed, 'the expired row was marked used'::text);
  END IF;

  -- ---------------------------------------------------------------
  -- Bells: three requests rang three people each; the reason is in
  -- none of them.
  -- ---------------------------------------------------------------
  SELECT count(*)::text INTO r FROM notifications nt
   WHERE nt.account_id = acct AND nt.type = 'team_activity_unlock_request';
  n := n + 1;
  IF r IS DISTINCT FROM '9' THEN
    failed := array_append(failed, ('request bells (want 3 x 3): ' || r)::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM notifications nt
             WHERE nt.account_id = acct
               AND nt.type IN ('team_activity_unlock_request', 'team_activity_unlock_decided')
               AND concat_ws(' ', nt.title, nt.body, nt.meta::text) ILIKE '%brochure link%') THEN
    failed := array_append(failed, 'a bell carries the reason'::text);
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT205', MESSAGE = 'verify-team-activity-unlocks rollback';
  EXCEPTION WHEN SQLSTATE 'ZT205' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'team activity unlock verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'team activity unlock verification passed (% checks)', n;
END
$verify$;
