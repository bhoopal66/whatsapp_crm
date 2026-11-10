-- Behavioural regression suite for case macros (migration 186).
--
-- Sharing is 185's saved views: a private macro is its owner's alone
-- (MACRO_NOT_FOUND to anyone else, never NOT_ALLOWED), only
-- owners/admins share (on create and on update), a shared macro is
-- listed to every case-role member of the account and to no other
-- account, a viewer saves nothing, only the owner updates, and the
-- owner or an owner/admin of the account deletes. The one validator
-- refuses every malformed action (ACTION_INVALID) and a blank or long
-- name (NAME_INVALID). The apply log: the macro must be visible and the
-- case readable in the macro's account (CASE_NOT_FOUND), applied is
-- 1..10 {kind, ok, refusal} objects, actor_role is case_role, the table
-- is append-only for every writer (its owner included) and outlives the
-- macro. Grants: service_role only; RLS reads.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back on success too (a sentinel exception ends the block), and
-- failing assertions are named in the final exception.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000186001';
  u_admin  UUID := '00000000-0000-4000-8000-000000186002';
  u_agent  UUID := '00000000-0000-4000-8000-000000186003';  -- agent of k1
  u_agent2 UUID := '00000000-0000-4000-8000-000000186004';  -- agent of k2
  u_viewer UUID := '00000000-0000-4000-8000-000000186005';
  u_bown   UUID := '00000000-0000-4000-8000-000000186006';  -- owner of account B
  u_lead   UUID := '00000000-0000-4000-8000-000000186007';  -- team_leader, no team
  a_acct   UUID;
  b_acct   UUID;
  wa       UUID;
  wb       UUID;
  ca       UUID;
  cb       UUID;
  g1       UUID;
  g2       UUID;
  gb       UUID;
  k1       UUID;
  k2       UUID;
  kb       UUID;
  m1       UUID;  -- u_agent's private macro
  s1       UUID;  -- u_admin's shared macro
  mb       UUID;  -- account B's shared macro
  l1       BIGINT;
  l2       BIGINT;
  good     JSONB := '[{"kind": "add_task", "templateKey": "call_customer", "dueHours": 24, "ownerRole": "agent"},
                      {"kind": "add_note", "body": "Called {{customer}} about {{bank}}"},
                      {"kind": "set_stage", "stage": "Submitted", "outcome": "Approved"},
                      {"kind": "request_documents"}]';
  r        TEXT;
  st       TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (NULL: as the current user) signed in as
  -- p_uid: a SELECT's value, 'ok', or 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cm_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      BEGIN
        IF p_role IS NOT NULL THEN
          PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', p_role)::text, true);
          EXECUTE format('SET LOCAL ROLE %I', p_role);
        END IF;
        IF p_sql ILIKE 'select%' OR p_sql ILIKE 'with%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-') || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cm_check(p_name text, p_role text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.cm_try(p_role, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cm_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- The macro ids case_macro_list returns, in its order.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cm_list(p_actor uuid) RETURNS uuid[] LANGUAGE sql AS $body$
      SELECT coalesce(array_agg(x.macro_id ORDER BY x.ordinality), '{}')
        FROM public.case_macro_list(p_actor) WITH ORDINALITY x
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'cm-owner@example.invalid'),
    (u_admin,  'cm-admin@example.invalid'),
    (u_agent,  'cm-agent@example.invalid'),
    (u_agent2, 'cm-agent2@example.invalid'),
    (u_viewer, 'cm-viewer@example.invalid'),
    (u_bown,   'cm-bown@example.invalid'),
    (u_lead,   'cm-lead@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_bown;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_agent2);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CM-186-A1', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_bown, b_acct, 'whapi', 'CM-186-B1', 'x', 'connected', true) RETURNING id INTO wb;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500186001', 'CM one')
    RETURNING id INTO ca;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b_acct, u_bown, '971500186002', 'CM bee')
    RETURNING id INTO cb;
  g1 := (SELECT x.group_id FROM sg_open(a_acct, 'CM-186-1', ca, wa, 'macros 1', NULL,
          jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
  g2 := (SELECT x.group_id FROM sg_open(a_acct, 'CM-186-2', ca, wa, 'macros 2', NULL,
          jsonb_build_array(jsonb_build_object('user_id', u_agent2, 'label', 'agent')), NULL) x);
  gb := (SELECT x.group_id FROM sg_open(b_acct, 'CM-186-B', cb, wb, 'macros b', NULL,
          jsonb_build_array(jsonb_build_object('user_id', u_bown, 'label', 'agent')), NULL) x);
  k1 := (SELECT x.case_id FROM case_open(g1, NULL, NULL, NULL, NULL, NULL) x);
  k2 := (SELECT x.case_id FROM case_open(g2, NULL, NULL, NULL, NULL, NULL) x);
  kb := (SELECT x.case_id FROM case_open(gb, NULL, NULL, NULL, NULL, NULL) x);
  IF k1 IS NULL OR k2 IS NULL OR kb IS NULL THEN
    RAISE EXCEPTION 'fixture: case_open returned no case';
  END IF;

  -- ---------- saving a private macro ----------
  m1 := (case_macro_save(u_agent, NULL, '  Follow up  ', good, false)).macro_id;
  n := n + 1; failed := failed || pg_temp.cm_ok(
    (SELECT x.name = 'Follow up' AND x.account_id = a_acct AND x.owner_user_id = u_agent AND NOT x.shared
            AND x.actions = good FROM case_macros x WHERE x.macro_id = m1),
    'a private macro was not stored as given (trimmed name, actions, owner, account)');
  n := n + 1; failed := failed || pg_temp.cm_check('a 60-character name and 10 actions were refused', NULL, NULL,
    format('SELECT (case_macro_save(%L, NULL, %L, %L::jsonb, false)).name', u_agent2, repeat('n', 60),
      (SELECT jsonb_agg('{"kind": "request_documents"}'::jsonb) FROM generate_series(1, 10))), repeat('n', 60));
  n := n + 1; failed := failed || pg_temp.cm_ok(pg_temp.cm_list(u_agent) = ARRAY[m1],
    'the owner does not list their private macro alone');
  n := n + 1; failed := failed || pg_temp.cm_check('the owner could not get their macro', NULL, NULL,
    format('SELECT (case_macro_get(%L, %L)).name', u_agent, m1), 'Follow up');
  n := n + 1; failed := failed || pg_temp.cm_ok(
    NOT (m1 = ANY (pg_temp.cm_list(u_agent2))) AND NOT (m1 = ANY (pg_temp.cm_list(u_admin)))
    AND NOT (m1 = ANY (pg_temp.cm_list(u_owner))) AND NOT (m1 = ANY (pg_temp.cm_list(u_bown))),
    'someone else lists the agent''s private macro');
  -- another person's private macro, and any other workspace's: not found
  FOREACH r IN ARRAY ARRAY[u_agent2::text, u_admin::text, u_owner::text, u_lead::text, u_bown::text] LOOP
    n := n + 1; failed := failed || pg_temp.cm_check(format('%s got the agent''s private macro', r), NULL, NULL,
      format('SELECT (case_macro_get(%L, %L)).name', r, m1), 'ERROR P0002 MACRO_NOT_FOUND%');
    n := n + 1; failed := failed || pg_temp.cm_check(format('%s updated the agent''s private macro', r), NULL, NULL,
      format('SELECT (case_macro_save(%L, %L, ''x'', %L::jsonb, false)).name', r, m1, good),
      'ERROR P0002 MACRO_NOT_FOUND%');
  END LOOP;
  FOREACH r IN ARRAY ARRAY[u_agent2::text, u_lead::text, u_bown::text] LOOP
    n := n + 1; failed := failed || pg_temp.cm_check(format('%s deleted the agent''s private macro', r), NULL, NULL,
      format('SELECT case_macro_delete(%L, %L)::text', r, m1), 'ERROR P0002 MACRO_NOT_FOUND%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cm_check('an unknown macro id', NULL, NULL,
    format('SELECT (case_macro_get(%L, %L)).name', u_agent, gen_random_uuid()), 'ERROR P0002 MACRO_NOT_FOUND%');

  -- ---------- who may save and share ----------
  FOREACH r IN ARRAY ARRAY[u_agent::text, u_lead::text] LOOP
    n := n + 1; failed := failed || pg_temp.cm_check(format('%s shared a macro', r), NULL, NULL,
      format('SELECT (case_macro_save(%L, NULL, ''team'', %L::jsonb, true)).macro_id::text', r, good),
      'ERROR 42501 NOT_ALLOWED%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cm_check('an agent shared their own macro on update', NULL, NULL,
    format('SELECT (case_macro_save(%L, %L, ''x'', %L::jsonb, true)).macro_id::text', u_agent, m1, good),
    'ERROR 42501 NOT_ALLOWED%');
  FOREACH r IN ARRAY ARRAY[u_viewer::text, gen_random_uuid()::text, 'NULL'] LOOP
    n := n + 1; failed := failed || pg_temp.cm_check(format('%s saved a macro', r), NULL, NULL,
      format('SELECT (case_macro_save(%s, NULL, ''mine'', %L::jsonb, false)).macro_id::text',
             CASE r WHEN 'NULL' THEN 'NULL::uuid' ELSE quote_literal(r) END, good), 'ERROR 42501 NOT_ALLOWED%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cm_check('case_macro_list without an actor', NULL, NULL,
    'SELECT count(*)::text FROM case_macro_list(NULL)', 'ERROR 42501 NOT_ALLOWED%');
  n := n + 1; failed := failed || pg_temp.cm_ok(
    NOT EXISTS (SELECT 1 FROM case_macros WHERE owner_user_id IN (u_viewer, u_lead) OR (owner_user_id = u_agent AND shared)),
    'a refused save wrote a macro');

  -- ---------- names ----------
  FOREACH r IN ARRAY ARRAY['NULL', '''''', format('%L', E'\t\n '), format('%L', repeat('n', 61))] LOOP
    n := n + 1; failed := failed || pg_temp.cm_check(format('case_macro_save accepted the name %s', left(r, 12)),
      NULL, NULL, format('SELECT (case_macro_save(%L, NULL, %s, %L::jsonb, false)).macro_id::text', u_agent, r, good),
      'ERROR 22023 NAME_INVALID%');
  END LOOP;

  -- ---------- actions ----------
  FOREACH r IN ARRAY ARRAY[
      '{"kind": "request_documents"}', '[]', 'null', '[1]', '[{"kind": 1}]', '[{"body": "x"}]',
      '[{"kind": "send_whatsapp"}]', '[{"kind": "request_documents", "x": 1}]',
      '[{"kind": "add_task", "ownerRole": "me"}]',
      '[{"kind": "add_task", "templateKey": "Call", "ownerRole": "me"}]',
      '[{"kind": "add_task", "templateKey": 7, "ownerRole": "me"}]',
      '[{"kind": "add_task", "templateKey": "' || repeat('a', 65) || '", "ownerRole": "me"}]',
      '[{"kind": "add_task", "templateKey": "a", "title": "t", "ownerRole": "me"}]',
      '[{"kind": "add_task", "templateKey": "a", "dueHours": 1.5, "ownerRole": "me"}]',
      '[{"kind": "add_task", "templateKey": "a", "dueHours": 0, "ownerRole": "me"}]',
      '[{"kind": "add_task", "templateKey": "a", "dueHours": -1, "ownerRole": "me"}]',
      '[{"kind": "add_task", "templateKey": "a", "dueHours": 8761, "ownerRole": "me"}]',
      '[{"kind": "add_task", "templateKey": "a", "dueHours": "24", "ownerRole": "me"}]',
      '[{"kind": "add_task", "templateKey": "a"}]',
      '[{"kind": "add_task", "templateKey": "a", "ownerRole": "admin"}]',
      '[{"kind": "add_note"}]', '[{"kind": "add_note", "body": " \t\n"}]',
      '[{"kind": "add_note", "body": "' || repeat('b', 4001) || '"}]', '[{"kind": "add_note", "body": 5}]',
      '[{"kind": "set_stage"}]', '[{"kind": "set_stage", "stage": "\t"}]',
      '[{"kind": "set_stage", "stage": "' || repeat('s', 61) || '"}]',
      '[{"kind": "set_stage", "stage": "X", "outcome": "Lost"}]',
      '[{"kind": "set_stage", "stage": "X", "outcome": null}]',
      '[{"kind": "request_documents"}, {"kind": "nope"}]'] LOOP
    n := n + 1; failed := failed || pg_temp.cm_check(format('case_macro_save accepted the actions %s', left(r, 70)),
      NULL, NULL, format('SELECT (case_macro_save(%L, NULL, ''x'', %L::jsonb, false)).macro_id::text', u_agent, r),
      'ERROR 22023 ACTION_INVALID%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cm_check('case_macro_save accepted 11 actions', NULL, NULL,
    format('SELECT (case_macro_save(%L, NULL, ''x'', %L::jsonb, false)).macro_id::text', u_agent,
      (SELECT jsonb_agg('{"kind": "request_documents"}'::jsonb) FROM generate_series(1, 11))),
    'ERROR 22023 ACTION_INVALID%');
  FOREACH r IN ARRAY ARRAY[
      '[{"kind": "add_task", "templateKey": "a_1", "dueHours": 1, "ownerRole": "me"}]',
      '[{"kind": "add_task", "templateKey": "' || repeat('a', 64) || '", "dueHours": 8760, "ownerRole": "coordinator"}]',
      '[{"kind": "add_note", "body": "' || repeat('b', 4000) || '"}]',
      '[{"kind": "set_stage", "stage": "' || repeat('s', 60) || '", "outcome": "Withdrawn"}]'] LOOP
    n := n + 1; failed := failed || pg_temp.cm_check(format('case_macro_save refused the actions %s', left(r, 70)),
      NULL, NULL, format('SELECT (case_macro_save(%L, NULL, ''ok'', %L::jsonb, false)).name', u_agent, r), 'ok');
  END LOOP;

  -- ---------- a shared macro ----------
  s1 := (case_macro_save(u_admin, NULL, 'Team macro', '[{"kind": "request_documents"}]', true)).macro_id;
  mb := (case_macro_save(u_bown, NULL, 'B macro', '[{"kind": "request_documents"}]', true)).macro_id;
  FOREACH r IN ARRAY ARRAY[u_owner::text, u_admin::text, u_lead::text, u_agent::text, u_agent2::text] LOOP
    n := n + 1; failed := failed || pg_temp.cm_ok(
      (pg_temp.cm_list(r::uuid))[1] = s1 AND NOT (mb = ANY (pg_temp.cm_list(r::uuid))),
      format('%s does not list the shared macro first, or lists another account''s', r));
    n := n + 1; failed := failed || pg_temp.cm_check(format('%s could not get the shared macro', r), NULL, NULL,
      format('SELECT (case_macro_get(%L, %L)).name', r, s1), 'Team macro');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cm_ok(
    pg_temp.cm_list(u_bown) = ARRAY[mb] AND pg_temp.cm_list(u_viewer) = '{}',
    'another account or a viewer lists this account''s macros');
  n := n + 1; failed := failed || pg_temp.cm_check('another account got the shared macro', NULL, NULL,
    format('SELECT (case_macro_get(%L, %L)).name', u_bown, s1), 'ERROR P0002 MACRO_NOT_FOUND%');
  n := n + 1; failed := failed || pg_temp.cm_check('a viewer got the shared macro', NULL, NULL,
    format('SELECT (case_macro_get(%L, %L)).name', u_viewer, s1), 'ERROR 42501 NOT_ALLOWED%');
  FOREACH r IN ARRAY ARRAY[u_agent::text, u_owner::text] LOOP
    n := n + 1; failed := failed || pg_temp.cm_check(format('%s (not its owner) updated the shared macro', r), NULL, NULL,
      format('SELECT (case_macro_save(%L, %L, ''x'', %L::jsonb, false)).name', r, s1, good),
      'ERROR 42501 NOT_ALLOWED%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cm_check('another account updated the shared macro', NULL, NULL,
    format('SELECT (case_macro_save(%L, %L, ''x'', %L::jsonb, true)).name', u_bown, s1, good),
    'ERROR P0002 MACRO_NOT_FOUND%');
  FOREACH r IN ARRAY ARRAY[u_agent2::text, u_lead::text] LOOP
    n := n + 1; failed := failed || pg_temp.cm_check(format('%s deleted the shared macro', r), NULL, NULL,
      format('SELECT case_macro_delete(%L, %L)::text', r, s1), 'ERROR 42501 NOT_ALLOWED%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cm_check('another account deleted the shared macro', NULL, NULL,
    format('SELECT case_macro_delete(%L, %L)::text', u_bown, s1), 'ERROR P0002 MACRO_NOT_FOUND%');
  n := n + 1; failed := failed || pg_temp.cm_check('the admin could not update their shared macro', NULL, NULL,
    format('SELECT (case_macro_save(%L, %L, ''Team v2'', %L::jsonb, true)).name', u_admin, s1, good), 'Team v2');
  n := n + 1; failed := failed || pg_temp.cm_check('the owner could not update their macro', NULL, NULL,
    format('SELECT (case_macro_save(%L, %L, ''Renamed'', ''[{"kind": "add_note", "body": "hi"}]'', false)).name',
      u_agent, m1), 'Renamed');
  n := n + 1; failed := failed || pg_temp.cm_ok(
    (SELECT x.actions = '[{"kind": "add_note", "body": "hi"}]'::jsonb AND x.macro_id = m1 AND NOT x.shared
            AND x.updated_at >= x.created_at FROM case_macros x WHERE x.macro_id = m1)
    AND (SELECT x.shared AND x.actions = good FROM case_macros x WHERE x.macro_id = s1),
    'an update did not replace the name and actions in place');
  n := n + 1; failed := failed || pg_temp.cm_check('the admin could not unshare their macro', NULL, NULL,
    format('SELECT (case_macro_save(%L, %L, ''Team v2'', %L::jsonb, false)).shared::text', u_admin, s1, good), 'false');
  n := n + 1; failed := failed || pg_temp.cm_ok(NOT (s1 = ANY (pg_temp.cm_list(u_agent))),
    'an unshared macro is still listed to others');
  PERFORM case_macro_save(u_admin, s1, 'Team v2', good, true);

  -- ---------- RLS reads; no direct writes ----------
  n := n + 1; failed := failed || pg_temp.cm_ok(s1 = ANY (pg_temp.cm_list(u_agent)) AND m1 = ANY (pg_temp.cm_list(u_agent)),
    'the agent does not list own + shared');
  n := n + 1; failed := failed || pg_temp.cm_check('RLS: the agent does not read what case_macro_list lists',
    'authenticated', u_agent,
    'SELECT string_agg(macro_id::text, '','' ORDER BY shared DESC, name, macro_id) FROM case_macros',
    array_to_string(pg_temp.cm_list(u_agent), ','));
  n := n + 1; failed := failed || pg_temp.cm_check('RLS: agent2 reads someone else''s private macro', 'authenticated',
    u_agent2, 'SELECT string_agg(macro_id::text, '','') FROM case_macros WHERE owner_user_id <> auth.uid()', s1::text);
  n := n + 1; failed := failed || pg_temp.cm_check('RLS: another account reads this one''s macros', 'authenticated',
    u_bown, 'SELECT string_agg(macro_id::text, '','') FROM case_macros', mb::text);
  FOREACH r IN ARRAY ARRAY['authenticated', 'service_role', 'anon'] LOOP
    n := n + 1; failed := failed || pg_temp.cm_check(format('%s inserted a macro directly', r), r, u_admin,
      format('INSERT INTO case_macros (account_id, owner_user_id, name, actions) VALUES (%L, %L, ''x'', %L::jsonb)',
        a_acct, u_admin, good), 'ERROR 42501 %');
    n := n + 1; failed := failed || pg_temp.cm_check(format('%s updated a macro directly', r), r, u_agent,
      format('UPDATE case_macros SET shared = true WHERE macro_id = %L', m1), 'ERROR 42501 %');
    n := n + 1; failed := failed || pg_temp.cm_check(format('%s deleted a macro directly', r), r, u_agent,
      format('DELETE FROM case_macros WHERE macro_id = %L', m1), 'ERROR 42501 %');
  END LOOP;

  -- ---------- the apply log ----------
  l1 := case_macro_log_apply(u_agent, k1, m1,
          '[{"kind": "add_task", "ok": true, "refusal": null}, {"kind": "add_note", "ok": false, "refusal": "NOT_ALLOWED"}]',
          '2026-01-02 03:04:05+00');
  n := n + 1; failed := failed || pg_temp.cm_ok(
    (SELECT x.account_id = a_acct AND x.case_id = k1 AND x.macro_id = m1 AND x.actor_id = u_agent
            AND x.actor_role = 'agent' AND x.at = '2026-01-02 03:04:05+00'
            AND x.applied = '[{"kind": "add_task", "ok": true, "refusal": null}, {"kind": "add_note", "ok": false, "refusal": "NOT_ALLOWED"}]'::jsonb
       FROM case_macro_log x WHERE x.id = l1),
    'the agent''s apply was not logged as given (role agent, applied with its refusal, clock)');
  l2 := case_macro_log_apply(u_owner, k1, s1, '[{"kind": "request_documents", "ok": true}]', NULL);
  n := n + 1; failed := failed || pg_temp.cm_ok(
    (SELECT x.actor_role = 'super_admin' AND x.macro_id = s1 AND x.at IS NOT NULL FROM case_macro_log x WHERE x.id = l2)
    AND (SELECT x.actor_role FROM case_macro_log x WHERE x.id = l2) = case_role(k1, u_owner),
    'the owner''s apply of a shared macro was not logged with role super_admin (= case_role)');
  n := n + 1; failed := failed || pg_temp.cm_check('the admin could not log a shared macro on k2', NULL, NULL,
    format('SELECT (case_macro_log_apply(%L, %L, %L, ''[{"kind": "set_stage", "ok": false, "refusal": "STAGE_INVALID"}]'', NULL)
            IS NOT NULL)::text', u_admin, k2, s1), 'true');
  n := n + 1; failed := failed || pg_temp.cm_ok(
    (SELECT x.actor_role FROM case_macro_log x WHERE x.case_id = k2) = 'admin',
    'the admin''s apply was not logged with role admin');
  n := n + 1; failed := failed || pg_temp.cm_check('the agent logged on a case they cannot read', NULL, NULL,
    format('SELECT case_macro_log_apply(%L, %L, %L, ''[{"kind": "add_task", "ok": true}]'', NULL)::text', u_agent, k2, m1),
    'ERROR P0002 CASE_NOT_FOUND%');
  n := n + 1; failed := failed || pg_temp.cm_check('the agent logged on another account''s case', NULL, NULL,
    format('SELECT case_macro_log_apply(%L, %L, %L, ''[{"kind": "add_task", "ok": true}]'', NULL)::text', u_agent, kb, m1),
    'ERROR P0002 CASE_NOT_FOUND%');
  n := n + 1; failed := failed || pg_temp.cm_check('account B logged its macro on this account''s case', NULL, NULL,
    format('SELECT case_macro_log_apply(%L, %L, %L, ''[{"kind": "add_task", "ok": true}]'', NULL)::text', u_bown, k1, mb),
    'ERROR P0002 CASE_NOT_FOUND%');
  n := n + 1; failed := failed || pg_temp.cm_check('an unknown case', NULL, NULL,
    format('SELECT case_macro_log_apply(%L, %L, %L, ''[{"kind": "add_task", "ok": true}]'', NULL)::text',
      u_owner, gen_random_uuid(), s1), 'ERROR P0002 CASE_NOT_FOUND%');
  n := n + 1; failed := failed || pg_temp.cm_check('agent2 logged the agent''s private macro', NULL, NULL,
    format('SELECT case_macro_log_apply(%L, %L, %L, ''[{"kind": "add_task", "ok": true}]'', NULL)::text', u_agent2, k2, m1),
    'ERROR P0002 MACRO_NOT_FOUND%');
  n := n + 1; failed := failed || pg_temp.cm_check('a viewer logged an apply', NULL, NULL,
    format('SELECT case_macro_log_apply(%L, %L, %L, ''[{"kind": "add_task", "ok": true}]'', NULL)::text', u_viewer, k1, s1),
    'ERROR 42501 NOT_ALLOWED%');
  FOREACH r IN ARRAY ARRAY['[]', 'null', '{"kind": "add_task", "ok": true}', '[1]',
      '[{"kind": "add_task", "ok": "yes"}]', '[{"kind": "add_task"}]', '[{"ok": true}]',
      '[{"kind": "send_whatsapp", "ok": true}]', '[{"kind": "add_task", "ok": true, "body": "x"}]',
      '[{"kind": "add_task", "ok": false, "refusal": 42}]',
      '[{"kind": "add_task", "ok": false, "refusal": "' || repeat('r', 201) || '"}]'] LOOP
    n := n + 1; failed := failed || pg_temp.cm_check(format('case_macro_log_apply accepted %s', left(r, 60)), NULL, NULL,
      format('SELECT case_macro_log_apply(%L, %L, %L, %L::jsonb, NULL)::text', u_agent, k1, m1, r),
      'ERROR 22023 ACTION_INVALID%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cm_check('case_macro_log_apply accepted 11 results', NULL, NULL,
    format('SELECT case_macro_log_apply(%L, %L, %L, %L::jsonb, NULL)::text', u_agent, k1, m1,
      (SELECT jsonb_agg('{"kind": "add_note", "ok": true}'::jsonb) FROM generate_series(1, 11))),
    'ERROR 22023 ACTION_INVALID%');
  n := n + 1; failed := failed || pg_temp.cm_check('case_macro_log_apply refused a 200-character refusal', NULL, NULL,
    format('SELECT (case_macro_log_apply(%L, %L, %L, %L::jsonb, NULL) IS NOT NULL)::text', u_agent, k1, m1,
      '[{"kind": "add_task", "ok": false, "refusal": "' || repeat('r', 200) || '"}]'), 'true');
  n := n + 1; failed := failed || pg_temp.cm_ok((SELECT count(*) FROM case_macro_log WHERE case_id IN (k1, k2, kb)) = 4,
    'a refused log_apply wrote a row');

  -- append-only, for every writer
  FOREACH st IN ARRAY ARRAY['UPDATE case_macro_log SET actor_role = ''admin''', 'DELETE FROM case_macro_log',
                           'TRUNCATE case_macro_log'] LOOP
    n := n + 1; failed := failed || pg_temp.cm_check(format('the table owner ran %s', st), NULL, NULL, st,
      'ERROR 42501 %append-only%');
  END LOOP;
  FOREACH st IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    n := n + 1; failed := failed || pg_temp.cm_check(format('%s wrote the macro log', st), st, u_owner,
      format('INSERT INTO case_macro_log (account_id, case_id, macro_id, actor_id, actor_role, applied, at)
              VALUES (%L, %L, %L, %L, ''super_admin'', ''[]'', now())', a_acct, k1, m1, u_owner), 'ERROR 42501 %');
    n := n + 1; failed := failed || pg_temp.cm_check(format('%s updated the macro log', st), st, u_owner,
      'UPDATE case_macro_log SET actor_role = ''admin''', 'ERROR 42501 %');
    n := n + 1; failed := failed || pg_temp.cm_check(format('%s deleted the macro log', st), st, u_owner,
      'DELETE FROM case_macro_log', 'ERROR 42501 %');
  END LOOP;
  -- RLS: log rows of cases the reader can read, in their active account
  n := n + 1; failed := failed || pg_temp.cm_check('RLS: the agent does not read the log of k1 alone', 'authenticated',
    u_agent, format('SELECT count(*)::text FROM case_macro_log WHERE case_id <> %L', k1), '0');
  n := n + 1; failed := failed || pg_temp.cm_check('RLS: the agent does not read the log of k1', 'authenticated',
    u_agent, 'SELECT count(*)::text FROM case_macro_log', '3');
  n := n + 1; failed := failed || pg_temp.cm_check('RLS: agent2 does not read the log of k2 alone', 'authenticated',
    u_agent2, 'SELECT string_agg(DISTINCT case_id::text, '','') FROM case_macro_log', k2::text);
  n := n + 1; failed := failed || pg_temp.cm_check('RLS: the owner does not read the account''s log', 'authenticated',
    u_owner, 'SELECT count(*)::text FROM case_macro_log', '4');
  FOREACH st IN ARRAY ARRAY[u_viewer::text, u_bown::text] LOOP
    n := n + 1; failed := failed || pg_temp.cm_check(format('RLS: %s reads the macro log', st), 'authenticated',
      st::uuid, 'SELECT count(*)::text FROM case_macro_log', '0');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cm_check('anon read the macro log', 'anon', NULL,
    'SELECT count(*)::text FROM case_macro_log', 'ERROR 42501 %');

  -- ---------- deleting ----------
  n := n + 1; failed := failed || pg_temp.cm_check('the admin could not delete the agent''s private macro', NULL, NULL,
    format('SELECT case_macro_delete(%L, %L)::text', u_admin, m1), '');
  n := n + 1; failed := failed || pg_temp.cm_ok(NOT EXISTS (SELECT 1 FROM case_macros WHERE macro_id = m1),
    'the admin''s delete left the private macro');
  n := n + 1; failed := failed || pg_temp.cm_ok(
    (SELECT count(*) FROM case_macro_log WHERE macro_id = m1) = 2
    AND EXISTS (SELECT 1 FROM case_macro_log WHERE id = l1 AND macro_id = m1),
    'the log did not survive its macro''s deletion');
  m1 := (case_macro_save(u_agent, NULL, 'Again', good, false)).macro_id;
  n := n + 1; failed := failed || pg_temp.cm_check('the owner could not delete their macro', NULL, NULL,
    format('SELECT case_macro_delete(%L, %L)::text', u_agent, m1), '');
  m1 := (case_macro_save(u_agent2, NULL, 'Third', good, false)).macro_id;
  n := n + 1; failed := failed || pg_temp.cm_check('the workspace owner could not delete an agent''s private macro',
    NULL, NULL, format('SELECT case_macro_delete(%L, %L)::text', u_owner, m1), '');
  n := n + 1; failed := failed || pg_temp.cm_check('the workspace owner could not delete the admin''s shared macro',
    NULL, NULL, format('SELECT case_macro_delete(%L, %L)::text', u_owner, s1), '');
  n := n + 1; failed := failed || pg_temp.cm_ok(
    NOT EXISTS (SELECT 1 FROM case_macros WHERE account_id = a_acct AND name IN ('Again', 'Third', 'Team v2')),
    'a deleted macro is still there');
  n := n + 1; failed := failed || pg_temp.cm_check('a deleted macro deleted again', NULL, NULL,
    format('SELECT case_macro_delete(%L, %L)::text', u_owner, s1), 'ERROR P0002 MACRO_NOT_FOUND%');
  n := n + 1; failed := failed || pg_temp.cm_check('a deleted macro logged', NULL, NULL,
    format('SELECT case_macro_log_apply(%L, %L, %L, ''[{"kind": "add_task", "ok": true}]'', NULL)::text', u_owner, k1, s1),
    'ERROR P0002 MACRO_NOT_FOUND%');
  n := n + 1; failed := failed || pg_temp.cm_check('a viewer deleted a macro', NULL, NULL,
    format('SELECT case_macro_delete(%L, %L)::text', u_viewer, mb), 'ERROR 42501 NOT_ALLOWED%');

  -- ---------- grants: service_role only ----------
  FOREACH st IN ARRAY ARRAY['case_macro_list(uuid)', 'case_macro_get(uuid,uuid)',
                           'case_macro_save(uuid,uuid,text,jsonb,boolean)', 'case_macro_delete(uuid,uuid)',
                           'case_macro_log_apply(uuid,uuid,uuid,jsonb,timestamptz)'] LOOP
    n := n + 1; failed := failed || pg_temp.cm_ok(
      has_function_privilege('service_role', ('public.' || st)::regprocedure, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', ('public.' || st)::regprocedure, 'EXECUTE')
      AND NOT has_function_privilege('anon', ('public.' || st)::regprocedure, 'EXECUTE'),
      format('%s is not executable by service_role alone', st));
  END LOOP;
  FOREACH st IN ARRAY ARRAY['case_macro_action_refuse(integer,text)', 'case_macro_validate_actions(jsonb)'] LOOP
    n := n + 1; failed := failed || pg_temp.cm_ok(
      NOT has_function_privilege('service_role', ('public.' || st)::regprocedure, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', ('public.' || st)::regprocedure, 'EXECUTE')
      AND NOT has_function_privilege('anon', ('public.' || st)::regprocedure, 'EXECUTE'),
      format('the internal %s is executable by an API role', st));
  END LOOP;
  FOREACH st IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    n := n + 1; failed := failed || pg_temp.cm_check(format('%s called case_macro_save', st), st, u_owner,
      format('SELECT (case_macro_save(%L, NULL, ''x'', %L::jsonb, false)).name', u_owner, good), 'ERROR 42501 %');
    n := n + 1; failed := failed || pg_temp.cm_check(format('%s called case_macro_list', st), st, u_owner,
      format('SELECT count(*)::text FROM case_macro_list(%L)', u_owner), 'ERROR 42501 %');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cm_ok(
    (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'public.case_macros'::regclass)
    AND (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'public.case_macro_log'::regclass),
    'case_macros / case_macro_log are not RLS-forced');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT186', MESSAGE = 'verify-case-macros rollback';
  EXCEPTION WHEN SQLSTATE 'ZT186' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'case macros verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'case macros verification passed (% checks)', n;
END
$verify$;
