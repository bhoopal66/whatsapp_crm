-- Behavioural regression suite for internal chat (migration 087), part 2:
-- saved messages, reactions, pins, channel membership (chat_add_members,
-- chat_leave_channel, chat_set_member_role — decision D-B1), privileges,
-- the audited admin read, erasure, attachments and the `chat-files`
-- bucket, ported from the 014b package's db.test.ts (from "saved,
-- reactions, pins" on, including review fixes F1-F9 / R2-*).
--
-- Not portable into one session: the package's two lock races (F4,
-- R2-1) need two concurrent transactions. Their sequential halves are
-- here (an erased message cannot be edited and gains no history). The
-- package's "refuses a role without BYPASSRLS" test re-runs the
-- migration file and the lifecycle tests need separate databases.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. Failing checks
-- are named in the final exception; every fixture is rolled back by
-- the sentinel raised at the end of the inner block.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000087201';
  u_admin UUID := '00000000-0000-4000-8000-000000087202';
  u_sup   UUID := '00000000-0000-4000-8000-000000087203';  -- team_leader -> supervisor
  u_rm    UUID := '00000000-0000-4000-8000-000000087204';  -- agent
  u_rm2   UUID := '00000000-0000-4000-8000-000000087205';  -- agent
  u_ag    UUID := '00000000-0000-4000-8000-000000087206';  -- viewer -> chat agent
  u_guest UUID := '00000000-0000-4000-8000-000000087207';  -- bank_guest
  u_vic   UUID := '00000000-0000-4000-8000-000000087208';  -- erased
  u_x     UUID := '00000000-0000-4000-8000-000000087209';  -- demoted to guest (F7)
  u_g     UUID := '00000000-0000-4000-8000-000000087210';  -- demoted channel admin (R2-2)
  u_two   UUID := '00000000-0000-4000-8000-000000087211';  -- member of A and B (F5)
  u_dead  UUID := '00000000-0000-4000-8000-000000087212';  -- deactivated
  u_pown  UUID := '00000000-0000-4000-8000-000000087221';  -- account B
  u_psup  UUID := '00000000-0000-4000-8000-000000087222';
  u_prm   UUID := '00000000-0000-4000-8000-000000087223';
  a UUID; b UUID; uu UUID;
  conv_rm UUID; conv_rm2 UUID; conv_two UUID; conv_p UUID;
  ch UUID; ch2 UUID; dm UUID; deal UUID; m UUID; m1 UUID; m2 UUID; m3 UUID; mo UUID; mb UUID;
  ids UUID[] := '{}';
  r TEXT; t TEXT; col TEXT; p1 TEXT; atts JSONB; i INT; k INT;
  tables TEXT[] := ARRAY['chat_channels','chat_channel_members','internal_messages',
    'internal_message_edits','message_mentions','message_mentions_broadcast',
    'internal_message_reactions','message_pins','saved_messages','message_attachments',
    'shared_conversations','chat_notifications','chat_audit_log'];
  n INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run p_sql as p_role (NULL: stay the migration role) signed in as
  -- p_uid; the first column as text when p_val, else 'ok'; or the error
  -- as 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ic_go(p_role text, p_uid uuid, p_sql text, p_val boolean)
    RETURNS text LANGUAGE plpgsql AS $b$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', coalesce(p_role, 'postgres'))::text, true);
        IF p_role IS NOT NULL THEN EXECUTE format('SET LOCAL ROLE %I', p_role); END IF;
        IF p_val THEN EXECUTE p_sql INTO v; v := coalesce(v, '<null>');
        ELSE EXECUTE p_sql; v := 'ok'; END IF;
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
    END $b$
  $fn$;
  -- A signed-in user's SELECT.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.u(p_uid uuid, p_sql text) RETURNS text LANGUAGE sql AS $b$
      SELECT pg_temp.ic_go('authenticated', p_uid, p_sql, true)
    $b$
  $fn$;
  -- NULL when the check holds, else its label.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ck(p_ok boolean, p_label text) RETURNS text LANGUAGE sql AS $b$
      SELECT CASE WHEN coalesce(p_ok, false) THEN NULL ELSE coalesce(p_label, '(unlabelled, result NULL)') END
    $b$
  $fn$;
  -- Fixture call: the id it returns, or the whole file fails.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.id(p_uid uuid, p_sql text) RETURNS uuid LANGUAGE plpgsql AS $b$
    DECLARE v text := pg_temp.u(p_uid, p_sql);
    BEGIN
      IF v LIKE 'ERROR%' THEN RAISE EXCEPTION 'fixture: % -> %', p_sql, v; END IF;
      RETURN v::uuid;
    END $b$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.q_ch(p_ws uuid, p_kind text, p_name text, p_members uuid[]) RETURNS text LANGUAGE sql AS $b$
      SELECT format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])', p_ws, p_kind, p_name, coalesce(p_members, '{}'))
    $b$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.q_post(p_ch uuid, p_body text, p_share uuid DEFAULT NULL, p_atts jsonb DEFAULT '[]')
    RETURNS text LANGUAGE sql AS $b$
      SELECT format('SELECT public.chat_post_message(%L, %L, NULL, %L::uuid, %L::jsonb)', p_ch, p_body, p_share, p_atts)
    $b$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.q_add(p_ch uuid, p_users uuid[]) RETURNS text LANGUAGE sql AS $b$
      SELECT format('SELECT public.chat_add_members(%L, %L::uuid[])', p_ch, p_users)
    $b$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.q_role(p_ch uuid, p_user uuid, p_role text) RETURNS text LANGUAGE sql AS $b$
      SELECT format('SELECT public.chat_set_member_role(%L, %L, %L)', p_ch, p_user, p_role)
    $b$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.q_leave(p_ch uuid) RETURNS text LANGUAGE sql AS $b$
      SELECT format('SELECT public.chat_leave_channel(%L)', p_ch)
    $b$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.q_dm(p_ws uuid, p_members uuid[]) RETURNS text LANGUAGE sql AS $b$
      SELECT format('SELECT public.chat_open_dm(%L, %L::uuid[])', p_ws, p_members)
    $b$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.q_n(p_table text, p_col text, p_id uuid) RETURNS text LANGUAGE sql AS $b$
      SELECT format('SELECT count(*) FROM public.%I WHERE %I = %L', p_table, p_col, p_id)
    $b$
  $fn$;

  -- ---------- fixture: account A (every role), account B ----------
  INSERT INTO auth.users (id, email)
  SELECT x, 'ic-' || x || '@example.invalid'
    FROM unnest(ARRAY[u_owner, u_admin, u_sup, u_rm, u_rm2, u_ag, u_guest, u_vic, u_x, u_g,
                      u_two, u_dead, u_pown, u_psup, u_prm]) x
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b FROM profiles WHERE user_id = u_pown;
  IF a IS NULL OR b IS NULL OR a = b THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a, account_role = 'team_leader' WHERE user_id = u_sup;
  UPDATE profiles SET account_id = a, account_role = 'agent'
   WHERE user_id IN (u_rm, u_rm2, u_vic, u_x, u_g, u_two, u_dead);
  UPDATE profiles SET account_id = a, account_role = 'viewer' WHERE user_id = u_ag;
  UPDATE profiles SET account_id = a, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;
  UPDATE profiles SET account_id = b, account_role = 'team_leader' WHERE user_id = u_psup;
  UPDATE profiles SET account_id = b, account_role = 'agent' WHERE user_id = u_prm;
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_dead;
  INSERT INTO profiles (user_id, account_id, account_role, email, full_name, is_active)
  VALUES (u_two, b, 'agent', 'ic-two-b@example.invalid', 'IC two (B)', false);

  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_rm, '971500087201', 'IC c1') RETURNING id INTO uu;
  INSERT INTO conversations (account_id, contact_id, user_id) VALUES (a, uu, u_rm) RETURNING id INTO conv_rm;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_rm2, '971500087202', 'IC c2') RETURNING id INTO uu;
  INSERT INTO conversations (account_id, contact_id, user_id) VALUES (a, uu, u_rm2) RETURNING id INTO conv_rm2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_two, '971500087203', 'IC c3') RETURNING id INTO uu;
  INSERT INTO conversations (account_id, contact_id, user_id) VALUES (a, uu, u_two) RETURNING id INTO conv_two;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b, u_psup, '971500087204', 'IC c4') RETURNING id INTO uu;
  INSERT INTO conversations (account_id, contact_id, user_id) VALUES (b, uu, u_psup) RETURNING id INTO conv_p;

  -- A deal room (opened by a later migration's functions): staff + a guest.
  INSERT INTO chat_channels (account_id, kind, name, created_by)
  VALUES (a, 'deal_room', 'IC deal', u_owner) RETURNING id INTO deal;
  INSERT INTO chat_channel_members (channel_id, user_id, role)
  VALUES (deal, u_owner, 'admin'), (deal, u_rm, 'member'), (deal, u_guest, 'guest');

  -- ---------- saved messages ----------
  ch := pg_temp.id(u_rm, pg_temp.q_ch(a, 'team', 'ic-save', NULL));
  m := pg_temp.id(u_rm, pg_temp.q_post(ch, 'save me'));
  r := pg_temp.u(u_ag, format('SELECT public.chat_set_saved(%L, true)', m));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%'
    AND pg_temp.u(u_ag, 'SELECT string_agg(message_id::text, '','') FROM public.saved_messages') = m::text,
    'saved: the saver sees exactly their row: ' || r);
  n := n+1; failed := failed || pg_temp.ck(pg_temp.u(u_rm, pg_temp.q_n('saved_messages', 'message_id', m)) = '0'
    AND pg_temp.u(u_owner, pg_temp.q_n('saved_messages', 'message_id', m)) = '0',
    'saved: another user (author, owner) sees the row');
  ch2 := pg_temp.id(u_rm, pg_temp.q_ch(a, 'private', 'ic-save-priv', NULL));
  m2 := pg_temp.id(u_rm, pg_temp.q_post(ch2, 'hidden'));
  r := pg_temp.u(u_ag, format('SELECT public.chat_set_saved(%L, true)', m2));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%message not found%', 'saved: unreadable message: ' || r);
  r := pg_temp.u(u_ag, format('SELECT public.chat_set_saved(%L, false)', m));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%'
    AND NOT EXISTS (SELECT 1 FROM saved_messages WHERE message_id = m), 'saved: unsave: ' || r);

  -- ---------- reactions ----------
  r := pg_temp.u(u_ag, format('SELECT public.chat_toggle_reaction(%L, %L)', m, '+1'));
  n := n+1; failed := failed || pg_temp.ck(r = 'true' AND pg_temp.u(u_rm2, format(
    'SELECT count(*) FROM public.internal_message_reactions WHERE message_id = %L AND user_id = %L AND emoji = %L',
    m, u_ag, '+1')) = '1', 'reaction: toggled on, visible to a reader: ' || r);
  r := pg_temp.u(u_ag, format('SELECT public.chat_toggle_reaction(%L, %L)', m, '+1'));
  n := n+1; failed := failed || pg_temp.ck(r = 'false'
    AND NOT EXISTS (SELECT 1 FROM internal_message_reactions WHERE message_id = m), 'reaction: toggled off: ' || r);
  r := pg_temp.u(u_ag, format('SELECT public.chat_toggle_reaction(%L, %L)', m, repeat('x', 33)));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 23514:%', 'reaction: 33-char emoji: ' || r);
  r := pg_temp.u(u_guest, format('SELECT public.chat_toggle_reaction(%L, %L)', m, '+1'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%message not found%', 'reaction: bank guest on a team message: ' || r);

  -- ---------- pins: at most 100 per channel ----------
  FOR i IN 1..101 LOOP
    ids := ids || pg_temp.id(u_rm, pg_temp.q_post(ch, 'pin ' || i));
  END LOOP;
  FOR i IN 1..100 LOOP
    r := pg_temp.u(u_rm, format('SELECT public.chat_set_pin(%L, true)', ids[i]));
    EXIT WHEN r LIKE 'ERROR%';
  END LOOP;
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%', 'pins: pinning 100: ' || r);
  r := pg_temp.u(u_rm, format('SELECT public.chat_set_pin(%L, true)', ids[101]));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%at most 100 pins%', 'pins: the 101st: ' || r);
  r := pg_temp.u(u_rm, format('SELECT public.chat_set_pin(%L, false)', ids[1]))
    || '|' || pg_temp.u(u_rm, format('SELECT public.chat_set_pin(%L, true)', ids[101]));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE '%ERROR%'
    AND (SELECT count(*) FROM message_pins WHERE channel_id = ch) = 100, 'pins: unpinning frees a slot: ' || r);

  -- ---------- chat_add_members (D-B1) ----------
  ch := pg_temp.id(u_rm, pg_temp.q_ch(a, 'private', 'ic-add-priv', NULL));
  r := pg_temp.u(u_rm, pg_temp.q_add(ch, ARRAY[u_rm2, u_ag, u_ag]));
  n := n+1; failed := failed || pg_temp.ck(r = '2'
    AND pg_temp.u(u_rm2, pg_temp.q_n('chat_channels', 'id', ch)) = '1', 'add: channel admin adds two: ' || r);
  n := n+1; failed := failed || pg_temp.ck((SELECT count(*) = 1 AND bool_and(actor_id = u_rm)
      AND bool_and(detail->'user_ids' @> to_jsonb(ARRAY[u_rm2, u_ag]) AND jsonb_array_length(detail->'user_ids') = 2)
    FROM chat_audit_log WHERE channel_id = ch AND action = 'add_members'), 'add: audit row');
  r := pg_temp.u(u_rm, pg_temp.q_add(ch, ARRAY[u_guest]));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%only owner/admin/supervisor can add bank guests%', 'add: agent adds a guest: ' || r);
  r := pg_temp.u(u_sup, pg_temp.q_add(ch, ARRAY[u_guest]));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%only members of a private channel%', 'add: non-member supervisor adds a guest: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_add(ch, ARRAY[u_sup])) || '/' || pg_temp.u(u_sup, pg_temp.q_add(ch, ARRAY[u_guest]))
    || '/' || pg_temp.u(u_rm, pg_temp.q_add(ch, ARRAY[u_rm2]));
  n := n+1; failed := failed || pg_temp.ck(r = '1/1/0'
    AND (SELECT role FROM chat_channel_members WHERE channel_id = ch AND user_id = u_guest) = 'guest',
    'add: member supervisor adds a guest (role guest), re-add is 0: ' || r);
  ch := pg_temp.id(u_sup, pg_temp.q_ch(a, 'private', 'ic-add-deny', ARRAY[u_rm, u_guest]));
  r := pg_temp.u(u_rm, pg_temp.q_add(ch, ARRAY[u_ag]));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%only channel admins%', 'add: plain member adds: ' || r);
  r := pg_temp.u(u_ag, pg_temp.q_add(ch, ARRAY[u_ag]));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%only members of a private channel%', 'add: outsider adds: ' || r);
  r := pg_temp.u(u_guest, pg_temp.q_add(ch, ARRAY[u_ag]));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%bank guests cannot add members%', 'add: guest adds: ' || r);
  ch := pg_temp.id(u_rm, pg_temp.q_ch(a, 'team', 'ic-add-team', NULL));
  r := pg_temp.u(u_ag, pg_temp.q_add(ch, ARRAY[u_rm2]));
  n := n+1; failed := failed || pg_temp.ck(r = '1', 'add: any non-guest adds to a team channel: ' || r);
  r := pg_temp.u(u_owner, pg_temp.q_add(ch, ARRAY[u_guest]));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%cannot be added to team channels%'
    AND pg_temp.u(u_guest, pg_temp.q_n('chat_channels', 'id', ch)) = '0', 'add: guest into a team channel: ' || r);
  dm := pg_temp.id(u_rm, pg_temp.q_dm(a, ARRAY[u_ag]));
  r := pg_temp.u(u_rm, pg_temp.q_add(dm, ARRAY[u_rm2]));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%open a new DM instead%', 'add: into a DM: ' || r);
  ch := pg_temp.id(u_owner, pg_temp.q_ch(a, 'private', 'ic-add-ws', NULL));
  r := pg_temp.u(u_owner, pg_temp.q_add(ch, ARRAY[u_prm]));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%active member of this workspace%', 'add: another account''s user: ' || r);
  r := pg_temp.u(u_owner, pg_temp.q_add(ch, ARRAY[u_dead]));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%active member of this workspace%', 'add: a deactivated member: ' || r);
  r := pg_temp.u(u_pown, pg_temp.q_add(ch, ARRAY[u_prm]));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%not a member of this workspace%', 'add: by another account''s owner: ' || r);
  r := pg_temp.u(u_owner, pg_temp.q_add(ch, '{}'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%no users given%', 'add: empty list: ' || r);
  r := pg_temp.u(u_owner, pg_temp.q_add(deal, ARRAY[u_rm2]));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%deal room members are managed from the deal%'
    AND NOT EXISTS (SELECT 1 FROM chat_channel_members WHERE channel_id = deal AND user_id = u_rm2), 'add: into a deal room: ' || r);

  -- ---------- chat_leave_channel ----------
  ch := pg_temp.id(u_rm, pg_temp.q_ch(a, 'private', 'ic-leave', ARRAY[u_rm2]));
  r := pg_temp.u(u_rm2, pg_temp.q_leave(ch));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%'
    AND pg_temp.u(u_rm2, pg_temp.q_n('chat_channels', 'id', ch)) = '0', 'leave: member leaves and loses the channel: ' || r);
  r := pg_temp.u(u_rm2, pg_temp.q_leave(ch));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%not a member of this channel%', 'leave: twice: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_leave(ch));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%last admin of a private channel%', 'leave: last private admin: ' || r);
  ch := pg_temp.id(u_rm, pg_temp.q_ch(a, 'team', 'ic-leave-team', ARRAY[u_ag]));
  r := pg_temp.u(u_rm, pg_temp.q_leave(ch));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%'
    AND NOT EXISTS (SELECT 1 FROM chat_channel_members WHERE channel_id = ch AND user_id = u_rm), 'leave: team creator leaves: ' || r);
  dm := pg_temp.id(u_rm2, pg_temp.q_dm(a, ARRAY[u_ag]));
  PERFORM pg_temp.id(u_rm2, pg_temp.q_post(dm, 'before leaving'));
  r := pg_temp.u(u_ag, pg_temp.q_leave(dm));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%'
    AND pg_temp.u(u_ag, pg_temp.q_n('internal_messages', 'channel_id', dm)) = '0', 'leave: DM leaver loses the history: ' || r);
  r := pg_temp.u(u_rm2, pg_temp.q_leave(dm));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%last member cannot leave a DM%', 'leave: last DM member: ' || r);
  r := pg_temp.u(u_ag, pg_temp.q_dm(a, ARRAY[u_rm2]));
  PERFORM pg_temp.id(u_ag, pg_temp.q_post(dm, 'back again'));
  n := n+1; failed := failed || pg_temp.ck(r = dm::text
    AND pg_temp.u(u_ag, pg_temp.q_n('internal_messages', 'channel_id', dm)) = '2', 'leave: reopening the DM brings the leaver back: ' || r);

  -- ---------- chat_set_member_role ----------
  ch := pg_temp.id(u_rm, pg_temp.q_ch(a, 'private', 'ic-succ', ARRAY[u_rm2]));
  r := pg_temp.u(u_rm, pg_temp.q_role(ch, u_rm2, 'admin'));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%'
    AND (SELECT role FROM chat_channel_members WHERE channel_id = ch AND user_id = u_rm2) = 'admin'
    AND (SELECT count(*) = 1 AND bool_and(actor_id = u_rm
           AND detail = jsonb_build_object('user_id', u_rm2, 'from', 'member', 'to', 'admin'))
           FROM chat_audit_log WHERE channel_id = ch AND action = 'set_member_role'),
    'role: promote a successor (audited): ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_leave(ch));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%'
    AND NOT EXISTS (SELECT 1 FROM chat_channel_members WHERE channel_id = ch AND user_id = u_rm), 'role: former last admin leaves: ' || r);
  r := pg_temp.u(u_rm2, pg_temp.q_role(ch, u_rm2, 'member'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%last admin of a private channel cannot be demoted%', 'role: last admin demotes self: ' || r);
  ch := pg_temp.id(u_rm, pg_temp.q_ch(a, 'private', 'ic-roles', ARRAY[u_rm2, u_ag, u_sup]));
  r := pg_temp.u(u_rm2, pg_temp.q_role(ch, u_ag, 'admin')) || '|' || pg_temp.u(u_sup, pg_temp.q_role(ch, u_ag, 'admin'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%only channel admins can change roles in a private channel%|ERROR%only channel admins can change roles in a private channel%',
    'role: plain member / member supervisor: ' || r);
  r := pg_temp.u(u_pown, pg_temp.q_role(ch, u_ag, 'admin'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%not a member of this workspace%', 'role: outsider: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_role(ch, u_ag, 'admin')) || '|' || pg_temp.u(u_ag, pg_temp.q_role(ch, u_ag, 'member'));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE '%ERROR%'
    AND (SELECT role FROM chat_channel_members WHERE channel_id = ch AND user_id = u_ag) = 'member', 'role: promote then self-demote: ' || r);
  ch2 := pg_temp.id(u_rm, pg_temp.q_ch(a, 'team', 'ic-roles-team', ARRAY[u_ag]));
  r := pg_temp.u(u_rm, pg_temp.q_role(ch2, u_ag, 'admin'));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%'
    AND (SELECT role FROM chat_channel_members WHERE channel_id = ch2 AND user_id = u_ag) = 'admin', 'role: team channel: ' || r);
  dm := pg_temp.id(u_rm, pg_temp.q_dm(a, ARRAY[u_ag]));
  r := pg_temp.u(u_owner, pg_temp.q_role(dm, u_ag, 'admin'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%have no settable roles%', 'role: DM: ' || r);
  r := pg_temp.u(u_owner, pg_temp.q_role(deal, u_rm, 'admin'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%have no settable roles%'
    AND (SELECT role FROM chat_channel_members WHERE channel_id = deal AND user_id = u_rm) = 'member', 'role: deal room: ' || r);
  ch := pg_temp.id(u_owner, pg_temp.q_ch(a, 'private', 'ic-guest-role', ARRAY[u_guest, u_rm]));
  r := pg_temp.u(u_owner, pg_temp.q_role(ch, u_guest, 'admin')) || '|' || pg_temp.u(u_owner, pg_temp.q_role(ch, u_guest, 'member'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%guest''s role cannot be changed%|ERROR%guest''s role cannot be changed%'
    AND (SELECT role FROM chat_channel_members WHERE channel_id = ch AND user_id = u_guest) = 'guest', 'role: a guest: ' || r);
  r := pg_temp.u(u_owner, pg_temp.q_role(ch, u_ag, 'admin'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%not a member of this channel%', 'role: non-member target: ' || r);
  r := pg_temp.u(u_owner, pg_temp.q_role(ch, u_rm, 'guest'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%role must be admin or member%', 'role: unknown role: ' || r);
  r := pg_temp.u(u_owner, pg_temp.q_role(gen_random_uuid(), u_rm, 'admin'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%channel not found%', 'role: unknown channel: ' || r);
  -- Disabled chat: CH001 on every write path.
  ch := pg_temp.id(u_rm, pg_temp.q_ch(a, 'team', 'ic-disabled', ARRAY[u_ag]));
  UPDATE accounts SET internal_chat_enabled = false WHERE id = a;
  r := pg_temp.u(u_rm, pg_temp.q_role(ch, u_ag, 'admin')) || '|' || pg_temp.u(u_rm, pg_temp.q_post(ch, 'x'))
    || '|' || pg_temp.u(u_rm, pg_temp.q_ch(a, 'team', 'ic-disabled-2', NULL));
  UPDATE accounts SET internal_chat_enabled = true WHERE id = a;
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR CH001:%|ERROR CH001:%|ERROR CH001:%', 'disabled chat is not CH001 everywhere: ' || r);

  -- ---------- F1: no self-service into a private channel ----------
  ch := pg_temp.id(u_rm, pg_temp.q_ch(a, 'private', 'ic-f1', ARRAY[u_rm2]));
  FOREACH uu IN ARRAY ARRAY[u_sup, u_admin, u_owner] LOOP
    r := pg_temp.u(uu, pg_temp.q_add(ch, ARRAY[uu]));
    n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%only members of a private channel%'
      AND pg_temp.u(uu, pg_temp.q_n('chat_channels', 'id', ch)) = '0', 'F1: adds self to a private channel: ' || r);
  END LOOP;
  r := pg_temp.u(u_admin, pg_temp.q_role(ch, u_rm2, 'admin')) || '|' || pg_temp.u(u_owner, pg_temp.q_role(ch, u_rm2, 'admin'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%only channel admins can change roles in a private channel%|ERROR%only channel admins can change roles in a private channel%'
    AND (SELECT role FROM chat_channel_members WHERE channel_id = ch AND user_id = u_rm2) = 'member',
    'F1: non-member owner/admin sets a role: ' || r);

  -- ---------- F3: sharing stays in the conversation's account ----------
  ch := pg_temp.id(u_psup, pg_temp.q_ch(b, 'private', 'ic-f3', NULL));
  r := pg_temp.u(u_psup, pg_temp.q_post(ch, 'peek', conv_rm)) || '|' || pg_temp.u(u_psup, pg_temp.q_post(ch, 'peek', conv_rm2));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%cannot share this conversation%|ERROR%cannot share this conversation%', 'F3: share another account''s conversation: ' || r);
  r := pg_temp.u(u_psup, pg_temp.q_post(ch, 'own account', conv_p));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%'
    AND (SELECT count(*) FROM shared_conversations WHERE message_id::text = r) = 1, 'F3: share own conversation: ' || r);

  -- ---------- F7 / R2-2: demotion to bank_guest ----------
  ch := pg_temp.id(u_rm, pg_temp.q_ch(a, 'team', 'ic-f7', ARRAY[u_x]));
  PERFORM pg_temp.id(u_rm, pg_temp.q_post(ch, 'before demotion'));
  dm := pg_temp.id(u_rm, pg_temp.q_dm(a, ARRAY[u_x]));
  PERFORM pg_temp.id(u_rm, pg_temp.q_post(dm, 'dm before demotion'));
  ch2 := pg_temp.id(u_x, pg_temp.q_ch(a, 'private', 'ic-f7-priv', ARRAY[u_ag]));
  n := n+1; failed := failed || pg_temp.ck(pg_temp.u(u_x, pg_temp.q_n('internal_messages', 'channel_id', ch)) = '1', 'F7: fixture: reads before demotion');
  UPDATE profiles SET account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_x;
  r := pg_temp.u(u_x, pg_temp.q_post(ch, 'still here')) || '|' || pg_temp.u(u_x, pg_temp.q_post(dm, 'still here'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%not a member of this channel%|ERROR%not a member of this channel%', 'F7: demoted posts: ' || r);
  n := n+1; failed := failed || pg_temp.ck(pg_temp.u(u_x, pg_temp.q_n('internal_messages', 'channel_id', ch)) = '0'
    AND pg_temp.u(u_x, pg_temp.q_n('internal_messages', 'channel_id', dm)) = '0', 'F7: demoted still reads team channel / DM');
  r := pg_temp.u(u_x, pg_temp.q_add(ch2, ARRAY[u_rm2]));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%bank guests cannot add members%', 'F7: demoted admin adds: ' || r);
  r := pg_temp.u(u_x, pg_temp.q_role(ch2, u_ag, 'admin'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%bank guests cannot change roles%'
    AND (SELECT role FROM chat_channel_members WHERE channel_id = ch2 AND user_id = u_ag) = 'member', 'F7: demoted admin sets a role: ' || r);
  ch := pg_temp.id(u_rm, pg_temp.q_ch(a, 'private', 'ic-r22', ARRAY[u_g, u_ag]));
  PERFORM pg_temp.u(u_rm, pg_temp.q_role(ch, u_g, 'admin'));
  UPDATE profiles SET account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_g;
  r := pg_temp.u(u_rm, pg_temp.q_leave(ch));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%last admin of a private channel cannot leave%', 'R2-2: leave beside a demoted admin: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_role(ch, u_rm, 'member'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%last admin of a private channel cannot be demoted%'
    AND (SELECT role FROM chat_channel_members WHERE channel_id = ch AND user_id = u_rm) = 'admin', 'R2-2: demote beside a demoted admin: ' || r);

  -- ---------- F8: delete cleans up and returns storage paths ----------
  ch := pg_temp.id(u_rm, pg_temp.q_ch(a, 'team', 'ic-f8', ARRAY[u_ag]));
  m := pg_temp.id(u_rm, pg_temp.q_post(ch, format('<@%s> @channel see card', u_ag), conv_rm));
  INSERT INTO message_attachments (message_id, storage_path, name, mime, bytes)
  VALUES (m, 'chat/f8/b.png', 'b.png', 'image/png', 1), (m, 'chat/f8/a.pdf', 'a.pdf', 'application/pdf', 1);
  n := n+1; failed := failed || pg_temp.ck(EXISTS (SELECT 1 FROM message_mentions WHERE message_id = m)
    AND EXISTS (SELECT 1 FROM message_mentions_broadcast WHERE message_id = m)
    AND EXISTS (SELECT 1 FROM shared_conversations WHERE message_id = m)
    AND EXISTS (SELECT 1 FROM notifications WHERE meta->>'message_id' = m::text), 'F8: fixture rows missing');
  r := pg_temp.u(u_rm, format('SELECT public.chat_delete_message(%L)', m));
  n := n+1; failed := failed || pg_temp.ck(r = '{chat/f8/a.pdf,chat/f8/b.png}', 'F8: delete returns the paths: ' || r);
  n := n+1; failed := failed || pg_temp.ck(NOT EXISTS (SELECT 1 FROM message_mentions WHERE message_id = m)
    AND NOT EXISTS (SELECT 1 FROM message_mentions_broadcast WHERE message_id = m)
    AND NOT EXISTS (SELECT 1 FROM shared_conversations WHERE message_id = m)
    AND NOT EXISTS (SELECT 1 FROM message_attachments WHERE message_id = m)
    AND NOT EXISTS (SELECT 1 FROM notifications WHERE meta->>'message_id' = m::text), 'F8: delete left mentions/cards/files/bell rows');
  r := pg_temp.u(u_rm, format('SELECT public.chat_delete_message(%L)', m));
  n := n+1; failed := failed || pg_temp.ck(r = '{}', 'F8: second delete: ' || r);

  -- ---------- F9: a new member starts with nothing unread ----------
  ch := pg_temp.id(u_rm, pg_temp.q_ch(a, 'team', 'ic-f9', NULL));
  PERFORM pg_temp.id(u_rm, pg_temp.q_post(ch, 'old 1'));
  PERFORM pg_temp.id(u_rm, pg_temp.q_post(ch, format('old 2 <@%s>', u_ag)));
  t := format('SELECT unread || '','' || mentions FROM public.chat_unread_counts(%L) WHERE channel_id = %L', a, ch);
  r := pg_temp.u(u_rm, pg_temp.q_add(ch, ARRAY[u_ag])) || '|' || pg_temp.u(u_ag, t);
  n := n+1; failed := failed || pg_temp.ck(r = '1|0,0', 'F9: added member''s unread: ' || r);
  -- The package's "a later post is unread" half is not portable: one
  -- transaction freezes now(), so that post shares joined_at.

  -- ---------- attachments and the chat-files bucket ----------
  ch := pg_temp.id(u_rm, pg_temp.q_ch(a, 'team', 'ic-files', ARRAY[u_rm2]));
  ch2 := pg_temp.id(u_rm, pg_temp.q_ch(a, 'private', 'ic-files-priv', ARRAY[u_ag]));
  p1 := format('account-%s/channel-%s/%s-a.pdf', a, ch, gen_random_uuid());
  t := format('account-%s/channel-%s/%s-b.pdf', a, ch2, gen_random_uuid());
  INSERT INTO storage.objects (bucket_id, name) VALUES ('chat-files', p1), ('chat-files', t);
  atts := jsonb_build_array(jsonb_build_object('storage_path', p1, 'name', 'a.pdf', 'mime', 'application/pdf', 'bytes', 10));
  r := pg_temp.u(u_rm2, pg_temp.q_post(ch, 'file', NULL, atts));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%'
    AND EXISTS (SELECT 1 FROM message_attachments WHERE message_id::text = r AND storage_path = p1 AND bytes = 10),
    'attachments: member posts an uploaded file: ' || r);
  r := pg_temp.u(u_rm2, pg_temp.q_post(ch, 'x', NULL, jsonb_set(atts, '{0,storage_path}', to_jsonb(t))));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%attachment path must be%', 'attachments: another channel''s path: ' || r);
  r := pg_temp.u(u_rm2, pg_temp.q_post(ch, 'x', NULL, jsonb_set(atts, '{0,storage_path}',
         to_jsonb(format('account-%s/channel-%s/%s-gone.pdf', a, ch, gen_random_uuid())))));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%was not uploaded%', 'attachments: missing object: ' || r);
  r := pg_temp.u(u_rm2, pg_temp.q_post(ch, 'x', NULL, jsonb_set(atts, '{0,bytes}', '26214401')));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%at most 25 MB%', 'attachments: oversize: ' || r);
  r := pg_temp.u(u_rm2, pg_temp.q_post(ch, 'x', NULL, (SELECT jsonb_agg(atts->0) FROM generate_series(1, 11))));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%at most 10 items%', 'attachments: 11 files: ' || r);
  -- Download: readers of the channel only.
  r := format('SELECT count(*) FROM storage.objects WHERE bucket_id = %L AND name = %L', 'chat-files', t);
  n := n+1; failed := failed || pg_temp.ck(pg_temp.u(u_rm2, r) = '0', 'storage: a non-member reads a private channel''s file');
  n := n+1; failed := failed || pg_temp.ck(pg_temp.u(u_ag, r) = '1', 'storage: a member cannot read the channel''s file');
  -- Upload: posters of the channel only.
  r := pg_temp.ic_go('authenticated', u_ag, format('INSERT INTO storage.objects (bucket_id, name) VALUES (%L, %L)',
         'chat-files', format('account-%s/channel-%s/%s-up.pdf', a, ch2, gen_random_uuid())), false);
  n := n+1; failed := failed || pg_temp.ck(r = 'ok', 'storage: member upload: ' || r);
  r := pg_temp.ic_go('authenticated', u_rm2, format('INSERT INTO storage.objects (bucket_id, name) VALUES (%L, %L)',
         'chat-files', format('account-%s/channel-%s/%s-up.pdf', a, ch2, gen_random_uuid())), false);
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501:%', 'storage: non-member upload: ' || r);
  -- Deal room: a guest sees the room, never its notes or files.
  t := format('account-%s/channel-%s/%s-deal.pdf', a, deal, gen_random_uuid());
  INSERT INTO storage.objects (bucket_id, name) VALUES ('chat-files', t);
  PERFORM pg_temp.id(u_rm, pg_temp.q_post(deal, 'deal note'));
  r := format('SELECT count(*) FROM storage.objects WHERE bucket_id = %L AND name = %L', 'chat-files', t);
  n := n+1; failed := failed || pg_temp.ck(pg_temp.u(u_guest, r) = '0' AND pg_temp.u(u_rm, r) = '1', 'storage: deal room file visibility (guest 0, staff 1)');
  n := n+1; failed := failed || pg_temp.ck(pg_temp.u(u_guest, pg_temp.q_n('chat_channels', 'id', deal)) = '1'
    AND pg_temp.u(u_guest, pg_temp.q_n('internal_messages', 'channel_id', deal)) = '0', 'deal room: guest sees the room but not its notes');
  r := pg_temp.ic_go('authenticated', u_guest, format('INSERT INTO storage.objects (bucket_id, name) VALUES (%L, %L)',
         'chat-files', format('account-%s/channel-%s/%s-g.pdf', a, deal, gen_random_uuid())), false);
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501:%', 'storage: guest upload into a deal room: ' || r);

  -- ---------- chat_admin_read_private (audited before it returns) ----------
  ch := pg_temp.id(u_rm, pg_temp.q_ch(a, 'private', 'ic-audit', NULL));
  r := pg_temp.u(u_owner, format('SELECT count(*) FROM public.chat_admin_read_private(%L, %L)', ch, 'audit test'));
  n := n+1; failed := failed || pg_temp.ck(r = '0' AND EXISTS (SELECT 1 FROM chat_audit_log WHERE channel_id = ch
    AND action = 'admin_read_private' AND actor_id = u_owner AND detail->>'reason' = 'audit test'), 'admin read: audit row: ' || r);
  r := pg_temp.u(u_owner, format('SELECT count(*) FROM public.chat_admin_read_private(%L, %L)', ch, ' abc '));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%reason of at least 5%'
    AND (SELECT count(*) FROM chat_audit_log WHERE channel_id = ch AND action = 'admin_read_private') = 1, 'admin read: short reason: ' || r);
  r := pg_temp.u(u_rm2, format('SELECT count(*) FROM public.chat_admin_read_private(%L, %L)', ch, 'looking around'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%owner or admin role required%', 'admin read: by an agent: ' || r);
  r := pg_temp.u(u_owner, format('SELECT string_agg(body, ''|'') FROM public.chat_admin_read_private(%L, %L)', deal, 'deal review'));
  n := n+1; failed := failed || pg_temp.ck(r = 'deal note' AND EXISTS (SELECT 1 FROM chat_audit_log WHERE channel_id = deal
    AND action = 'admin_read_private' AND detail->>'reason' = 'deal review'), 'admin read: deal room: ' || r);

  -- ---------- append-only audit log and edit history ----------
  r := pg_temp.ic_go(NULL, NULL, format('UPDATE public.chat_audit_log SET detail = ''{}'' WHERE channel_id = %L', ch), false)
    || '|' || pg_temp.ic_go(NULL, NULL, format('DELETE FROM public.chat_audit_log WHERE channel_id = %L', ch), false);
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%append-only%|ERROR%append-only%', 'audit log: superuser UPDATE/DELETE: ' || r);
  m := pg_temp.id(u_rm, pg_temp.q_post(ch, 'a'));
  PERFORM pg_temp.u(u_rm, format('SELECT public.chat_edit_message(%L, %L)', m, 'b'));
  n := n+1; failed := failed || pg_temp.ck((SELECT string_agg(previous_body, '|') FROM internal_message_edits WHERE message_id = m) = 'a',
    'edit history: fixture');
  r := pg_temp.ic_go(NULL, NULL, format('UPDATE public.internal_message_edits SET previous_body = ''x'' WHERE message_id = %L', m), false)
    || '|' || pg_temp.ic_go(NULL, NULL, format('DELETE FROM public.internal_message_edits WHERE message_id = %L', m), false);
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%append-only%|ERROR%append-only%', 'edit history: superuser UPDATE/DELETE: ' || r);
  -- The erase switch is no key for a client.
  PERFORM set_config('chat.erase', 'on', true);
  r := pg_temp.ic_go('authenticated', u_owner, format('DELETE FROM public.internal_message_edits WHERE message_id = %L', m), false)
    || '|' || pg_temp.ic_go('service_role', NULL, format('DELETE FROM public.internal_message_edits WHERE message_id = %L', m), false);
  PERFORM set_config('chat.erase', 'off', true);
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501: permission denied%|ERROR 42501: permission denied%'
    AND EXISTS (SELECT 1 FROM internal_message_edits WHERE message_id = m), 'edit history: client DELETE with chat.erase on: ' || r);
  -- chat_delete_message keeps the history (only erasure removes it).
  PERFORM pg_temp.u(u_rm, format('SELECT public.chat_delete_message(%L)', m));
  n := n+1; failed := failed || pg_temp.ck((SELECT count(*) FROM internal_message_edits WHERE message_id = m) = 2,
    'edit history: chat_delete_message removed history');

  -- ---------- privileges and RLS on every chat table ----------
  FOREACH t IN ARRAY tables LOOP
    SELECT column_name INTO col FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = t ORDER BY ordinal_position LIMIT 1;
    r := pg_temp.ic_go('authenticated', u_owner, format('INSERT INTO public.%I DEFAULT VALUES', t), false)
      || '|' || pg_temp.ic_go('authenticated', u_owner, format('UPDATE public.%I SET %I = %I', t, col, col), false)
      || '|' || pg_temp.ic_go('authenticated', u_owner, format('DELETE FROM public.%I', t), false)
      || '|' || pg_temp.ic_go('service_role', NULL, format('INSERT INTO public.%I DEFAULT VALUES', t), false)
      || '|' || pg_temp.ic_go('service_role', NULL, format('UPDATE public.%I SET %I = %I', t, col, col), false)
      || '|' || pg_temp.ic_go('service_role', NULL, format('DELETE FROM public.%I', t), false)
      || '|' || pg_temp.ic_go('anon', NULL, format('SELECT 1 FROM public.%I LIMIT 1', t), false);
    n := n+1; failed := failed || pg_temp.ck(r = rtrim(repeat('ERROR 42501: permission denied for table ' || t || '|', 7), '|'),
      t || ': a direct write (authenticated/service_role) or anon read: ' || r);
    r := pg_temp.ic_go(NULL, NULL, format('TRUNCATE public.%I CASCADE', t), false);
    n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%cannot be truncated%', t || ': superuser TRUNCATE: ' || r);
    n := n+1; failed := failed || pg_temp.ck((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
      WHERE oid = format('public.%I', t)::regclass), t || ': RLS not enabled and forced');
  END LOOP;
  ch := pg_temp.id(u_rm, pg_temp.q_ch(a, 'team', 'ic-svc', NULL));
  PERFORM pg_temp.id(u_rm, pg_temp.q_post(ch, 'visible to service'));
  r := pg_temp.ic_go('service_role', NULL, pg_temp.q_n('internal_messages', 'channel_id', ch), true);
  n := n+1; failed := failed || pg_temp.ck(r = '1', 'service_role reads messages: ' || r);
  n := n+1; failed := failed || pg_temp.ck((SELECT count(*) >= 40 FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'chat\_%' AND p.proname <> 'chat_tags_guard'),
    'fewer than 40 chat functions');
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO r FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'chat\_%' AND p.proname <> 'chat_tags_guard'
     AND (has_function_privilege('anon', p.oid, 'EXECUTE')
          OR coalesce(aclcontains(p.proacl, makeaclitem(0, p.proowner, 'EXECUTE', false)), true));
  n := n+1; failed := failed || pg_temp.ck(r IS NULL, 'anon or PUBLIC may execute: ' || r);
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO r FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'chat\_%' AND p.proname <> 'chat_tags_guard'
     AND has_function_privilege('service_role', p.oid, 'EXECUTE');
  n := n+1; failed := failed || pg_temp.ck(r = 'chat_post_system_message(uuid,text,jsonb)', 'service_role executes: ' || coalesce(r, 'nothing'));
  r := pg_temp.ic_go('anon', NULL, pg_temp.q_dm(a, ARRAY[u_rm]), false)
    || '|' || pg_temp.ic_go('service_role', NULL, format('SELECT public.chat_erase_person(%L, %L, %L)', a, u_rm, 'service purge'), false);
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501: permission denied for function%|ERROR 42501: permission denied for function%',
    'anon DM / service_role erasure: ' || r);
  n := n+1; failed := failed || pg_temp.ck(
        has_function_privilege('authenticated', 'public.chat_add_members(uuid,uuid[])', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.chat_leave_channel(uuid)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.chat_set_member_role(uuid,uuid,text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.chat_assert_can_write(uuid,boolean)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.chat_user_can_read_channel(uuid,uuid,boolean)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.chat_can_view_conversation(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.chat_bell_body(text,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.chat_conversation_snapshot(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.chat_user_role(uuid,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.chat_storage_channel(text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.chat_post_system_message(uuid,text,jsonb)', 'EXECUTE'),
    'authenticated EXECUTE: membership RPCs granted, internal helpers (F3 included) not');
  n := n+1; failed := failed || pg_temp.ck((SELECT count(*) > 50 AND count(*) FILTER (WHERE column_name ~* 'wa_|whatsapp|phone') = 0
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY (tables)),
    'schema: a chat table has a WhatsApp or phone column');

  -- ---------- chat_erase_person ----------
  ch := pg_temp.id(u_rm, pg_temp.q_ch(a, 'team', 'ic-erase', ARRAY[u_vic]));
  m1 := pg_temp.id(u_vic, pg_temp.q_post(ch, 'personal data here'));
  PERFORM pg_temp.u(u_vic, format('SELECT public.chat_edit_message(%L, %L)', m1, 'personal data edited'));
  m2 := pg_temp.id(u_vic, pg_temp.q_post(ch, 'to be deleted'));
  PERFORM pg_temp.u(u_vic, format('SELECT public.chat_delete_message(%L)', m2));
  mo := pg_temp.id(u_rm, pg_temp.q_post(ch, format('hello <@%s>', u_vic)));
  m3 := pg_temp.id(u_vic, pg_temp.q_post(ch, format('ping <@%s>', u_rm)));
  PERFORM pg_temp.u(u_vic, format('SELECT public.chat_toggle_reaction(%L, %L)', mo, 'tada'));
  PERFORM pg_temp.u(u_vic, format('SELECT public.chat_set_saved(%L, true)', mo));
  INSERT INTO message_attachments (message_id, storage_path, name, mime, bytes)
  VALUES (m1, 'chat/a.pdf', 'a.pdf', 'application/pdf', 10), (m1, 'chat/b.png', 'b.png', 'image/png', 20);
  ch2 := pg_temp.id(u_prm, pg_temp.q_ch(b, 'team', 'ic-erase-b', NULL));
  mb := pg_temp.id(u_prm, pg_temp.q_post(ch2, 'untouched'));
  SELECT count(*) INTO k FROM internal_messages WHERE author_id = u_vic;
  n := n+1; failed := failed || pg_temp.ck(k = 3
    AND (SELECT count(*) FROM internal_message_edits WHERE message_id IN (m1, m2)) = 2
    AND EXISTS (SELECT 1 FROM message_mentions WHERE user_id = u_vic)
    AND EXISTS (SELECT 1 FROM internal_message_reactions WHERE user_id = u_vic)
    AND EXISTS (SELECT 1 FROM saved_messages WHERE user_id = u_vic)
    AND EXISTS (SELECT 1 FROM chat_notifications WHERE user_id = u_vic)
    AND EXISTS (SELECT 1 FROM notifications WHERE account_id = a AND type LIKE 'chat\_%' AND user_id = u_vic)
    AND EXISTS (SELECT 1 FROM notifications WHERE account_id = a AND type LIKE 'chat\_%' AND actor_user_id = u_vic),
    'erase: fixture rows missing (k=' || k || ')');
  r := pg_temp.u(u_admin, format('SELECT public.chat_erase_person(%L, %L, %L)', a, u_vic, 'lawful request'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%owner role required%', 'erase: by an admin: ' || r);
  r := pg_temp.u(u_owner, format('SELECT public.chat_erase_person(%L, %L, %L)', a, u_vic, 'no'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%reason of at least 5%', 'erase: short reason: ' || r);
  r := pg_temp.u(u_owner, format('SELECT public.chat_erase_person(%L, %L, %L)', a, u_vic, 'lawful request 42'));
  n := n+1; failed := failed || pg_temp.ck(r = '{chat/a.pdf,chat/b.png}', 'erase: returned paths: ' || r);
  n := n+1; failed := failed || pg_temp.ck((SELECT count(*) = k AND bool_and(body = '[erased]' AND erased_at IS NOT NULL AND search IS NULL)
    FROM internal_messages WHERE author_id = u_vic), 'erase: messages not redacted');
  n := n+1; failed := failed || pg_temp.ck(NOT EXISTS (SELECT 1 FROM internal_message_edits WHERE message_id IN (m1, m2, m3)),
    'erase: edit history kept');
  n := n+1; failed := failed || pg_temp.ck(NOT EXISTS (SELECT 1 FROM message_attachments WHERE message_id = m1), 'erase: attachment rows kept');
  n := n+1; failed := failed || pg_temp.ck(NOT EXISTS (SELECT 1 FROM message_mentions WHERE user_id = u_vic)
    AND NOT EXISTS (SELECT 1 FROM internal_message_reactions WHERE user_id = u_vic)
    AND NOT EXISTS (SELECT 1 FROM saved_messages WHERE user_id = u_vic)
    AND NOT EXISTS (SELECT 1 FROM chat_notifications WHERE user_id = u_vic), 'erase: mentions/reactions/saved/notifications kept');
  n := n+1; failed := failed || pg_temp.ck(NOT EXISTS (SELECT 1 FROM notifications WHERE account_id = a
    AND type LIKE 'chat\_%' AND (user_id = u_vic OR actor_user_id = u_vic)), 'erase: bell rows kept');
  n := n+1; failed := failed || pg_temp.ck((SELECT body FROM internal_messages WHERE id = mb) = 'untouched', 'erase: touched another account');
  n := n+1; failed := failed || pg_temp.ck((SELECT count(*) = 1 AND bool_and(actor_id = u_owner AND detail @> jsonb_build_object(
      'user_id', u_vic, 'reason', 'lawful request 42', 'messages', k, 'attachments', 2))
    FROM chat_audit_log WHERE action = 'erase_person' AND account_id = a), 'erase: audit row');
  n := n+1; failed := failed || pg_temp.ck(current_setting('chat.erase', true) IS DISTINCT FROM 'on', 'erase: left chat.erase on');
  r := pg_temp.ic_go(NULL, NULL, format('DELETE FROM public.internal_message_edits WHERE message_id = %L', m), false);
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%append-only%', 'erase: superuser DELETE right after an erasure: ' || r);
  -- Sequential half of F4 / R2-1: an erased message takes no edit.
  r := pg_temp.u(u_vic, format('SELECT public.chat_edit_message(%L, %L)', m1, 'v3'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%message was deleted%'
    AND NOT EXISTS (SELECT 1 FROM internal_message_edits WHERE message_id = m1), 'erase: erased message edited: ' || r);

  -- ---------- F5: erasure is scoped to the account ----------
  ch := pg_temp.id(u_rm, pg_temp.q_ch(a, 'team', 'ic-f5-a', ARRAY[u_two]));
  ch2 := pg_temp.id(u_prm, pg_temp.q_ch(b, 'team', 'ic-f5-b', ARRAY[u_two]));
  -- F3: u_two may open conv_two, but not share it into account B.
  r := pg_temp.u(u_two, pg_temp.q_post(ch2, 'peek', conv_two));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR%cannot share this conversation%', 'F3: share into another account''s channel: ' || r);
  m1 := pg_temp.id(u_two, pg_temp.q_post(ch, 'a personal', conv_two));
  m2 := pg_temp.id(u_two, pg_temp.q_post(ch2, 'b personal'));
  INSERT INTO message_attachments (message_id, storage_path, name, mime, bytes)
  VALUES (m1, 'chat/f5/a.pdf', 'a.pdf', 'application/pdf', 1), (m2, 'chat/f5/b.pdf', 'b.pdf', 'application/pdf', 1);
  r := pg_temp.u(u_owner, format('SELECT public.chat_erase_person(%L, %L, %L)', a, u_two, 'scoped erasure'));
  n := n+1; failed := failed || pg_temp.ck(r = '{chat/f5/a.pdf}', 'F5: returned paths: ' || r);
  n := n+1; failed := failed || pg_temp.ck((SELECT body FROM internal_messages WHERE id = m1) = '[erased]'
    AND NOT EXISTS (SELECT 1 FROM shared_conversations WHERE message_id = m1)
    AND NOT EXISTS (SELECT 1 FROM message_attachments WHERE message_id = m1), 'F5: account A message not erased');
  n := n+1; failed := failed || pg_temp.ck((SELECT body = 'b personal' AND erased_at IS NULL FROM internal_messages WHERE id = m2)
    AND EXISTS (SELECT 1 FROM message_attachments WHERE message_id = m2), 'F5: erased in account B too');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT872', MESSAGE = 'verify-internal-chat-admin rollback';
  EXCEPTION WHEN SQLSTATE 'ZT872' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'internal chat (admin) verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'internal chat (admin) verification passed (% checks)', n;
END
$verify$;
