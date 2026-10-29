-- Behavioural regression suite for meaning triggers (migration 150):
-- flows.trigger_type accepts 'intent' alongside the original three and
-- still refuses an unknown type, and exactly one CHECK on flows governs
-- trigger_type (the swap left no older copy behind).
--
-- ONE statement on purpose (the pinned CLI rejects several). Failing
-- assertions are named in the final exception; fixtures are undone by
-- a sentinel exception while the collected results survive.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000150001';
  a_acct  UUID;
  t       TEXT;
  r       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  -- As the table owner: 'ok' or the SQLSTATE + error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.mt_do(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      EXECUTE p_sql;
      RETURN 'ok';
    EXCEPTION WHEN OTHERS THEN
      RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES (u_owner, 'mt-owner@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;

  FOREACH t IN ARRAY ARRAY['intent', 'keyword', 'first_inbound_message', 'manual'] LOOP
    r := pg_temp.mt_do(format(
           'INSERT INTO flows (account_id, user_id, name, trigger_type) VALUES (%L, %L, %L, %L)',
           a_acct, u_owner, 'MT ' || t, t));
    n := n + 1;
    IF r <> 'ok' THEN
      failed := array_append(failed, (format('a %s flow was refused: ', t) || r)::text);
    END IF;
  END LOOP;

  r := pg_temp.mt_do(format(
         'INSERT INTO flows (account_id, user_id, name, trigger_type) VALUES (%L, %L, ''MT bad'', ''intent_match'')',
         a_acct, u_owner));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := array_append(failed, ('an unknown flow trigger type was accepted (want 23514): ' || r)::text);
  END IF;

  n := n + 1;
  IF (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.flows'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%trigger_type%') <> 1 THEN
    failed := array_append(failed, 'flows does not carry exactly one trigger_type CHECK'::text);
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT150', MESSAGE = 'verify-meaning-triggers rollback';
  EXCEPTION WHEN SQLSTATE 'ZT150' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'meaning triggers verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'meaning triggers verification passed (% checks)', n;
END
$verify$;
