-- Behavioural regression suite for group read markers (migration 146).
--
-- whatsapp_group_unread_count() counts the groups of the active
-- workspace the caller sees (114's whatsapp_group_visible_ids), not
-- left, holding an inbound message that arrived (received_at) after the
-- caller's marker; a group with no marker reads as read up to 7 days
-- ago. whatsapp_group_mark_read() moves the caller's marker forward and
-- refuses a group they cannot see. This asserts: the count goes 1 -> 0
-- on mark_read and back to 1 on a later inbound; an outbound message,
-- a left group and an inbound older than 7 days with no marker never
-- count; another person's marker does not clear mine; mark_read refuses
-- a group the caller cannot see and never moves a marker back; clients
-- read only their own markers and write none; the count compares the
-- arrival time, not WhatsApp's send time (created_at), both ways; a
-- team leader counts their team's groups and not another team's; a
-- live row in a workspace the person is not active in counts nothing
-- and cannot be marked; grants and forced RLS.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.
--
-- now() is frozen for the whole transaction, so mark_read stamps the
-- same instant every time here, and a message inserted afterwards gets
-- that same received_at. To have a message arrive after a read, the
-- marker is first moved one second back (the open happened a moment
-- earlier). Fixture messages meant to be old carry received_at =
-- created_at, as 146's backfill gives existing rows.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000146001';
  u_admin UUID := '00000000-0000-4000-8000-000000146002';
  u_maker UUID := '00000000-0000-4000-8000-000000146003';  -- agent, creates g1..go
  u_out   UUID := '00000000-0000-4000-8000-000000146004';  -- agent, sees no group
  u_ab    UUID := '00000000-0000-4000-8000-000000146005';  -- agent, creates ga (check a)
  u_ab2   UUID := '00000000-0000-4000-8000-000000146009';  -- agent, creates gb (check b)
  u_lead  UUID := '00000000-0000-4000-8000-000000146006';  -- leads u_maker's team
  u_other UUID := '00000000-0000-4000-8000-000000146007';  -- agent in another team
  u_multi UUID := '00000000-0000-4000-8000-000000146008';  -- admin row in A, active in B
  b_acct  UUID;
  t1      UUID;
  t2      UUID;
  ga      UUID;  -- sent an hour before the open, arrives after it
  gb      UUID;  -- sender clock an hour ahead, arrives before the open
  gx      UUID;  -- another team's group
  a_acct  UUID;
  w1      UUID;
  g1      UUID;  -- inbound an hour ago: unread
  g2      UUID;  -- outbound only
  gl      UUID;  -- left, inbound recent
  go      UUID;  -- inbound 10 days ago, nobody's marker
  r       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as a signed-in user: a SELECT's value, 'ok', or the
  -- error as 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.wr_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        IF p_sql ILIKE 'select%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(nullif(v, ''), 'ok');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  -- Fixture: one workspace (owner, admin, two agents), one Whapi number.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'wr-owner@example.invalid'),
    (u_admin, 'wr-admin@example.invalid'),
    (u_maker, 'wr-maker@example.invalid'),
    (u_out,   'wr-out@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_maker, u_out);

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'WR-146-A1', 'x', 'connected', true) RETURNING id INTO w1;

  INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role)
  VALUES (a_acct, w1, '120363000000146001@g.us', 'WR one', u_maker, 'admin') RETURNING id INTO g1;
  INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role)
  VALUES (a_acct, w1, '120363000000146002@g.us', 'WR two', u_maker, 'admin') RETURNING id INTO g2;
  INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role)
  VALUES (a_acct, w1, '120363000000146003@g.us', 'WR left', u_maker, 'left') RETURNING id INTO gl;
  INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role)
  VALUES (a_acct, w1, '120363000000146004@g.us', 'WR old', u_maker, 'admin') RETURNING id INTO go;
  INSERT INTO whatsapp_group_messages (account_id, group_id, wa_message_id, direction, body, created_at) VALUES
    (a_acct, g1, 'wr-m1', 'in', 'one', now() - interval '1 hour'),
    (a_acct, g2, 'wr-m2', 'out', 'two', now() - interval '1 hour'),
    (a_acct, gl, 'wr-m3', 'in', 'left', now() - interval '1 hour'),
    (a_acct, go, 'wr-m4', 'in', 'old', now() - interval '10 days');
  UPDATE whatsapp_group_messages SET received_at = created_at
   WHERE wa_message_id IN ('wr-m1', 'wr-m2', 'wr-m3', 'wr-m4');

  -- ---------- the count before anyone reads ----------
  -- Only g1: g2 is outbound, gl is left, go is older than 7 days.
  r := pg_temp.wr_try(u_maker, 'SELECT whatsapp_group_unread_count()::text');
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('creator''s count before reading is not 1: ' || r)::text); END IF;
  r := pg_temp.wr_try(u_admin, 'SELECT whatsapp_group_unread_count()::text');
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('admin''s count before reading is not 1: ' || r)::text); END IF;
  r := pg_temp.wr_try(u_out, 'SELECT whatsapp_group_unread_count()::text');
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('an agent who sees no group counts one: ' || r)::text); END IF;

  -- ---------- mark_read refuses a group the caller cannot see ----------
  r := pg_temp.wr_try(u_out, format('SELECT whatsapp_group_mark_read(%L)::text', g1));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('mark_read did not refuse a group the caller cannot see: ' || r)::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM whatsapp_group_reads WHERE user_id = u_out) THEN
    failed := array_append(failed, 'a refused mark_read left a marker'::text);
  END IF;

  -- ---------- 1 -> 0 on mark_read; another person's marker is theirs ----------
  r := pg_temp.wr_try(u_maker, format('SELECT whatsapp_group_mark_read(%L)::text', g1));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('creator could not mark their group read: ' || r)::text); END IF;
  r := pg_temp.wr_try(u_maker, 'SELECT whatsapp_group_unread_count()::text');
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('creator''s count after mark_read is not 0: ' || r)::text); END IF;
  r := pg_temp.wr_try(u_admin, 'SELECT whatsapp_group_unread_count()::text');
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('the creator''s read cleared the admin''s count: ' || r)::text); END IF;

  -- ---------- after the read: outbound never counts, inbound does ----------
  UPDATE whatsapp_group_reads SET last_read_at = now() - interval '1 second'
   WHERE group_id = g1 AND user_id = u_maker;
  INSERT INTO whatsapp_group_messages (account_id, group_id, wa_message_id, direction, body)
  VALUES (a_acct, g1, 'wr-m5', 'out', 'our reply');
  r := pg_temp.wr_try(u_maker, 'SELECT whatsapp_group_unread_count()::text');
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('an outbound message after the read counted: ' || r)::text); END IF;
  INSERT INTO whatsapp_group_messages (account_id, group_id, wa_message_id, direction, body)
  VALUES (a_acct, g1, 'wr-m6', 'in', 'their reply');
  r := pg_temp.wr_try(u_maker, 'SELECT whatsapp_group_unread_count()::text');
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('an inbound message after the read did not count: ' || r)::text); END IF;

  -- ---------- forward-only ----------
  UPDATE whatsapp_group_reads SET last_read_at = now() + interval '1 hour'
   WHERE group_id = g1 AND user_id = u_maker;
  r := pg_temp.wr_try(u_maker, format('SELECT whatsapp_group_mark_read(%L)::text', g1));
  n := n + 1;
  IF r <> 'ok' OR (SELECT last_read_at FROM whatsapp_group_reads WHERE group_id = g1 AND user_id = u_maker)
                  IS DISTINCT FROM now() + interval '1 hour' THEN
    failed := array_append(failed, ('mark_read moved a marker back (' || r || ')')::text);
  END IF;

  -- ---------- clients read their own markers and write none ----------
  r := pg_temp.wr_try(u_admin, format('SELECT whatsapp_group_mark_read(%L)::text', g1));
  r := pg_temp.wr_try(u_maker, 'SELECT count(*)::text FROM whatsapp_group_reads');
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('a person reads markers other than their own: ' || r)::text); END IF;
  r := pg_temp.wr_try(u_out, format(
    'INSERT INTO whatsapp_group_reads (group_id, account_id, user_id, last_read_at) VALUES (%L, %L, %L, now())',
    g2, a_acct, u_out));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN failed := array_append(failed, ('a client inserted a marker: ' || r)::text); END IF;
  r := pg_temp.wr_try(u_maker, format(
    'UPDATE whatsapp_group_reads SET last_read_at = now() - interval ''1 year'' WHERE group_id = %L', g1));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN failed := array_append(failed, ('a client updated a marker: ' || r)::text); END IF;
  r := pg_temp.wr_try(u_maker, format('DELETE FROM whatsapp_group_reads WHERE group_id = %L', g1));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN failed := array_append(failed, ('a client deleted a marker: ' || r)::text); END IF;

  -- ---------- arrival time, not WhatsApp's send time ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_ab,    'wr-ab@example.invalid'),
    (u_ab2,   'wr-ab2@example.invalid'),
    (u_lead,  'wr-lead@example.invalid'),
    (u_other, 'wr-other@example.invalid'),
    (u_multi, 'wr-multi@example.invalid')
  ON CONFLICT DO NOTHING;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_ab, u_ab2, u_other);
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role)
  VALUES (a_acct, w1, '120363000000146005@g.us', 'WR late', u_ab, 'admin') RETURNING id INTO ga;
  INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role)
  VALUES (a_acct, w1, '120363000000146006@g.us', 'WR ahead', u_ab2, 'admin') RETURNING id INTO gb;
  -- One creator per group, so each count below is about one group.

  -- (b) A sender clock an hour ahead: the message arrives, then the
  -- group is opened. It counts until the open and not after.
  INSERT INTO whatsapp_group_messages (account_id, group_id, wa_message_id, direction, body, created_at)
  VALUES (a_acct, gb, 'wr-m7', 'in', 'from the future', now() + interval '1 hour');
  r := pg_temp.wr_try(u_ab2, 'SELECT whatsapp_group_unread_count()::text');
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('(b) a message sent "ahead" did not count before the read: ' || r)::text); END IF;
  r := pg_temp.wr_try(u_ab2, format('SELECT whatsapp_group_mark_read(%L)::text', gb));
  r := pg_temp.wr_try(u_ab2, 'SELECT whatsapp_group_unread_count()::text');
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('(b) a message sent "ahead" still counts after the read: ' || r)::text); END IF;

  -- (a) Sent an hour before the open, arriving after it (phone offline,
  -- gateway backlog): received_at takes its default and it counts.
  r := pg_temp.wr_try(u_ab, format('SELECT whatsapp_group_mark_read(%L)::text', ga));
  UPDATE whatsapp_group_reads SET last_read_at = now() - interval '1 second'
   WHERE group_id = ga AND user_id = u_ab;
  INSERT INTO whatsapp_group_messages (account_id, group_id, wa_message_id, direction, body, created_at)
  VALUES (a_acct, ga, 'wr-m8', 'in', 'late arrival', now() - interval '1 hour');
  n := n + 1;
  IF (SELECT received_at FROM whatsapp_group_messages WHERE wa_message_id = 'wr-m8') IS DISTINCT FROM now() THEN
    failed := array_append(failed, '(a) received_at did not default to now()'::text);
  END IF;
  r := pg_temp.wr_try(u_ab, 'SELECT whatsapp_group_unread_count()::text');
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('(a) a message sent before the read but arriving after it did not count: ' || r)::text); END IF;

  -- ---------- (c) a team leader: their team's groups, not another team's ----------
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'WR team', u_lead) RETURNING id INTO t1;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t1, u_maker, a_acct);
  INSERT INTO teams (account_id, name) VALUES (a_acct, 'WR other team') RETURNING id INTO t2;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t2, u_other, a_acct);
  INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role)
  VALUES (a_acct, w1, '120363000000146007@g.us', 'WR other', u_other, 'admin') RETURNING id INTO gx;
  INSERT INTO whatsapp_group_messages (account_id, group_id, wa_message_id, direction, body)
  VALUES (a_acct, gx, 'wr-m9', 'in', 'other team');
  r := pg_temp.wr_try(u_other, 'SELECT whatsapp_group_unread_count()::text');
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('(c) the other team''s creator does not count their group: ' || r)::text); END IF;
  -- g1 (u_maker's; wr-m6 is unread for the leader) and nothing of gx.
  r := pg_temp.wr_try(u_lead, 'SELECT whatsapp_group_unread_count()::text');
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('(c) the leader''s count is not 1 (their member''s group): ' || r)::text); END IF;
  r := pg_temp.wr_try(u_lead, format('SELECT whatsapp_group_mark_read(%L)::text', g1));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('(c) the leader could not mark their member''s group read: ' || r)::text); END IF;
  r := pg_temp.wr_try(u_lead, 'SELECT whatsapp_group_unread_count()::text');
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('(c) another team''s group counts for the leader: ' || r)::text); END IF;
  r := pg_temp.wr_try(u_lead, format('SELECT whatsapp_group_mark_read(%L)::text', gx));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN failed := array_append(failed, ('(c) the leader marked another team''s group read: ' || r)::text); END IF;

  -- ---------- (d) a live row in A while active in B ----------
  -- u_multi's own account (B) stays active; the A row is an inactive admin.
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_multi;
  IF b_acct IS NULL OR b_acct = a_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision a second account';
  END IF;
  INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active)
  VALUES (u_multi, '', 'wr-multi@example.invalid', a_acct, 'admin', false);
  r := pg_temp.wr_try(u_multi, 'SELECT whatsapp_group_unread_count()::text');
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('(d) groups of a workspace the person is not active in count: ' || r)::text); END IF;
  r := pg_temp.wr_try(u_multi, format('SELECT whatsapp_group_mark_read(%L)::text', g1));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN failed := array_append(failed, ('(d) mark_read accepted a group of a workspace the person is not active in: ' || r)::text); END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM whatsapp_group_reads WHERE user_id = u_multi) THEN
    failed := array_append(failed, '(d) a refused mark_read left a marker'::text);
  END IF;

  -- ---------- grants and forced RLS ----------
  n := n + 1;
  IF NOT (SELECT prosecdef AND proconfig @> ARRAY['search_path=public, pg_temp']
            FROM pg_proc WHERE oid = 'public.whatsapp_group_mark_read(uuid)'::regprocedure)
     OR has_function_privilege('anon', 'public.whatsapp_group_mark_read(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.whatsapp_group_unread_count()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.whatsapp_group_mark_read(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.whatsapp_group_unread_count()', 'EXECUTE') THEN
    failed := array_append(failed, 'mark_read is not SECURITY DEFINER with a pinned search_path, or the grants are wrong'::text);
  END IF;
  n := n + 1;
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
           WHERE oid = 'public.whatsapp_group_reads'::regclass) THEN
    failed := array_append(failed, 'row-level security is not forced on whatsapp_group_reads'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT146', MESSAGE = 'verify-whatsapp-group-reads rollback';
  EXCEPTION WHEN SQLSTATE 'ZT146' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'whatsapp group reads verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'whatsapp group reads verification passed (% checks)', n;
END
$verify$;
