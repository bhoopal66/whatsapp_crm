-- Behavioural regression suite for Team activity hard restrictions
-- (migration 204).
--
-- verify-team-activity.sql asserts the report and the daily limits as
-- 068/073 defined them. This file asserts 204's rules one at a time:
-- for each rule every other switch is off, the send is refused with
-- that rule and exactly one team_activity_blocks row, and switching the
-- rule off lets the same send through. Then the scope (owner exempt,
-- admin bound, personal and Meta numbers never, master switch), the
-- automatic senders' check, the Jev block recorder, who reads blocks,
-- my_day's restrictions, the 2-arg wrapper and the defaults.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. Every fixture is
-- rolled back by a sentinel; the verdict lives in variables.

DO $verify$
DECLARE
  u_o   UUID := '00000000-0000-4000-8000-0000000fe000';
  u_ad  UUID := '00000000-0000-4000-8000-0000000fe001';
  u_l   UUID := '00000000-0000-4000-8000-0000000fe002';
  u_a   UUID := '00000000-0000-4000-8000-0000000fe003';
  u_b   UUID := '00000000-0000-4000-8000-0000000fe004';
  u_c   UUID := '00000000-0000-4000-8000-0000000fe005';
  u_d   UUID := '00000000-0000-4000-8000-0000000fe006';
  u_e   UUID := '00000000-0000-4000-8000-0000000fe007';
  u_z   UUID := '00000000-0000-4000-8000-0000000fe008';
  acct  UUID;
  acct2 UUID;
  w     UUID;
  w2    UUID;
  wp    UUID;
  m     UUID;
  tm    UUID;
  cv    UUID;
  cv2   UUID;
  h     INT := extract(hour FROM now() AT TIME ZONE 'UTC')::int;
  j     JSONB;
  r     TEXT;
  k     INT;
  i     INT;
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
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.lt_conv(p_acct uuid, p_owner uuid, p_channel uuid, p_name text)
    RETURNS uuid LANGUAGE plpgsql AS $body$
    DECLARE v_ct uuid; v_cv uuid;
    BEGIN
      INSERT INTO contacts (account_id, user_id, phone, name)
      VALUES (p_acct, p_owner,
              '97158' || lpad((SELECT count(*) + 1 FROM contacts WHERE account_id = p_acct)::text, 7, '0'),
              p_name)
      RETURNING id INTO v_ct;
      INSERT INTO conversations (account_id, user_id, contact_id, channel_id)
      VALUES (p_acct, p_owner, v_ct, p_channel)
      RETURNING id INTO v_cv;
      RETURN v_cv;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.lt_msg(p_conv uuid, p_type text, p_sender uuid, p_text text,
                                   p_at timestamptz, p_channel uuid)
    RETURNS void LANGUAGE plpgsql AS $body$
    BEGIN
      INSERT INTO messages (conversation_id, sender_type, sender_id, content_text,
                            created_at, channel_id, provider, status)
      VALUES (p_conv, p_type, p_sender, p_text, p_at, p_channel, 'whapi', 'sent');
    END $body$
  $fn$;
  -- Master on; only the listed rule switches on ('all' = every one).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ev_only(p_acct uuid, p text[])
    RETURNS void LANGUAGE sql AS $body$
      UPDATE team_activity_settings SET
        block_over_limit     = true,
        enforce_chase        = 'chase' = ANY (p) OR 'all' = ANY (p),
        enforce_quiet_hours  = 'quiet_hours' = ANY (p) OR 'all' = ANY (p),
        enforce_daily_user   = 'daily_user' = ANY (p) OR 'all' = ANY (p),
        enforce_reply_rate   = 'reply_rate' = ANY (p) OR 'all' = ANY (p),
        enforce_daily_number = 'daily_number' = ANY (p) OR 'all' = ANY (p),
        enforce_burst        = 'burst' = ANY (p) OR 'all' = ANY (p),
        enforce_links_first  = 'link_first' = ANY (p) OR 'all' = ANY (p),
        enforce_same_opener  = 'same_opener' = ANY (p) OR 'all' = ANY (p),
        enforce_jev          = 'all' = ANY (p),
        enforce_auto_senders = 'auto' = ANY (p) OR 'all' = ANY (p)
      WHERE account_id = p_acct
    $body$
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
  -- NULL when refused by p_rule with exactly one new block row; else why not.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ev_block(p_label text, p_uid uuid, p_conv uuid, p_ch uuid,
                                     p_text text, p_rule text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE c0 bigint; c1 bigint; v jsonb; ok boolean;
    BEGIN
      SELECT count(*) INTO c0 FROM team_activity_blocks;
      v := pg_temp.ev_chk(p_uid, p_conv, p_ch, p_text);
      SELECT count(*) INTO c1 FROM team_activity_blocks;
      SELECT EXISTS (SELECT 1 FROM team_activity_blocks b
                     WHERE b.id::text = v ->> 'block_id' AND b.rule = p_rule
                       AND b.user_id = p_uid AND b.source = 'human')
        INTO ok;
      IF v ->> 'blocked' = 'true' AND v ->> 'rule' = p_rule AND c1 = c0 + 1 AND ok THEN
        RETURN NULL;
      END IF;
      RETURN p_label || ': expected ' || p_rule || ', got ' || v::text
        || ' (' || (c1 - c0) || ' new rows)';
    END $body$
  $fn$;
  -- NULL when allowed with no new block row; else why not.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ev_allow(p_label text, p_uid uuid, p_conv uuid, p_ch uuid,
                                     p_text text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE c0 bigint; c1 bigint; v jsonb;
    BEGIN
      SELECT count(*) INTO c0 FROM team_activity_blocks;
      v := pg_temp.ev_chk(p_uid, p_conv, p_ch, p_text);
      SELECT count(*) INTO c1 FROM team_activity_blocks;
      IF v ->> 'blocked' = 'false' AND c1 = c0 THEN
        RETURN NULL;
      END IF;
      RETURN p_label || ': expected allowed, got ' || v::text || ' (' || (c1 - c0) || ' new rows)';
    END $body$
  $fn$;

  -- ---------------------------------------------------------------
  -- Fixture: owner, admin, leader l (team: a, b), agents a b c d e.
  -- w and w2 company Whapi numbers (30 days old), wp a personal OpenWA
  -- number, m the Meta number. u_z owns a second account with no
  -- settings row.
  -- ---------------------------------------------------------------
  INSERT INTO auth.users (id, email) VALUES
    (u_o, 'ev-o@example.invalid'), (u_ad, 'ev-ad@example.invalid'),
    (u_l, 'ev-l@example.invalid'), (u_a, 'ev-a@example.invalid'),
    (u_b, 'ev-b@example.invalid'), (u_c, 'ev-c@example.invalid'),
    (u_d, 'ev-d@example.invalid'), (u_e, 'ev-e@example.invalid'),
    (u_z, 'ev-z@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO acct FROM profiles WHERE user_id = u_o;
  SELECT account_id INTO acct2 FROM profiles WHERE user_id = u_z;
  IF acct IS NULL OR acct2 IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = acct, account_role = 'admin' WHERE user_id = u_ad;
  UPDATE profiles SET account_id = acct, account_role = 'team_leader' WHERE user_id = u_l;
  UPDATE profiles SET account_id = acct, account_role = 'agent'
   WHERE user_id IN (u_a, u_b, u_c, u_d, u_e);
  -- 190: a personal number needs the admin's permission first.
  UPDATE profiles SET may_connect_personal_whatsapp = true WHERE user_id = u_a;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, status, is_primary, created_at)
  VALUES (u_o, acct, 'whapi', 'EV-204-W', 'x', '971500204001', 'connected', true, now() - interval '30 days')
  RETURNING id INTO w;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, status, is_primary, created_at)
  VALUES (u_o, acct, 'whapi', 'EV-204-W2', 'x', '971500204002', 'connected', false, now() - interval '30 days')
  RETURNING id INTO w2;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, status, is_primary, is_personal, created_at)
  VALUES (u_a, acct, 'openwa', 'EV-204-P', 'x', '971500204003', 'connected', false, true, now() - interval '30 days')
  RETURNING id INTO wp;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, status, is_primary, created_at)
  VALUES (u_o, acct, 'meta', 'EV-204-M', 'x', 'EV-WABA', 'connected', false, now() - interval '30 days')
  RETURNING id INTO m;

  INSERT INTO teams (account_id, name, leader_user_id) VALUES (acct, 'EV Team', u_l) RETURNING id INTO tm;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (tm, u_a, acct), (tm, u_b, acct);

  -- Generous limits; each rule's own test tightens what it needs.
  INSERT INTO team_activity_settings
    (account_id, timezone, daily_new_chats_per_user, daily_new_chats_per_number,
     burst_new_chats_10min, max_unanswered_in_row, min_reply_rate, same_opener_max,
     quiet_hours_start, quiet_hours_end)
  VALUES (acct, 'UTC', 100, 100, 100, 3, 30, 2, 0, 0);

  -- ---------------------------------------------------------------
  -- Defaults: no settings row = master on, every switch on.
  -- ---------------------------------------------------------------
  SELECT to_jsonb(l) INTO j FROM team_activity_limits(acct2) l;
  n := n + 1;
  IF j IS NULL OR (j ->> 'block_over_limit') IS DISTINCT FROM 'true' OR EXISTS (
       SELECT 1 FROM jsonb_each_text(j) e
       WHERE (e.key LIKE 'enforce\_%' OR e.key IN ('allow_unlock_requests',
              'agent_view_enabled', 'leader_view_enabled'))
         AND e.value IS DISTINCT FROM 'true')
     OR (SELECT count(*) FROM jsonb_object_keys(j) x WHERE x LIKE 'enforce\_%') <> 10 THEN
    failed := array_append(failed, ('defaults without a row: ' || coalesce(j::text, 'null'))::text);
  END IF;
  SELECT column_default INTO r FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'team_activity_settings'
     AND column_name = 'block_over_limit';
  n := n + 1;
  IF r IS DISTINCT FROM 'true' THEN
    failed := array_append(failed, ('block_over_limit default: ' || coalesce(r, 'null'))::text);
  END IF;

  -- ---------------------------------------------------------------
  -- chase: three unanswered steps (hours apart), max 3 -> the 4th is
  -- refused, start or not. This chat's last message is an hour old.
  -- ---------------------------------------------------------------
  cv := pg_temp.lt_conv(acct, u_o, w, 'EV chase');
  PERFORM pg_temp.lt_msg(cv, 'customer', NULL, 'Hi', now() - interval '6 hours', w);
  PERFORM pg_temp.lt_msg(cv, 'agent', u_a, 'Step one', now() - interval '5 hours', w);
  PERFORM pg_temp.lt_msg(cv, 'agent', u_a, 'Step one, more', now() - interval '5 hours' + interval '2 minutes', w);
  PERFORM pg_temp.lt_msg(cv, 'agent', u_a, 'Step two', now() - interval '3 hours', w);
  PERFORM pg_temp.lt_msg(cv, 'agent', u_a, 'Step three', now() - interval '1 hour', w);
  PERFORM pg_temp.ev_only(acct, '{chase}');
  n := n + 1; failed := array_append(failed, pg_temp.ev_block('chase on', u_a, cv, w, 'Any news?', 'chase'));
  PERFORM pg_temp.ev_only(acct, '{}');
  n := n + 1; failed := array_append(failed, pg_temp.ev_allow('chase off', u_a, cv, w, 'Any news?'));

  -- ---------------------------------------------------------------
  -- quiet_hours: the window is the current UTC hour .. +1.
  -- Owner exempt, admin bound (both under this rule alone).
  -- ---------------------------------------------------------------
  UPDATE team_activity_settings SET quiet_hours_start = h, quiet_hours_end = (h + 1) % 24
   WHERE account_id = acct;
  cv := pg_temp.lt_conv(acct, u_o, w, 'EV quiet');
  PERFORM pg_temp.ev_only(acct, '{quiet_hours}');
  n := n + 1; failed := array_append(failed, pg_temp.ev_block('quiet on', u_a, cv, w, 'Hello', 'quiet_hours'));
  n := n + 1; failed := array_append(failed, pg_temp.ev_block('admin bound', u_ad, cv, w, 'Hello', 'quiet_hours'));
  n := n + 1; failed := array_append(failed, pg_temp.ev_allow('owner exempt', u_o, cv, w, 'Hello'));
  -- Out of scope even with every rule on: a personal number, Meta.
  PERFORM pg_temp.ev_only(acct, '{all}');
  n := n + 1; failed := array_append(failed, pg_temp.ev_allow('personal number', u_a, cv, wp, 'Hello'));
  n := n + 1; failed := array_append(failed, pg_temp.ev_allow('meta number', u_a, cv, m, 'Hello'));
  -- A reply (the customer wrote last) is not a start: only chase could
  -- apply, and it skips a customer who wrote last.
  cv2 := pg_temp.lt_conv(acct, u_o, w, 'EV reply');
  PERFORM pg_temp.lt_msg(cv2, 'customer', NULL, 'Hello?', now() - interval '2 days', w);
  n := n + 1; failed := array_append(failed, pg_temp.ev_allow('a late reply', u_a, cv2, w, 'see https://x.example'));
  -- Master off: nothing applies.
  UPDATE team_activity_settings SET block_over_limit = false WHERE account_id = acct;
  n := n + 1; failed := array_append(failed, pg_temp.ev_allow('master off', u_a, cv, w, 'see https://x.example'));
  PERFORM pg_temp.ev_only(acct, '{}');
  n := n + 1; failed := array_append(failed, pg_temp.ev_allow('quiet off', u_a, cv, w, 'Hello'));
  UPDATE team_activity_settings SET quiet_hours_start = 0, quiet_hours_end = 0 WHERE account_id = acct;

  -- ---------------------------------------------------------------
  -- daily_user: b has 2 starts today, limit 2.
  -- ---------------------------------------------------------------
  FOR i IN 1..2 LOOP
    cv := pg_temp.lt_conv(acct, u_o, w, 'EV b' || i);
    PERFORM pg_temp.lt_msg(cv, 'agent', u_b, 'Hello from b ' || i, now() - i * interval '1 second', w);
  END LOOP;
  UPDATE team_activity_settings SET daily_new_chats_per_user = 2 WHERE account_id = acct;
  cv := pg_temp.lt_conv(acct, u_o, w, 'EV daily');
  PERFORM pg_temp.ev_only(acct, '{daily_user}');
  n := n + 1; failed := array_append(failed, pg_temp.ev_block('daily_user on', u_b, cv, w, 'Hi', 'daily_user'));
  PERFORM pg_temp.ev_only(acct, '{}');
  n := n + 1; failed := array_append(failed, pg_temp.ev_allow('daily_user off', u_b, cv, w, 'Hi'));

  -- ---------------------------------------------------------------
  -- daily_user_throttled: c has 5 unanswered starts 3 days old (0%
  -- < 30%) and 1 today; limit 2 at 50% = 1.
  -- ---------------------------------------------------------------
  FOR i IN 1..5 LOOP
    cv := pg_temp.lt_conv(acct, u_o, w, 'EV c old' || i);
    PERFORM pg_temp.lt_msg(cv, 'agent', u_c, 'Old hello ' || i, now() - interval '3 days' + i * interval '1 minute', w);
  END LOOP;
  cv := pg_temp.lt_conv(acct, u_o, w, 'EV c today');
  PERFORM pg_temp.lt_msg(cv, 'agent', u_c, 'Hello today', now() - interval '1 second', w);
  UPDATE team_activity_settings SET reply_rate_throttle_pct = 50 WHERE account_id = acct;
  cv := pg_temp.lt_conv(acct, u_o, w, 'EV throttled');
  PERFORM pg_temp.ev_only(acct, '{daily_user,reply_rate}');
  n := n + 1; failed := array_append(failed, pg_temp.ev_block('throttled on', u_c, cv, w, 'Hi', 'daily_user_throttled'));
  PERFORM pg_temp.ev_only(acct, '{daily_user}');
  n := n + 1; failed := array_append(failed, pg_temp.ev_allow('reply_rate off', u_c, cv, w, 'Hi'));
  UPDATE team_activity_settings SET daily_new_chats_per_user = 100 WHERE account_id = acct;

  -- ---------------------------------------------------------------
  -- daily_number: w2 has a bot start and b's start today, limit 2.
  -- ---------------------------------------------------------------
  cv := pg_temp.lt_conv(acct, u_o, w2, 'EV w2 bot');
  PERFORM pg_temp.lt_msg(cv, 'bot', NULL, 'Automated hello', now() - interval '2 seconds', w2);
  cv := pg_temp.lt_conv(acct, u_o, w2, 'EV w2 b');
  PERFORM pg_temp.lt_msg(cv, 'agent', u_b, 'Hello on w2', now() - interval '1 second', w2);
  UPDATE team_activity_settings SET daily_new_chats_per_number = 2 WHERE account_id = acct;
  cv := pg_temp.lt_conv(acct, u_o, w2, 'EV number');
  PERFORM pg_temp.ev_only(acct, '{daily_number}');
  n := n + 1; failed := array_append(failed, pg_temp.ev_block('daily_number on', u_a, cv, w2, 'Hi', 'daily_number'));
  j := pg_temp.ev_chk(u_a, cv, w2, 'Hi');
  n := n + 1;
  IF (j -> 'detail' ->> 'started') IS DISTINCT FROM '2' THEN
    failed := array_append(failed, ('the bot start did not count: ' || j::text)::text);
  END IF;
  -- The 2-arg wrapper adds 068's keys.
  r := pg_temp.lt_val('authenticated', u_a, format(
         'SELECT team_activity_start_check(%L::uuid, %L::uuid)::text', cv, w2));
  n := n + 1;
  IF r NOT LIKE '{%' OR r::jsonb ->> 'reason' IS DISTINCT FROM 'number'
     OR r::jsonb ->> 'started' IS DISTINCT FROM '2' OR r::jsonb ->> 'limit' IS DISTINCT FROM '2' THEN
    failed := array_append(failed, ('2-arg wrapper keys: ' || r)::text);
  END IF;
  PERFORM pg_temp.ev_only(acct, '{}');
  n := n + 1; failed := array_append(failed, pg_temp.ev_allow('daily_number off', u_a, cv, w2, 'Hi'));

  -- Automatic senders: the number's limit only, only for a start.
  PERFORM pg_temp.ev_only(acct, '{all}');
  UPDATE team_activity_settings SET quiet_hours_start = h, quiet_hours_end = (h + 1) % 24
   WHERE account_id = acct;
  SELECT count(*) INTO k FROM team_activity_blocks WHERE source = 'auto';
  r := pg_temp.lt_val('service_role', NULL, format(
         'SELECT team_activity_auto_check(%L, %L, %L)::text', acct, cv, w2));
  n := n + 1;
  IF r NOT LIKE '{%' OR r::jsonb ->> 'rule' IS DISTINCT FROM 'daily_number' OR NOT EXISTS (
       SELECT 1 FROM team_activity_blocks b WHERE b.id::text = r::jsonb ->> 'block_id'
         AND b.source = 'auto' AND b.user_id IS NULL AND b.rule = 'daily_number') THEN
    failed := array_append(failed, ('auto at the number limit: ' || r)::text);
  END IF;
  r := pg_temp.lt_val('service_role', NULL, format(
         'SELECT team_activity_auto_check(%L, NULL, %L)::text', acct, w2));
  n := n + 1;
  IF r NOT LIKE '{%' OR r::jsonb ->> 'blocked' IS DISTINCT FROM 'true' THEN
    failed := array_append(failed, ('auto with no conversation: ' || r)::text);
  END IF;
  -- Under the limit, inside quiet hours: allowed (only the number rule).
  UPDATE team_activity_settings SET daily_new_chats_per_number = 3 WHERE account_id = acct;
  r := pg_temp.lt_val('service_role', NULL, format(
         'SELECT team_activity_auto_check(%L, %L, %L)::text', acct, cv, w2));
  n := n + 1;
  IF r NOT LIKE '{%' OR r::jsonb ->> 'blocked' IS DISTINCT FROM 'false' THEN
    failed := array_append(failed, ('auto refused under the limit: ' || r)::text);
  END IF;
  -- A reply on w2 at its limit: allowed.
  UPDATE team_activity_settings SET daily_new_chats_per_number = 2 WHERE account_id = acct;
  r := pg_temp.lt_val('service_role', NULL, format(
         'SELECT team_activity_auto_check(%L, %L, %L)::text', acct, cv2, w2));
  n := n + 1;
  IF r NOT LIKE '{%' OR r::jsonb ->> 'blocked' IS DISTINCT FROM 'false' THEN
    failed := array_append(failed, ('auto refused a reply: ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM team_activity_blocks WHERE source = 'auto') <> k + 2 THEN
    failed := array_append(failed, 'auto block rows: expected 2 new'::text);
  END IF;
  r := pg_temp.lt_val('authenticated', u_a, format(
         'SELECT team_activity_auto_check(%L, NULL, %L)::text', acct, w2));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('a person ran auto_check: ' || r)::text);
  END IF;
  UPDATE team_activity_settings SET daily_new_chats_per_number = 100,
         quiet_hours_start = 0, quiet_hours_end = 0
   WHERE account_id = acct;

  -- ---------------------------------------------------------------
  -- burst: d has 2 starts in the last 10 minutes, limit 2.
  -- ---------------------------------------------------------------
  FOR i IN 1..2 LOOP
    cv := pg_temp.lt_conv(acct, u_o, w, 'EV d' || i);
    PERFORM pg_temp.lt_msg(cv, 'agent', u_d, 'Quick hello ' || i, now() - i * interval '1 minute', w);
  END LOOP;
  UPDATE team_activity_settings SET burst_new_chats_10min = 2 WHERE account_id = acct;
  cv := pg_temp.lt_conv(acct, u_o, w, 'EV burst');
  PERFORM pg_temp.ev_only(acct, '{burst}');
  n := n + 1; failed := array_append(failed, pg_temp.ev_block('burst on', u_d, cv, w, 'Hi', 'burst'));
  j := pg_temp.ev_chk(u_d, cv, w, 'Hi');
  n := n + 1;
  IF coalesce((j -> 'detail' ->> 'retry_after_s')::int, 0) NOT BETWEEN 1 AND 600 THEN
    failed := array_append(failed, ('burst retry_after_s: ' || j::text)::text);
  END IF;
  PERFORM pg_temp.ev_only(acct, '{}');
  n := n + 1; failed := array_append(failed, pg_temp.ev_allow('burst off', u_d, cv, w, 'Hi'));
  UPDATE team_activity_settings SET burst_new_chats_10min = 100 WHERE account_id = acct;

  -- ---------------------------------------------------------------
  -- link_first
  -- ---------------------------------------------------------------
  cv := pg_temp.lt_conv(acct, u_o, w, 'EV link');
  PERFORM pg_temp.ev_only(acct, '{link_first}');
  n := n + 1; failed := array_append(failed, pg_temp.ev_block('link on', u_a, cv, w, 'Look: WWW.example.com', 'link_first'));
  n := n + 1; failed := array_append(failed, pg_temp.ev_allow('no link', u_a, cv, w, 'Hello there'));
  PERFORM pg_temp.ev_only(acct, '{}');
  n := n + 1; failed := array_append(failed, pg_temp.ev_allow('link off', u_a, cv, w, 'Look: https://x.example'));

  -- ---------------------------------------------------------------
  -- same_opener: e sent the same opener twice today, max 2.
  -- ---------------------------------------------------------------
  FOR i IN 1..2 LOOP
    cv := pg_temp.lt_conv(acct, u_o, w, 'EV e' || i);
    PERFORM pg_temp.lt_msg(cv, 'agent', u_e, 'Dear customer, a great card offer for you',
                           now() - interval '1 hour' - i * interval '1 minute', w);
  END LOOP;
  cv := pg_temp.lt_conv(acct, u_o, w, 'EV opener');
  PERFORM pg_temp.ev_only(acct, '{same_opener}');
  n := n + 1; failed := array_append(failed, pg_temp.ev_block('same_opener on', u_e, cv, w,
    'Dear customer, a great card offer for you', 'same_opener'));
  n := n + 1; failed := array_append(failed, pg_temp.ev_allow('another opener', u_e, cv, w, 'Good morning, about your loan'));
  PERFORM pg_temp.ev_only(acct, '{}');
  n := n + 1; failed := array_append(failed, pg_temp.ev_allow('same_opener off', u_e, cv, w,
    'Dear customer, a great card offer for you'));

  -- ---------------------------------------------------------------
  -- The Jev block recorder: jev_cold_pitch only.
  -- ---------------------------------------------------------------
  r := pg_temp.lt_val('authenticated', u_a, format(
         $q$SELECT team_activity_record_block(%L, %L, 'chase', '{}'::jsonb)::text$q$, cv, w));
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023%' THEN
    failed := array_append(failed, ('record_block took chase: ' || r)::text);
  END IF;
  r := pg_temp.lt_val('authenticated', u_a, format(
         $q$SELECT team_activity_record_block(%L, %L, 'jev_cold_pitch', '{"p": 0.9}'::jsonb)::text$q$, cv, w));
  n := n + 1;
  IF r LIKE 'ERROR%' OR NOT EXISTS (
       SELECT 1 FROM team_activity_blocks b WHERE b.id::text = r AND b.rule = 'jev_cold_pitch'
         AND b.user_id = u_a AND b.account_id = acct) THEN
    failed := array_append(failed, ('record_block jev_cold_pitch: ' || coalesce(r, 'null'))::text);
  END IF;

  -- ---------------------------------------------------------------
  -- Who reads blocks: own; a leader their team's; an admin all.
  -- Rows now exist for a, b (team), c, d, e, the admin and auto.
  -- ---------------------------------------------------------------
  r := pg_temp.lt_val('authenticated', u_a, format(
         'SELECT count(*) FILTER (WHERE user_id = %L) || '':'' || count(*) FILTER (WHERE user_id IS DISTINCT FROM %L) FROM team_activity_blocks',
         u_a, u_a));
  n := n + 1;
  IF r IS NULL OR split_part(r, ':', 1) IN ('', '0') OR split_part(r, ':', 2) <> '0' THEN
    failed := array_append(failed, ('agent block rows (own:other): ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.lt_val('authenticated', u_l, format(
         'SELECT count(*) FILTER (WHERE user_id = %L) || '':'' || count(*) FILTER (WHERE user_id IS NULL OR user_id NOT IN (%L, %L, %L)) FROM team_activity_blocks',
         u_b, u_a, u_b, u_l));
  n := n + 1;
  IF r IS NULL OR split_part(r, ':', 1) IN ('', '0') OR split_part(r, ':', 2) <> '0' THEN
    failed := array_append(failed, ('leader block rows (b:outside team): ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.lt_val('authenticated', u_ad, 'SELECT count(*)::text FROM team_activity_blocks');
  n := n + 1;
  IF r IS DISTINCT FROM (SELECT count(*)::text FROM team_activity_blocks WHERE account_id = acct) THEN
    failed := array_append(failed, ('admin block rows: ' || coalesce(r, 'null'))::text);
  END IF;

  -- ---------------------------------------------------------------
  -- my_day reports the restrictions in force.
  -- ---------------------------------------------------------------
  r := pg_temp.lt_val('authenticated', u_a, $q$SELECT team_activity_my_day('UTC')::text$q$);
  n := n + 1;
  IF r NOT LIKE '{%' OR jsonb_typeof(r::jsonb -> 'restrictions') IS DISTINCT FROM 'object'
     OR jsonb_typeof(r::jsonb -> 'restrictions' -> 'rules') IS DISTINCT FROM 'object' THEN
    failed := array_append(failed, ('my_day restrictions: ' || left(coalesce(r, 'null'), 300))::text);
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT204', MESSAGE = 'verify-team-activity-enforcement rollback';
  EXCEPTION WHEN SQLSTATE 'ZT204' THEN
    NULL;
  END;

  -- ev_block / ev_allow return NULL on success.
  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'team activity enforcement verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'team activity enforcement verification passed (% checks)', n;
END
$verify$;
