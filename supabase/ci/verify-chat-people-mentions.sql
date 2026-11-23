-- Behavioural regression suite for team chat people and edited mentions
-- (migration 277).
--
-- 1. chat_people lists a deactivated person, flagged; nobody removed from
--    the workspace; to a bank guest only the people of shared channels;
--    nothing to a deactivated caller. Its grants are 087's.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. Failing checks
-- are named in the final exception; every fixture is rolled back by
-- the sentinel raised at the end of the inner block.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000277001';
  u_one   UUID := '00000000-0000-4000-8000-000000277002';
  u_two   UUID := '00000000-0000-4000-8000-00000027700a';
  u_three UUID := '00000000-0000-4000-8000-00000027700b';
  u_gone  UUID := '00000000-0000-4000-8000-000000277005';  -- deactivated
  u_away  UUID := '00000000-0000-4000-8000-000000277006';  -- another workspace
  u_guest UUID := '00000000-0000-4000-8000-000000277007';
  a_acct  UUID;
  ch      UUID;  -- team channel
  priv    UUID;  -- private: one, two, the guest and the deactivated person
  dm      UUID;  -- one + two
  m       UUID;
  md      UUID;
  mp      UUID;
  r       TEXT;
  people_sql TEXT := 'SELECT string_agg(right(user_id::text, 1) || CASE WHEN deactivated THEN ''!'' ELSE '''' END, '','' ORDER BY user_id) FROM public.chat_people(%L)';
  post_sql   TEXT := 'SELECT public.chat_post_message(%L, %L)::text';
  edit_sql   TEXT := 'SELECT public.chat_edit_message(%L, %L)::text';
  badge_sql  TEXT := 'SELECT coalesce(sum(mentions), 0)::text FROM public.chat_unread_counts(%L) WHERE channel_id = %L';
  n INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as authenticated, signed in as p_uid: a SELECT's
  -- value, 'ok', or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pm_try(p_uid uuid, p_sql text)
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
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pm_eq(p_name text, p_got text, p_want text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT CASE WHEN p_got IS NOT DISTINCT FROM p_want THEN NULL
                  ELSE p_name || ' (' || coalesce(p_got, '<null>') || ', want ' || p_want || ')' END $body$
  $fn$;
  -- A message's mentions, and who it rang and how, by the id's last digit.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pm_mentions(p_m uuid) RETURNS text LANGUAGE sql AS $body$
      SELECT coalesce(string_agg(right(user_id::text, 1), ',' ORDER BY user_id), '')
        FROM public.message_mentions WHERE message_id = p_m $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pm_bells(p_m uuid) RETURNS text LANGUAGE sql AS $body$
      SELECT coalesce(string_agg(right(user_id::text, 1) || ':' || type, ',' ORDER BY user_id, type), '')
        FROM public.notifications WHERE meta->>'message_id' = p_m::text $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'ci-cpm-owner@example.invalid'),
    (u_one,   'ci-cpm-one@example.invalid'),
    (u_two,   'ci-cpm-two@example.invalid'),
    (u_three, 'ci-cpm-three@example.invalid'),
    (u_gone,  'ci-cpm-gone@example.invalid'),
    (u_away,  'ci-cpm-away@example.invalid'),
    (u_guest, 'ci-cpm-guest@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE accounts SET internal_chat_enabled = true WHERE id = a_acct;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_one, u_two, u_three, u_gone);
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;
  INSERT INTO chat_channels (account_id, kind, name, created_by) VALUES (a_acct, 'team', 'ci-cpm-team', u_one) RETURNING id INTO ch;
  INSERT INTO chat_channels (account_id, kind, name, created_by) VALUES (a_acct, 'private', 'ci-cpm-private', u_one) RETURNING id INTO priv;
  INSERT INTO chat_channel_members (channel_id, user_id, role) VALUES
    (ch, u_one, 'admin'), (ch, u_two, 'member'), (ch, u_three, 'member'),
    (priv, u_one, 'admin'), (priv, u_two, 'member'), (priv, u_gone, 'member'), (priv, u_guest, 'guest');
  -- one transaction, one now(): joined earlier, so a post counts as unread
  UPDATE chat_channel_members SET joined_at = now() - interval '1 day', last_read_at = now() - interval '1 day'
   WHERE channel_id = ch;
  dm := pg_temp.pm_try(u_one, format('SELECT public.chat_open_dm(%L, %L::uuid[])::text', a_acct, ARRAY[u_two]))::uuid;
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;

  -- ---------- 1. chat_people ----------
  r := pg_temp.pm_try(u_one, format(people_sql, a_acct));
  n := n + 1; failed := failed || pg_temp.pm_eq('staff see the deactivated person, flagged, and nobody of another workspace', r, '1,2,5!,7,a,b');
  r := pg_temp.pm_try(u_guest, format(people_sql, a_acct));
  n := n + 1; failed := failed || pg_temp.pm_eq('a guest sees only the people of shared channels', r, '2,5!,7,a');
  r := pg_temp.pm_try(u_gone, format(people_sql, a_acct));
  n := n + 1; failed := failed || pg_temp.pm_eq('a deactivated caller sees nobody', r, 'ok');
  n := n + 1; failed := failed || pg_temp.pm_eq('the grants of chat_people',
    (SELECT string_agg(a, ',') FROM unnest(ARRAY['anon','authenticated','service_role']) a
      WHERE has_function_privilege(a, 'public.chat_people(uuid)', 'EXECUTE')), 'authenticated');
  n := n + 1; failed := failed || pg_temp.pm_eq('how many chat_people there are',
    (SELECT count(*)::text FROM pg_proc WHERE proname = 'chat_people' AND pronamespace = 'public'::regnamespace
        AND prosecdef AND proconfig = ARRAY['search_path=public, pg_temp']), '1');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT277', MESSAGE = 'verify-chat-people-mentions rollback';
  EXCEPTION WHEN SQLSTATE 'ZT277' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'chat people and mentions verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'chat people and mentions verification passed (% checks)', n;
END
$verify$;
