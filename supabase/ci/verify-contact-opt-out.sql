-- Behavioural regression suite for a contact's opt-out (migration 076).
--
-- contacts.opted_out_at is what every broadcast trusts to skip a
-- customer who asked to stop. contacts_update (059) lets any agent
-- update a contact they can see, so contacts_opt_out_guard decides who
-- may change the stamp: the service role and server jobs (no signed-in
-- user) and an admin of the contact's account. This asserts that an
-- agent or a team leader can neither set nor clear it — on UPDATE or by
-- inserting a stamped contact — while every other contact field stays
-- writable, that the trusted writers still can, and that the backfill
-- stamps a contact carrying its own account's `opted-out` tag.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000076001';
  u_admin  UUID := '00000000-0000-4000-8000-000000076002';
  u_lead   UUID := '00000000-0000-4000-8000-000000076003';
  u_agent  UUID := '00000000-0000-4000-8000-000000076004';
  u_other  UUID := '00000000-0000-4000-8000-000000076005';
  a_acct   UUID;
  b_acct   UUID;
  c_agent  UUID;   -- the agent's own contact, so RLS lets them update it
  c_lead   UUID;   -- the team leader's own contact
  c_tagged UUID;   -- carries account A's `Opted-Out` tag
  c_cross  UUID;   -- carries account B's `opted-out` tag
  c_kept   UUID;   -- tagged, but already stamped
  tg_a     UUID;
  tg_b     UUID;
  stamp    TIMESTAMPTZ;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given);
  -- 'ok', or the error as 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.oo_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        EXECUTE p_sql;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ok';
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  -- Fixture: account A (owner, admin, team leader, agent), account B.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'oo-owner@example.invalid'),
    (u_admin, 'oo-admin@example.invalid'),
    (u_lead,  'oo-lead@example.invalid'),
    (u_agent, 'oo-agent@example.invalid'),
    (u_other, 'oo-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;

  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_agent, '971500076001', 'OO agent contact') RETURNING id INTO c_agent;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_lead, '971500076002', 'OO leader contact') RETURNING id INTO c_lead;

  -- ---------- an agent cannot set the stamp ----------
  r := pg_temp.oo_try('authenticated', u_agent, format(
    'UPDATE contacts SET opted_out_at = now() WHERE id = %L', c_agent));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('agent set opted_out_at: ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT opted_out_at FROM contacts WHERE id = c_agent) IS NOT NULL THEN
    failed := array_append(failed, 'agent set opted_out_at: the stamp was written'::text);
  END IF;

  -- ---------- an agent cannot clear it ----------
  UPDATE contacts SET opted_out_at = '2026-03-04 05:06:07+00' WHERE id = c_agent;
  r := pg_temp.oo_try('authenticated', u_agent, format(
    'UPDATE contacts SET opted_out_at = NULL WHERE id = %L', c_agent));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('agent cleared opted_out_at: ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT opted_out_at FROM contacts WHERE id = c_agent) IS DISTINCT FROM '2026-03-04 05:06:07+00'::timestamptz THEN
    failed := array_append(failed, 'agent cleared opted_out_at: the stamp moved'::text);
  END IF;
  -- Nor move it to another time.
  r := pg_temp.oo_try('authenticated', u_agent, format(
    'UPDATE contacts SET opted_out_at = now() WHERE id = %L', c_agent));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('agent moved opted_out_at: ' || r)::text);
  END IF;

  -- ---------- other fields stay writable ----------
  r := pg_temp.oo_try('authenticated', u_agent, format(
    'UPDATE contacts SET name = %L WHERE id = %L', 'OO renamed', c_agent));
  n := n + 1;
  IF r <> 'ok' OR (SELECT name FROM contacts WHERE id = c_agent) <> 'OO renamed' THEN
    failed := array_append(failed, ('agent rename of an opted-out contact: ' || r)::text);
  END IF;
  -- A screen writing the whole row back, stamp unchanged.
  r := pg_temp.oo_try('authenticated', u_agent, format(
    'UPDATE contacts SET name = %L, opted_out_at = %L WHERE id = %L',
    'OO written back', '2026-03-04 05:06:07+00', c_agent));
  n := n + 1;
  IF r <> 'ok' OR (SELECT name FROM contacts WHERE id = c_agent) <> 'OO written back' THEN
    failed := array_append(failed, ('agent whole-row write-back with the same stamp: ' || r)::text);
  END IF;

  -- ---------- inserting ----------
  r := pg_temp.oo_try('authenticated', u_agent, format(
    'INSERT INTO contacts (account_id, user_id, phone, name, opted_out_at) VALUES (%L, %L, %L, %L, now())',
    a_acct, u_agent, '971500076003', 'OO stamped insert'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('agent inserted a stamped contact: ' || r)::text);
  END IF;
  r := pg_temp.oo_try('authenticated', u_agent, format(
    'INSERT INTO contacts (account_id, user_id, phone, name) VALUES (%L, %L, %L, %L)',
    a_acct, u_agent, '971500076004', 'OO plain insert'));
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('agent insert of an unstamped contact: ' || r)::text);
  END IF;

  -- ---------- a team leader is not an admin ----------
  r := pg_temp.oo_try('authenticated', u_lead, format(
    'UPDATE contacts SET opted_out_at = now() WHERE id = %L', c_lead));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('team leader set opted_out_at: ' || r)::text);
  END IF;

  -- ---------- an admin may clear and set it ----------
  r := pg_temp.oo_try('authenticated', u_admin, format(
    'UPDATE contacts SET opted_out_at = NULL WHERE id = %L', c_agent));
  n := n + 1;
  IF r <> 'ok' OR (SELECT opted_out_at FROM contacts WHERE id = c_agent) IS NOT NULL THEN
    failed := array_append(failed, ('admin clear opted_out_at: ' || r)::text);
  END IF;
  r := pg_temp.oo_try('authenticated', u_admin, format(
    'UPDATE contacts SET opted_out_at = now() WHERE id = %L', c_agent));
  n := n + 1;
  IF r <> 'ok' OR (SELECT opted_out_at FROM contacts WHERE id = c_agent) IS NULL THEN
    failed := array_append(failed, ('admin set opted_out_at: ' || r)::text);
  END IF;
  r := pg_temp.oo_try('authenticated', u_owner, format(
    'UPDATE contacts SET opted_out_at = NULL WHERE id = %L', c_agent));
  n := n + 1;
  IF r <> 'ok' OR (SELECT opted_out_at FROM contacts WHERE id = c_agent) IS NOT NULL THEN
    failed := array_append(failed, ('owner clear opted_out_at: ' || r)::text);
  END IF;

  -- ---------- the service role and server jobs may ----------
  -- The bot and the TypeSafe watch stamp on the service role (no user).
  r := pg_temp.oo_try('service_role', NULL, format(
    'UPDATE contacts SET opted_out_at = now() WHERE id = %L', c_agent));
  n := n + 1;
  IF r <> 'ok' OR (SELECT opted_out_at FROM contacts WHERE id = c_agent) IS NULL THEN
    failed := array_append(failed, ('service role set opted_out_at: ' || r)::text);
  END IF;
  r := pg_temp.oo_try('service_role', NULL, format(
    'UPDATE contacts SET opted_out_at = NULL WHERE id = %L', c_agent));
  n := n + 1;
  IF r <> 'ok' OR (SELECT opted_out_at FROM contacts WHERE id = c_agent) IS NOT NULL THEN
    failed := array_append(failed, ('service role clear opted_out_at: ' || r)::text);
  END IF;
  -- No signed-in user at all: a migration, the SQL editor.
  BEGIN
    UPDATE contacts SET opted_out_at = now() WHERE id = c_lead;
    r := 'ok';
  EXCEPTION WHEN OTHERS THEN
    r := 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
  END;
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('no-user set opted_out_at: ' || r)::text);
  END IF;

  -- ---------- the backfill ----------
  INSERT INTO tags (user_id, account_id, name) VALUES (u_owner, a_acct, 'Opted-Out') RETURNING id INTO tg_a;
  INSERT INTO tags (user_id, account_id, name) VALUES (u_other, b_acct, 'opted-out') RETURNING id INTO tg_b;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971500076005', 'OO tagged') RETURNING id INTO c_tagged;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971500076006', 'OO cross-account tag') RETURNING id INTO c_cross;
  INSERT INTO contacts (account_id, user_id, phone, name, opted_out_at)
  VALUES (a_acct, u_owner, '971500076007', 'OO already stamped', '2026-01-01 00:00:00+00') RETURNING id INTO c_kept;
  INSERT INTO contact_tags (contact_id, tag_id, created_at) VALUES
    (c_tagged, tg_a, '2026-02-03 04:05:06+00'),
    (c_cross,  tg_b, '2026-02-03 04:05:06+00'),
    (c_kept,   tg_a, '2026-02-03 04:05:06+00');

  PERFORM public.contacts_opt_out_backfill();
  SELECT opted_out_at INTO stamp FROM contacts WHERE id = c_tagged;
  n := n + 1;
  IF stamp IS DISTINCT FROM '2026-02-03 04:05:06+00'::timestamptz THEN
    failed := array_append(failed, ('backfill of a contact tagged opted-out: ' || coalesce(stamp::text, 'NULL'))::text);
  END IF;
  SELECT opted_out_at INTO stamp FROM contacts WHERE id = c_cross;
  n := n + 1;
  IF stamp IS NOT NULL THEN
    failed := array_append(failed, 'backfill stamped a contact with another account''s opted-out tag'::text);
  END IF;
  SELECT opted_out_at INTO stamp FROM contacts WHERE id = c_kept;
  n := n + 1;
  IF stamp IS DISTINCT FROM '2026-01-01 00:00:00+00'::timestamptz THEN
    failed := array_append(failed, ('backfill moved an existing stamp: ' || coalesce(stamp::text, 'NULL'))::text);
  END IF;
  n := n + 1;
  IF public.contacts_opt_out_backfill() <> 0 THEN
    failed := array_append(failed, 'backfill re-run changed rows'::text);
  END IF;

  -- ---------- grants ----------
  n := n + 1;
  IF has_function_privilege('authenticated', 'public.contacts_opt_out_backfill()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.contacts_opt_out_backfill()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.contacts_opt_out_guard()', 'EXECUTE') THEN
    failed := array_append(failed, 'clients may call the 076 functions'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT076', MESSAGE = 'verify-contact-opt-out rollback';
  EXCEPTION WHEN SQLSTATE 'ZT076' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'contact opt-out verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'contact opt-out verification passed (% checks)', n;
END
$verify$;
