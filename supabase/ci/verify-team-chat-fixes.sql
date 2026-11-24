-- Behavioural regression suite for the team chat fixes (migration 273).
--
-- 1. A DM between two people cannot be left; one of three can. Reopening
--    an existing DM brings back every named member, never a deactivated
--    person and never a pair 143 blocks; a person brought back gets the
--    other side's next message and its bell.
--    Not asserted here: the migration's one-time INSERT of the member rows
--    missing on the day it ran (none for a pair 143 blocks). It is a
--    statement, not an object, and leaves nothing to look at afterwards.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. Failing checks
-- are named in the final exception; every fixture is rolled back by
-- the sentinel raised at the end of the inner block.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000273001';
  u_one   UUID := '00000000-0000-4000-8000-000000273002';
  u_two   UUID := '00000000-0000-4000-8000-000000273003';
  u_three UUID := '00000000-0000-4000-8000-000000273004';
  a_acct  UUID;
  dm      UUID;  -- one + two
  dm3     UUID;  -- one + two + three
  m       UUID;
  r       TEXT;
  open_sql  TEXT := 'SELECT public.chat_open_dm(%L, %L::uuid[])::text';
  leave_sql TEXT := 'SELECT public.chat_leave_channel(%L)::text';
  post_sql  TEXT := 'SELECT public.chat_post_message(%L, %L)::text';
  n INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (NULL: as the current user) signed in as
  -- p_uid: a SELECT's value, 'ok', or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tf_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        IF p_role IS NOT NULL THEN
          PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', p_role)::text, true);
          EXECUTE format('SET LOCAL ROLE %I', p_role);
        END IF;
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
    CREATE FUNCTION pg_temp.tf_check(p_name text, p_role text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.tf_try(p_role, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tf_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'ci-tcf-owner@example.invalid'),
    (u_one,   'ci-tcf-one@example.invalid'),
    (u_two,   'ci-tcf-two@example.invalid'),
    (u_three, 'ci-tcf-three@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE accounts SET internal_chat_enabled = true WHERE id = a_acct;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_one, u_two, u_three);

  -- ---------- 1. leaving and reopening a DM ----------
  dm := pg_temp.tf_try('authenticated', u_one, format(open_sql, a_acct, ARRAY[u_two]))::uuid;
  dm3 := pg_temp.tf_try('authenticated', u_one, format(open_sql, a_acct, ARRAY[u_two, u_three]))::uuid;
  r := pg_temp.tf_try('authenticated', u_two, format(leave_sql, dm));
  n := n + 1; failed := failed || pg_temp.tf_ok(r LIKE '%22023%'
    AND EXISTS (SELECT 1 FROM chat_channel_members WHERE channel_id = dm AND user_id = u_two),
    'a DM of two was left: ' || coalesce(r, '<null>'));
  PERFORM pg_temp.tf_try('authenticated', u_two, format(leave_sql, dm3));
  n := n + 1; failed := failed || pg_temp.tf_ok(
    NOT EXISTS (SELECT 1 FROM chat_channel_members WHERE channel_id = dm3 AND user_id = u_two),
    'a DM of three could not be left');

  -- a row lost before 273, as a leaver's was
  DELETE FROM chat_channel_members WHERE channel_id = dm AND user_id = u_two;
  r := pg_temp.tf_try('authenticated', u_one, format(open_sql, a_acct, ARRAY[u_two]));
  n := n + 1; failed := failed || pg_temp.tf_ok(r = dm::text
    AND (SELECT count(*) = 2 AND bool_and(role = 'member') FROM chat_channel_members WHERE channel_id = dm),
    'reopening a DM did not bring the other person back: ' || coalesce(r, '<null>'));
  m := pg_temp.tf_try('authenticated', u_one, format(post_sql, dm, 'are you there'))::uuid;
  n := n + 1; failed := failed || pg_temp.tf_ok(
    EXISTS (SELECT 1 FROM chat_notifications WHERE message_id = m AND user_id = u_two AND kind = 'dm')
    AND pg_temp.tf_try('authenticated', u_two,
      format('SELECT count(*)::text FROM internal_messages WHERE id = %L', m)) = '1',
    'a person brought back was not told of the next message');
  PERFORM pg_temp.tf_try('authenticated', u_one, format(open_sql, a_acct, ARRAY[u_two, u_three]));
  n := n + 1; failed := failed || pg_temp.tf_ok(
    (SELECT count(*) FROM chat_channel_members WHERE channel_id = dm3) = 3,
    'reopening a DM of three did not bring the leaver back');

  -- never against 143's rules, never a deactivated person
  DELETE FROM chat_channel_members WHERE channel_id = dm AND user_id = u_two;
  INSERT INTO chat_dm_rules (account_id, class_a, class_b, scope) VALUES (a_acct, 'agent', 'agent', 'none');
  r := pg_temp.tf_try('authenticated', u_one, format(open_sql, a_acct, ARRAY[u_two]));
  n := n + 1; failed := failed || pg_temp.tf_ok(r LIKE '%are turned off%'
    AND NOT EXISTS (SELECT 1 FROM chat_channel_members WHERE channel_id = dm AND user_id = u_two),
    'a pair the DM rules block was brought back: ' || coalesce(r, '<null>'));
  DELETE FROM chat_dm_rules WHERE account_id = a_acct;
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_two;
  r := pg_temp.tf_try('authenticated', u_one, format(open_sql, a_acct, ARRAY[u_two]));
  n := n + 1; failed := failed || pg_temp.tf_ok(r LIKE '%42501%'
    AND NOT EXISTS (SELECT 1 FROM chat_channel_members WHERE channel_id = dm AND user_id = u_two),
    'a deactivated person was brought back: ' || coalesce(r, '<null>'));

  n := n + 1; failed := failed || pg_temp.tf_ok(
    has_function_privilege('authenticated', 'public.chat_leave_channel(uuid)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.chat_open_dm(uuid,uuid[])', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.chat_open_dm(uuid,uuid[])', 'EXECUTE')
    AND NOT has_function_privilege('service_role', 'public.chat_leave_channel(uuid)', 'EXECUTE'),
    'the grants of the restated functions moved');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT273', MESSAGE = 'verify-team-chat-fixes rollback';
  EXCEPTION WHEN SQLSTATE 'ZT273' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'team chat fixes verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'team chat fixes verification passed (% checks)', n;
END
$verify$;
