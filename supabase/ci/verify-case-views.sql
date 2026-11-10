-- Behavioural regression suite for saved inbox views, snooze and the
-- mentions inbox (migration 185) over the coordinator inbox (125/162).
--
-- Unchanged default: with nothing snoozed, case_inbox returns exactly
-- the same rows in the same order with no snoozed filter as with the
-- explicit defaults, for every persona and sort. Views: a private view
-- is the owner's alone (VIEW_NOT_FOUND to anyone else, never
-- NOT_ALLOWED), only owners/admins share, another workspace sees
-- nothing, only the owner updates, an admin deletes any view, and the
-- one validator refuses an unknown key, a bad value and a sort inside
-- the filters (FILTER_INVALID), in case_view_save and case_inbox alike.
-- Snooze: the coordinator (named or bank holder), team lead, admin and
-- owner may; an agent, a viewer, another team's lead and another
-- workspace may not; until in (now, now + 30 days]; closed and unknown
-- cases refused; hidden by default, listed by 'only' / 'all';
-- snooze_expired marks a snooze that ended within 24 hours; no SLA
-- timer or log row moves and a snooze is not a touch; every snooze and
-- unsnooze is logged append-only. Mentions: newest first, keyset
-- paging, readable cases only, the mentioned_me filter. A system note
-- (179) does not change a case's last touch. Grants: service_role only.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back on success too (a sentinel exception ends the block), and
-- failing assertions are named in the final exception.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000185001';
  u_admin  UUID := '00000000-0000-4000-8000-000000185002';
  u_lead   UUID := '00000000-0000-4000-8000-000000185003';  -- team_leader, leads T1 (u_agent)
  u_coord  UUID := '00000000-0000-4000-8000-000000185004';  -- agent role; named coordinator of k1
  u_hold   UUID := '00000000-0000-4000-8000-000000185005';  -- agent role; holds ENBD (coordinator of k2)
  u_agent  UUID := '00000000-0000-4000-8000-000000185006';  -- agent of k1, k2, k3, k5
  u_agent2 UUID := '00000000-0000-4000-8000-000000185007';  -- agent of k4, in no team
  u_viewer UUID := '00000000-0000-4000-8000-000000185008';
  u_bown   UUID := '00000000-0000-4000-8000-000000185009';  -- owner of account B
  a_acct   UUID;
  b_acct   UUID;
  wa       UUID;
  wb       UUID;
  ca       UUID;
  cb       UUID;
  team1    UUID;
  g        UUID[] := '{}';
  gb       UUID;
  k1       UUID;  -- ADCB, SLA timers, coordinator u_coord
  k2       UUID;  -- ENBD, no coordinator (u_hold holds the bank)
  k3       UUID;  -- ADCB
  k4       UUID;  -- no bank, agent u_agent2 (outside u_lead's team)
  k5       UUID;  -- ENBD, closed
  kb       UUID;  -- account B
  v1       UUID;  -- u_agent's private view
  s1       UUID;  -- u_admin's shared view
  nt1      UUID;
  nt2      UUID;
  nt3      UUID;
  nt4      UUID;
  t0       TIMESTAMPTZ := now();
  usr      UUID[];
  lbl      TEXT[];
  sorts    TEXT[] := ARRAY['most_overdue', 'due_soonest', 'stalest'];
  i        INT;
  j        INT;
  ids      UUID[];
  acc      UUID[];
  cur      TEXT;
  r        TEXT;
  r2       TEXT;
  st       TEXT;
  ts1      TIMESTAMPTZ;
  w1       BIGINT;
  b1       BOOLEAN;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (NULL: as the current user) signed in as
  -- p_uid: a SELECT's value, 'ok', or 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cv_try(p_role text, p_uid uuid, p_sql text)
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
    CREATE FUNCTION pg_temp.cv_check(p_name text, p_role text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.cv_try(p_role, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cv_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- The case ids the inbox lists (limit 200) in its own order.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cv_ids(p_actor uuid, p_acct uuid, p_filters jsonb, p_now timestamptz)
    RETURNS uuid[] LANGUAGE sql AS $body$
      SELECT coalesce(array_agg(x.case_id ORDER BY x.ordinality), '{}')
        FROM public.case_inbox(p_actor, p_acct, p_filters, p_now, 200) WITH ORDINALITY x
    $body$
  $fn$;
  -- Every row of p_fn's answer (limit 200) as JSON text, in its order.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cv_rows(p_fn text, p_actor uuid, p_acct uuid, p_filters jsonb, p_now timestamptz)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      EXECUTE format('SELECT coalesce(string_agg((to_jsonb(x) - ''snoozed_until'' - ''snooze_expired'')::text, '' | ''
                        ORDER BY x.ordinality), '''') FROM public.%I($1, $2, $3, $4, 200) WITH ORDINALITY x', p_fn)
        INTO v USING p_actor, p_acct, p_filters, p_now;
      RETURN v;
    END $body$
  $fn$;
  -- The SLA state of a case: timers and log rows as text.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cv_sla(p_case uuid) RETURNS text LANGUAGE sql AS $body$
      SELECT coalesce((SELECT string_agg(to_jsonb(t)::text, ',' ORDER BY t.timer) FROM public.case_sla_timers t
                        WHERE t.case_id = p_case), '-')
             || ' / ' || (SELECT count(*) FROM public.case_sla_state_log l WHERE l.case_id = p_case)::text
             || ' / ' || coalesce((SELECT c.sla_state || ' ' || coalesce(c.due_at::text, '-')
                                     FROM public.cases c WHERE c.id = p_case), '-')
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'cv-owner@example.invalid'),
    (u_admin,  'cv-admin@example.invalid'),
    (u_lead,   'cv-lead@example.invalid'),
    (u_coord,  'cv-coord@example.invalid'),
    (u_hold,   'cv-hold@example.invalid'),
    (u_agent,  'cv-agent@example.invalid'),
    (u_agent2, 'cv-agent2@example.invalid'),
    (u_viewer, 'cv-viewer@example.invalid'),
    (u_bown,   'cv-bown@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_bown;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_coord, u_hold, u_agent, u_agent2);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;

  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'CV T1', u_lead) RETURNING id INTO team1;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (team1, u_agent, a_acct);

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CV-185-A1', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_bown, b_acct, 'whapi', 'CV-185-B1', 'x', 'connected', true) RETURNING id INTO wb;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500185001', 'CV one')
    RETURNING id INTO ca;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b_acct, u_bown, '971500185002', 'CV bee')
    RETURNING id INTO cb;

  PERFORM case_bank_upsert(u_owner, a_acct, 'ADCB', 'ADCB Bank');
  PERFORM case_bank_upsert(u_owner, a_acct, 'ENBD', 'Emirates NBD');
  PERFORM case_sla_config_upsert(u_owner, a_acct, 'ADCB', 'Submitted', 'customer_reply', 60, 'minutes');
  PERFORM case_sla_config_upsert(u_owner, a_acct, 'ADCB', 'Submitted', 'bank_response', 2, 'days');
  INSERT INTO coordinator_banks (account_id, user_id, bank_code, created_by) VALUES (a_acct, u_hold, 'ENBD', u_owner);

  FOR i IN 1 .. 5 LOOP
    g[i] := (SELECT x.group_id FROM sg_open(a_acct, 'CV-185-' || i, ca, wa, 'views ' || i, NULL, CASE i
        WHEN 1 THEN jsonb_build_array(jsonb_build_object('user_id', u_coord, 'label', 'coordinator'),
                                      jsonb_build_object('user_id', u_agent, 'label', 'agent'))
        WHEN 4 THEN jsonb_build_array(jsonb_build_object('user_id', u_agent2, 'label', 'agent'))
        ELSE jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')) END, NULL) x);
    IF g[i] IS NULL THEN RAISE EXCEPTION 'fixture: sg_open returned no group %', i; END IF;
  END LOOP;
  gb := (SELECT x.group_id FROM sg_open(b_acct, 'CV-185-B', cb, wb, 'views b', NULL,
    jsonb_build_array(jsonb_build_object('user_id', u_bown, 'label', 'agent')), NULL) x);
  k1 := (SELECT x.case_id FROM case_open(g[1], 'ADCB', NULL, 'Loan', 1000, NULL) x);
  k2 := (SELECT x.case_id FROM case_open(g[2], 'ENBD', NULL, 'Loan', 2000, NULL) x);
  k3 := (SELECT x.case_id FROM case_open(g[3], 'ADCB', NULL, 'Card', 3000, NULL) x);
  k4 := (SELECT x.case_id FROM case_open(g[4], NULL, NULL, NULL, NULL, NULL) x);
  k5 := (SELECT x.case_id FROM case_open(g[5], 'ENBD', NULL, 'Card', NULL, NULL) x);
  kb := (SELECT x.case_id FROM case_open(gb, NULL, NULL, NULL, NULL, NULL) x);
  IF k1 IS NULL OR k2 IS NULL OR k3 IS NULL OR k4 IS NULL OR k5 IS NULL OR kb IS NULL THEN
    RAISE EXCEPTION 'fixture: case_open returned no case';
  END IF;
  UPDATE cases SET due_at = t0 + interval '1 day' WHERE id = k2;
  UPDATE cases SET priority = 'high', due_at = t0 + interval '2 days' WHERE id = k3;
  PERFORM case_set_stage(k5, u_owner, 'Closed', NULL, false);
  PERFORM case_note_add(k3, u_agent, 'first call', t0 + interval '3 minutes');
  IF (SELECT count(*) FROM case_sla_timers WHERE case_id = k1 AND stopped_at IS NULL) = 0 THEN
    RAISE EXCEPTION 'fixture: k1 runs no SLA timer';
  END IF;
  usr := ARRAY[u_owner, u_admin, u_lead, u_coord, u_hold, u_agent, u_agent2, u_viewer, u_bown];
  lbl := ARRAY['owner', 'admin', 'team lead', 'coordinator', 'bank holder', 'agent', 'agent2', 'viewer', 'B owner'];

  -- ---------- unchanged default (nothing snoozed) ----------
  FOR i IN 1 .. array_length(usr, 1) LOOP
    FOR j IN 1 .. 3 LOOP
      r := pg_temp.cv_rows('case_inbox', usr[i], a_acct, jsonb_build_object('sort', sorts[j]), t0 + interval '70 minutes');
      r2 := pg_temp.cv_rows('case_inbox', usr[i], a_acct,
              jsonb_build_object('sort', sorts[j], 'snoozed', 'hide'), t0 + interval '70 minutes');
      st := pg_temp.cv_rows('case_inbox', usr[i], a_acct,
              jsonb_build_object('sort', sorts[j], 'snoozed', 'all'), t0 + interval '70 minutes');
      n := n + 1; failed := failed || pg_temp.cv_ok(r = r2 AND r = st,
        format('with nothing snoozed the %s''s inbox (sort %s) differs from snoozed hide / all', lbl[i], sorts[j]));
    END LOOP;
    r := pg_temp.cv_rows('case_inbox', usr[i], a_acct, '{"include_closed": true}', t0);
    r2 := pg_temp.cv_rows('case_inbox', usr[i], a_acct, '{"include_closed": true, "snoozed": "hide"}', t0);
    n := n + 1; failed := failed || pg_temp.cv_ok(r = r2,
      format('with nothing snoozed the %s''s inbox with closed cases differs from snoozed hide', lbl[i]));
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cv_ok(
    pg_temp.cv_ids(u_owner, a_acct, '{}', t0) @> ARRAY[k1, k2, k3, k4]
    AND cardinality(pg_temp.cv_ids(u_owner, a_acct, '{}', t0)) = 4
    AND NOT EXISTS (SELECT 1 FROM case_inbox(u_owner, a_acct, '{"include_closed": true}', t0, 200) x
                     WHERE x.snoozed_until IS NOT NULL OR x.snooze_expired),
    'the owner''s default inbox is not the four open cases with no snooze marks');
  n := n + 1; failed := failed || pg_temp.cv_ok(
    pg_temp.cv_ids(u_coord, a_acct, '{}', t0) = ARRAY[k1]
    AND pg_temp.cv_ids(u_hold, a_acct, '{}', t0) = ARRAY[k2]
    AND pg_temp.cv_ids(u_viewer, a_acct, '{}', t0) = '{}'
    AND pg_temp.cv_ids(u_bown, a_acct, '{}', t0) = '{}',
    'default visibility moved (coordinator, bank holder, viewer, other workspace)');

  -- ---------- the validator ----------
  FOREACH r IN ARRAY ARRAY['{"nope": 1}', '{"snoozed": "later"}', '{"snoozed": true}', '{"snooze_expired": 1}',
                           '{"mentioned_me": "yes"}', '{"priority": "x"}', '{"no_activity_days": 0}',
                           '{"agent": "not-a-uuid"}', '{"bank": "  "}', '{"sort": "stalest"}', '[]'] LOOP
    n := n + 1; failed := failed || pg_temp.cv_check(format('the validator accepted %s', r), NULL, NULL,
      format('SELECT case_inbox_validate_filters(%L::jsonb)::text', r), 'ERROR 22023 FILTER_INVALID%');
    n := n + 1; failed := failed || pg_temp.cv_check(format('case_view_save accepted filters %s', r), NULL, NULL,
      format('SELECT (case_view_save(%L, NULL, ''x'', %L::jsonb, NULL, false)).view_id::text', u_agent, r),
      'ERROR 22023 FILTER_INVALID%');
    IF r <> '{"sort": "stalest"}' THEN
      n := n + 1; failed := failed || pg_temp.cv_check(format('case_inbox accepted filters %s', r), NULL, NULL,
        format('SELECT count(*)::text FROM case_inbox(%L, %L, %L::jsonb, %L)', u_owner, a_acct, r, t0),
        'ERROR 22023 FILTER_INVALID%');
    END IF;
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cv_check('the inbox refused its sort inside the filters, or a new key', NULL, NULL,
    format('SELECT count(*)::text FROM case_inbox(%L, %L, ''{"sort": "stalest", "snoozed": "all", "mentioned_me": false, "snooze_expired": false}'', %L)',
      u_owner, a_acct, t0), '4');
  n := n + 1; failed := failed || pg_temp.cv_check('the validator refused a full valid filter set', NULL, NULL,
    format('SELECT case_inbox_validate_filters(%L::jsonb)::text', jsonb_build_object('bank', 'ADCB', 'stage', 'Submitted',
      'agent', u_agent, 'priority', 'high', 'sla_state', 'overdue', 'customer_waiting', true, 'documents_missing', false,
      'bank_query_open', false, 'no_activity_days', 3, 'include_closed', true, 'snoozed', 'only',
      'snooze_expired', true, 'mentioned_me', true)), '');
  n := n + 1; failed := failed || pg_temp.cv_check('case_view_save accepted an unknown sort', NULL, NULL,
    format('SELECT (case_view_save(%L, NULL, ''x'', ''{}'', ''newest'', false)).view_id::text', u_agent),
    'ERROR 22023 FILTER_INVALID%');

  -- ---------- saved views ----------
  FOREACH r IN ARRAY ARRAY['NULL', '''''', format('%L', E'\t\n '), format('%L', repeat('n', 61))] LOOP
    n := n + 1; failed := failed || pg_temp.cv_check(format('case_view_save accepted the name %s', left(r, 12)),
      NULL, NULL, format('SELECT (case_view_save(%L, NULL, %s, ''{}'', NULL, false)).view_id::text', u_agent, r),
      'ERROR 22023 NAME_INVALID%');
  END LOOP;
  v1 := (case_view_save(u_agent, NULL, '  My ADCB  ', '{"bank": "ADCB", "snoozed": "all"}', 'stalest', false)).view_id;
  n := n + 1; failed := failed || pg_temp.cv_ok(
    (SELECT x.name = 'My ADCB' AND x.account_id = a_acct AND x.owner_user_id = u_agent AND NOT x.shared
            AND x.sort = 'stalest' AND x.filters = '{"bank": "ADCB", "snoozed": "all"}'::jsonb
       FROM case_saved_views x WHERE x.view_id = v1),
    'a private view was not stored as given (trimmed name, filters, sort, owner, account)');
  n := n + 1; failed := failed || pg_temp.cv_check('a 60-character name was refused', NULL, NULL,
    format('SELECT (case_view_save(%L, NULL, %L, ''{}'', NULL, false)).name', u_agent2, repeat('n', 60)),
    repeat('n', 60));
  FOREACH r IN ARRAY ARRAY[u_agent::text, u_lead::text, u_coord::text] LOOP
    n := n + 1; failed := failed || pg_temp.cv_check(format('%s shared a view', r), NULL, NULL,
      format('SELECT (case_view_save(%L, NULL, ''team'', ''{}'', NULL, true)).view_id::text', r),
      'ERROR 42501 NOT_ALLOWED%');
  END LOOP;
  FOREACH r IN ARRAY ARRAY[u_viewer::text, gen_random_uuid()::text, 'NULL'] LOOP
    n := n + 1; failed := failed || pg_temp.cv_check(format('%s saved a view', r), NULL, NULL,
      format('SELECT (case_view_save(%s, NULL, ''mine'', ''{}'', NULL, false)).view_id::text',
             CASE r WHEN 'NULL' THEN 'NULL::uuid' ELSE quote_literal(r) END), 'ERROR 42501 NOT_ALLOWED%');
  END LOOP;
  s1 := (case_view_save(u_admin, NULL, 'Overdue for all', '{"sla_state": "overdue"}', NULL, true)).view_id;
  n := n + 1; failed := failed || pg_temp.cv_ok(
    (SELECT array_agg(x.view_id ORDER BY x.ordinality) FROM case_view_list(u_agent) WITH ORDINALITY x)
      = ARRAY[s1, v1],
    'the agent''s list is not the shared view, then their own');
  n := n + 1; failed := failed || pg_temp.cv_ok(
    (SELECT coalesce(array_agg(x.view_id), '{}') FROM case_view_list(u_agent2) x WHERE x.view_id <> s1
       AND x.owner_user_id <> u_agent2) = '{}'
    AND EXISTS (SELECT 1 FROM case_view_list(u_agent2) x WHERE x.view_id = s1),
    'another agent sees someone else''s private view or misses the shared one');
  n := n + 1; failed := failed || pg_temp.cv_ok(
    NOT EXISTS (SELECT 1 FROM case_view_list(u_bown) x WHERE x.account_id = a_acct)
    AND NOT EXISTS (SELECT 1 FROM case_view_list(u_viewer)),
    'another workspace or a viewer lists this workspace''s views');
  n := n + 1; failed := failed || pg_temp.cv_check('case_view_list without an actor', NULL, NULL,
    'SELECT count(*)::text FROM case_view_list(NULL)', 'ERROR 42501 NOT_ALLOWED%');
  -- another person's private view, and any other workspace's view: not found
  FOREACH r IN ARRAY ARRAY[u_agent2::text, u_lead::text, u_bown::text] LOOP
    n := n + 1; failed := failed || pg_temp.cv_check(format('%s updated the agent''s private view', r), NULL, NULL,
      format('SELECT (case_view_save(%L, %L, ''x'', ''{}'', NULL, false)).view_id::text', r, v1),
      'ERROR P0002 VIEW_NOT_FOUND%');
    n := n + 1; failed := failed || pg_temp.cv_check(format('%s deleted the agent''s private view', r), NULL, NULL,
      format('SELECT case_view_delete(%L, %L)::text', r, v1), 'ERROR P0002 VIEW_NOT_FOUND%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cv_check('another workspace''s owner deleted a shared view', NULL, NULL,
    format('SELECT case_view_delete(%L, %L)::text', u_bown, s1), 'ERROR P0002 VIEW_NOT_FOUND%');
  n := n + 1; failed := failed || pg_temp.cv_check('the admin updated the agent''s private view', NULL, NULL,
    format('SELECT (case_view_save(%L, %L, ''x'', ''{}'', NULL, false)).view_id::text', u_admin, v1),
    'ERROR P0002 VIEW_NOT_FOUND%');
  n := n + 1; failed := failed || pg_temp.cv_check('a non-owner updated a shared view', NULL, NULL,
    format('SELECT (case_view_save(%L, %L, ''x'', ''{}'', NULL, false)).view_id::text', u_agent, s1),
    'ERROR 42501 NOT_ALLOWED%');
  n := n + 1; failed := failed || pg_temp.cv_check('the owner (role) updated the admin''s shared view', NULL, NULL,
    format('SELECT (case_view_save(%L, %L, ''x'', ''{}'', NULL, true)).view_id::text', u_owner, s1),
    'ERROR 42501 NOT_ALLOWED%');
  n := n + 1; failed := failed || pg_temp.cv_check('an agent deleted a shared view', NULL, NULL,
    format('SELECT case_view_delete(%L, %L)::text', u_agent, s1), 'ERROR 42501 NOT_ALLOWED%');
  n := n + 1; failed := failed || pg_temp.cv_check('an agent shared their own view on update', NULL, NULL,
    format('SELECT (case_view_save(%L, %L, ''x'', ''{}'', NULL, true)).view_id::text', u_agent, v1),
    'ERROR 42501 NOT_ALLOWED%');
  n := n + 1; failed := failed || pg_temp.cv_check('the owner could not update their view', NULL, NULL,
    format('SELECT (case_view_save(%L, %L, ''Renamed'', ''{"mentioned_me": true}'', NULL, false)).name', u_agent, v1),
    'Renamed');
  n := n + 1; failed := failed || pg_temp.cv_ok(
    (SELECT x.filters = '{"mentioned_me": true}'::jsonb AND x.sort IS NULL AND x.view_id = v1
       FROM case_saved_views x WHERE x.view_id = v1),
    'an update did not replace the filters and sort in place');
  n := n + 1; failed := failed || pg_temp.cv_check('the admin could not update their shared view', NULL, NULL,
    format('SELECT (case_view_save(%L, %L, ''Overdue'', ''{}'', ''due_soonest'', true)).name', u_admin, s1), 'Overdue');
  n := n + 1; failed := failed || pg_temp.cv_check('an unknown view id', NULL, NULL,
    format('SELECT (case_view_save(%L, %L, ''x'', ''{}'', NULL, false)).view_id::text', u_agent, gen_random_uuid()),
    'ERROR P0002 VIEW_NOT_FOUND%');
  -- RLS: own views and the active account's shared views
  n := n + 1; failed := failed || pg_temp.cv_check('RLS: the agent does not read own + shared', 'authenticated', u_agent,
    format('SELECT string_agg(view_id::text, '','' ORDER BY shared DESC) FROM case_saved_views WHERE account_id = %L',
      a_acct), s1::text || ',' || v1::text);
  n := n + 1; failed := failed || pg_temp.cv_check('RLS: agent2 does not read only the shared view', 'authenticated',
    u_agent2, 'SELECT string_agg(view_id::text, '','') FROM case_saved_views WHERE NOT (owner_user_id = auth.uid())',
    s1::text);
  n := n + 1; failed := failed || pg_temp.cv_check('RLS: another workspace reads this one''s views', 'authenticated',
    u_bown, 'SELECT count(*)::text FROM case_saved_views', '0');
  FOREACH r IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    n := n + 1; failed := failed || pg_temp.cv_check(format('%s inserted a view directly', r), r, u_agent,
      format('INSERT INTO case_saved_views (account_id, owner_user_id, name) VALUES (%L, %L, ''x'')', a_acct, u_agent),
      'ERROR 42501 %');
    n := n + 1; failed := failed || pg_temp.cv_check(format('%s updated a view directly', r), r, u_agent,
      format('UPDATE case_saved_views SET name = ''y'' WHERE view_id = %L', v1), 'ERROR 42501 %');
    n := n + 1; failed := failed || pg_temp.cv_check(format('%s deleted a view directly', r), r, u_agent,
      format('DELETE FROM case_saved_views WHERE view_id = %L', v1), 'ERROR 42501 %');
  END LOOP;
  -- an owner/admin deletes any view, private included; the owner their own
  n := n + 1; failed := failed || pg_temp.cv_check('the admin could not delete a private view', NULL, NULL,
    format('SELECT case_view_delete(%L, %L)::text', u_admin, v1), '');
  n := n + 1; failed := failed || pg_temp.cv_ok(NOT EXISTS (SELECT 1 FROM case_saved_views WHERE view_id = v1),
    'the admin''s delete left the private view');
  v1 := (case_view_save(u_agent, NULL, 'Again', '{}', NULL, false)).view_id;
  n := n + 1; failed := failed || pg_temp.cv_check('the owner could not delete their view', NULL, NULL,
    format('SELECT case_view_delete(%L, %L)::text', u_agent, v1), '');
  n := n + 1; failed := failed || pg_temp.cv_check('the workspace owner could not delete the admin''s shared view',
    NULL, NULL, format('SELECT case_view_delete(%L, %L)::text', u_owner, s1), '');
  n := n + 1; failed := failed || pg_temp.cv_ok(
    NOT EXISTS (SELECT 1 FROM case_saved_views WHERE view_id IN (v1, s1)), 'a deleted view is still there');
  n := n + 1; failed := failed || pg_temp.cv_check('a deleted view deleted again', NULL, NULL,
    format('SELECT case_view_delete(%L, %L)::text', u_owner, s1), 'ERROR P0002 VIEW_NOT_FOUND%');

  -- ---------- snooze: who ----------
  r := pg_temp.cv_sla(k1);
  ts1 := (SELECT x.last_activity_at FROM case_inbox(u_owner, a_acct, '{}', t0 + interval '10 minutes', 200) x
           WHERE x.case_id = k1);
  w1 := (SELECT count(*) FROM case_snooze_log);
  FOREACH st IN ARRAY ARRAY[u_agent::text, u_viewer::text, u_agent2::text, u_hold::text, u_bown::text,
                           gen_random_uuid()::text] LOOP
    n := n + 1; failed := failed || pg_temp.cv_check(format('%s snoozed k1', st), NULL, NULL,
      format('SELECT case_snooze(%L, %L, %L, NULL, %L)::text', st, k1, t0 + interval '2 hours', t0),
      'ERROR 42501 NOT_ALLOWED%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cv_check('snooze with no actor', NULL, NULL,
    format('SELECT case_snooze(NULL, %L, %L, NULL, %L)::text', k1, t0 + interval '2 hours', t0), 'ERROR 42501 NOT_ALLOWED%');
  n := n + 1; failed := failed || pg_temp.cv_check('a team lead snoozed another team''s case', NULL, NULL,
    format('SELECT case_snooze(%L, %L, %L, NULL, %L)::text', u_lead, k4, t0 + interval '2 hours', t0),
    'ERROR 42501 NOT_ALLOWED%');
  n := n + 1; failed := failed || pg_temp.cv_check('an unknown case', NULL, NULL,
    format('SELECT case_snooze(%L, %L, %L, NULL, %L)::text', u_owner, gen_random_uuid(), t0 + interval '2 hours', t0),
    'ERROR P0002 CASE_NOT_FOUND%');
  n := n + 1; failed := failed || pg_temp.cv_check('a closed case', NULL, NULL,
    format('SELECT case_snooze(%L, %L, %L, NULL, %L)::text', u_owner, k5, t0 + interval '2 hours', t0),
    'ERROR 23514 CASE_CLOSED%');
  n := n + 1; failed := failed || pg_temp.cv_ok((SELECT count(*) FROM case_snooze_log) = w1
    AND NOT EXISTS (SELECT 1 FROM cases WHERE snoozed_until IS NOT NULL), 'a refused snooze wrote something');
  -- bounds (as the named coordinator)
  FOREACH st IN ARRAY ARRAY['NULL', format('%L', t0), format('%L', t0 - interval '1 second'),
                           format('%L', t0 + interval '30 days 1 second'), '''infinity'''] LOOP
    n := n + 1; failed := failed || pg_temp.cv_check(format('snooze until %s accepted', st), NULL, NULL,
      format('SELECT case_snooze(%L, %L, %s, NULL, %L)::text', u_coord, k1, st, t0), 'ERROR 22023 SNOOZE_INVALID%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cv_check('a 201-character reason accepted', NULL, NULL,
    format('SELECT case_snooze(%L, %L, %L, %L, %L)::text', u_coord, k1, t0 + interval '1 hour', repeat('r', 201), t0),
    'ERROR 22023 SNOOZE_INVALID%');
  -- allowed: each role, the last one standing
  n := n + 1; failed := failed || pg_temp.cv_check('the team lead could not snooze for 30 days', NULL, NULL,
    format('SELECT case_snooze(%L, %L, %L, NULL, %L)::text', u_lead, k1, t0 + interval '30 days', t0),
    (t0 + interval '30 days')::text);
  n := n + 1; failed := failed || pg_temp.cv_check('the admin could not snooze', NULL, NULL,
    format('SELECT case_snooze(%L, %L, %L, ''  '', %L)::text', u_admin, k1, t0 + interval '3 hours', t0),
    (t0 + interval '3 hours')::text);
  n := n + 1; failed := failed || pg_temp.cv_check('the owner could not snooze', NULL, NULL,
    format('SELECT case_snooze(%L, %L, %L, NULL, %L)::text', u_owner, k3, t0 + interval '1 hour', t0),
    (t0 + interval '1 hour')::text);
  n := n + 1; failed := failed || pg_temp.cv_check('the bank holder could not snooze', NULL, NULL,
    format('SELECT case_snooze(%L, %L, %L, ''waiting on the bank'', %L)::text', u_hold, k2, t0 + interval '1 hour', t0),
    (t0 + interval '1 hour')::text);
  n := n + 1; failed := failed || pg_temp.cv_check('the named coordinator could not snooze', NULL, NULL,
    format('SELECT case_snooze(%L, %L, %L, %L, %L)::text', u_coord, k1, t0 + interval '2 hours', repeat('r', 200), t0),
    (t0 + interval '2 hours')::text);
  n := n + 1; failed := failed || pg_temp.cv_ok(
    (SELECT string_agg(actor_role || ':' || coalesce(snoozed_until - t0, '-1 second'::interval)::text || ':'
                       || coalesce(char_length(reason), -1)::text || ':' || (at = t0)::text, ',' ORDER BY id)
       FROM case_snooze_log WHERE id > 0 AND case_id IN (k1, k2, k3))
    = 'team_lead:30 days:-1:true,admin:03:00:00:-1:true,super_admin:01:00:00:-1:true,coordinator:01:00:00:19:true,'
      || 'coordinator:02:00:00:200:true',
    format('the snooze log is not one row per snooze with role, until, reason and clock (%s)',
      (SELECT string_agg(actor_role || ':' || coalesce(snoozed_until - t0, '-1 second'::interval)::text || ':'
                         || coalesce(char_length(reason), -1)::text, ',' ORDER BY id) FROM case_snooze_log)));
  n := n + 1; failed := failed || pg_temp.cv_ok(pg_temp.cv_sla(k1) = r,
    format('a snooze touched the SLA (%s -> %s)', r, pg_temp.cv_sla(k1)));
  n := n + 1; failed := failed || pg_temp.cv_ok(
    (SELECT x.last_activity_at FROM case_inbox(u_owner, a_acct, '{"snoozed": "all"}', t0 + interval '10 minutes', 200) x
      WHERE x.case_id = k1) = ts1,
    'a snooze became the last touch');

  -- ---------- snooze: the inbox ----------
  n := n + 1; failed := failed || pg_temp.cv_ok(pg_temp.cv_ids(u_owner, a_acct, '{}', t0) = ARRAY[k4],
    format('snoozed cases are not hidden by default (%s)', pg_temp.cv_ids(u_owner, a_acct, '{}', t0)));
  n := n + 1; failed := failed || pg_temp.cv_ok(pg_temp.cv_ids(u_coord, a_acct, '{}', t0) = '{}'
    AND pg_temp.cv_ids(u_coord, a_acct, '{"snoozed": "only"}', t0) = ARRAY[k1],
    'the coordinator''s snoozed case is not hidden by default and listed by snoozed only');
  n := n + 1; failed := failed || pg_temp.cv_ok(
    (SELECT array_agg(x ORDER BY x) FROM unnest(pg_temp.cv_ids(u_owner, a_acct, '{"snoozed": "only"}', t0)) x)
      = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[k1, k2, k3]) x)
    AND cardinality(pg_temp.cv_ids(u_owner, a_acct, '{"snoozed": "all"}', t0)) = 4,
    'snoozed only / all do not list the snoozed cases / every case');
  n := n + 1; failed := failed || pg_temp.cv_ok(
    (SELECT x.snoozed_until = t0 + interval '2 hours' AND NOT x.snooze_expired
       FROM case_inbox(u_owner, a_acct, '{"snoozed": "all"}', t0, 200) x WHERE x.case_id = k1),
    'the snoozed_until column does not hold the snooze');
  n := n + 1; failed := failed || pg_temp.cv_ok(
    pg_temp.cv_ids(u_owner, a_acct, '{"include_closed": true}', t0) = ARRAY[k4, k5]
    OR pg_temp.cv_ids(u_owner, a_acct, '{"include_closed": true}', t0) = ARRAY[k5, k4],
    'include_closed lists a snoozed case by default');
  -- k3 (until t0+1h) and k2 (until t0+1h): ended at t0+1h
  ts1 := t0 + interval '1 hour';
  n := n + 1; failed := failed || pg_temp.cv_ok(
    (SELECT array_agg(x ORDER BY x) FROM unnest(pg_temp.cv_ids(u_owner, a_acct, '{"snooze_expired": true}', ts1)) x)
      = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[k2, k3]) x),
    'a snooze ending exactly now is not listed (and marked) as expired');
  n := n + 1; failed := failed || pg_temp.cv_ok(
    (SELECT bool_and(x.snooze_expired = (x.case_id IN (k2, k3))) FROM case_inbox(u_owner, a_acct, '{}', ts1, 200) x)
    AND (SELECT count(*) FROM case_inbox(u_owner, a_acct, '{}', ts1, 200)) = 3,
    'at the end of a snooze the case is not back in the default inbox with the expired mark');
  n := n + 1; failed := failed || pg_temp.cv_ok(
    pg_temp.cv_ids(u_owner, a_acct, '{"snooze_expired": true}', ts1 + interval '23 hours 59 minutes') @> ARRAY[k2, k3]
    AND NOT (pg_temp.cv_ids(u_owner, a_acct, '{"snooze_expired": true}', ts1 + interval '24 hours') && ARRAY[k2, k3])
    AND NOT EXISTS (SELECT 1 FROM case_inbox(u_owner, a_acct, '{}', ts1 + interval '24 hours', 200) x
                     WHERE x.snooze_expired AND x.case_id IN (k2, k3)),
    'the expired mark does not last exactly 24 hours');
  n := n + 1; failed := failed || pg_temp.cv_ok(
    NOT (pg_temp.cv_ids(u_owner, a_acct, '{"snooze_expired": false}', ts1) && ARRAY[k2, k3])
    AND pg_temp.cv_ids(u_owner, a_acct, '{"snooze_expired": true}', t0) = '{}',
    'snooze_expired false / a running snooze is not expired');

  -- ---------- unsnooze ----------
  n := n + 1; failed := failed || pg_temp.cv_check('an agent unsnoozed', NULL, NULL,
    format('SELECT case_unsnooze(%L, %L, %L)::text', u_agent, k1, t0), 'ERROR 42501 NOT_ALLOWED%');
  n := n + 1; failed := failed || pg_temp.cv_check('unsnooze of a case never snoozed', NULL, NULL,
    format('SELECT case_unsnooze(%L, %L, %L)::text', u_owner, k4, t0), 'ERROR 22023 SNOOZE_INVALID%');
  n := n + 1; failed := failed || pg_temp.cv_check('unsnooze of a snooze already over', NULL, NULL,
    format('SELECT case_unsnooze(%L, %L, %L)::text', u_hold, k2, ts1), 'ERROR 22023 SNOOZE_INVALID%');
  n := n + 1; failed := failed || pg_temp.cv_check('unsnooze of a closed case', NULL, NULL,
    format('SELECT case_unsnooze(%L, %L, %L)::text', u_owner, k5, t0), 'ERROR 23514 CASE_CLOSED%');
  w1 := (SELECT count(*) FROM case_snooze_log);
  n := n + 1; failed := failed || pg_temp.cv_check('the coordinator could not unsnooze', NULL, NULL,
    format('SELECT case_unsnooze(%L, %L, %L)::text', u_coord, k1, t0 + interval '5 minutes'), '');
  n := n + 1; failed := failed || pg_temp.cv_ok(
    (SELECT snoozed_until IS NULL FROM cases WHERE id = k1)
    AND (SELECT count(*) FROM case_snooze_log) = w1 + 1
    AND EXISTS (SELECT 1 FROM case_snooze_log WHERE case_id = k1 AND snoozed_until IS NULL AND reason IS NULL
                   AND actor_id = u_coord AND actor_role = 'coordinator' AND at = t0 + interval '5 minutes')
    AND k1 = ANY (pg_temp.cv_ids(u_owner, a_acct, '{}', t0 + interval '5 minutes')),
    'an unsnooze did not clear the case, log one row and bring it back');
  n := n + 1; failed := failed || pg_temp.cv_ok(pg_temp.cv_sla(k1) = r, 'an unsnooze touched the SLA');
  n := n + 1; failed := failed || pg_temp.cv_check('unsnooze twice', NULL, NULL,
    format('SELECT case_unsnooze(%L, %L, %L)::text', u_coord, k1, t0 + interval '5 minutes'),
    'ERROR 22023 SNOOZE_INVALID%');

  -- ---------- the snooze log is append-only ----------
  FOREACH st IN ARRAY ARRAY['UPDATE case_snooze_log SET reason = ''x''', 'DELETE FROM case_snooze_log',
                           'TRUNCATE case_snooze_log'] LOOP
    n := n + 1; failed := failed || pg_temp.cv_check(format('the table owner ran %s', st), NULL, NULL, st,
      'ERROR 42501 %append-only%');
  END LOOP;
  FOREACH st IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    n := n + 1; failed := failed || pg_temp.cv_check(format('%s wrote the snooze log', st), st, u_owner,
      format('INSERT INTO case_snooze_log (case_id, account_id, actor_id, actor_role, at) VALUES (%L, %L, %L, ''admin'', now())',
        k4, a_acct, u_owner), 'ERROR 42501 %');
    n := n + 1; failed := failed || pg_temp.cv_check(format('%s set snoozed_until directly', st), st, u_owner,
      format('UPDATE cases SET snoozed_until = now() + interval ''1 hour'' WHERE id = %L', k4), 'ERROR 42501 %');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cv_check('RLS: the agent does not read the snooze log of their cases',
    'authenticated', u_agent, 'SELECT count(*)::text FROM case_snooze_log', (SELECT count(*) FROM case_snooze_log
      WHERE case_id IN (k1, k2, k3))::text);
  n := n + 1; failed := failed || pg_temp.cv_check('RLS: agent2 reads the snooze log of others'' cases',
    'authenticated', u_agent2, 'SELECT count(*)::text FROM case_snooze_log', '0');

  -- ---------- mentions ----------
  nt1 := (SELECT x.note_id FROM public.case_note_add(k1, u_coord, 'ping @' || u_agent::text || ' about the salary', t0 + interval '1 minute') x);
  nt2 := (SELECT x.note_id FROM public.case_note_add(k3, u_admin, '@' || u_agent::text || '. please call', t0 + interval '2 minutes') x);
  nt3 := (SELECT x.note_id FROM public.case_note_add(k2, u_hold, 'cc @' || u_agent::text || ' and @' || u_hold::text, t0 + interval '2 minutes') x);
  nt4 := (SELECT x.note_id FROM public.case_note_add(k1, u_owner, 'later @' || u_agent::text, t0 + interval '1 hour') x);
  PERFORM case_note_add(k4, u_agent2, 'not for @' || u_agent::text, t0 + interval '1 minute');
  PERFORM case_note_add(kb, u_bown, 'other workspace @' || u_agent::text, t0 + interval '1 minute');
  ids := ARRAY[nt3, nt2];
  IF nt2 < nt3 THEN ids := ARRAY[nt2, nt3]; END IF;
  ids := ARRAY[ids[2], ids[1]];  -- same clock: note id descending
  n := n + 1; failed := failed || pg_temp.cv_ok(
    (SELECT array_agg(x.note_id ORDER BY x.ordinality) FROM case_mentions(u_agent, t0 + interval '10 minutes')
       WITH ORDINALITY x)
      = ids || nt1,
    'mentions are not newest first (note id breaking the tie), without later or unreadable notes');
  n := n + 1; failed := failed || pg_temp.cv_ok(
    (SELECT x.case_id = k1 AND x.stage = 'Submitted' AND x.author_id = u_coord AND x.system_author IS NULL
            AND x.created_at = t0 + interval '1 minute' AND x.body LIKE 'ping @%'
       FROM case_mentions(u_agent, t0 + interval '10 minutes') x WHERE x.note_id = nt1),
    'a mention row does not carry its case, stage, author, clock and body');
  n := n + 1; failed := failed || pg_temp.cv_ok(
    (SELECT count(*) FROM case_mentions(u_agent, t0 + interval '2 hours')) = 4
    AND (SELECT x.note_id FROM case_mentions(u_agent, t0 + interval '2 hours') x LIMIT 1) = nt4,
    'a note created before the clock is missing');
  -- keyset paging, one a page
  acc := '{}';
  cur := NULL;
  FOR j IN 1 .. 10 LOOP
    SELECT x.note_id, x.cursor INTO st, r FROM case_mentions(u_agent, t0 + interval '2 hours', 1, cur) x;
    EXIT WHEN st IS NULL;
    acc := acc || st::uuid;
    cur := r;
    st := NULL;
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cv_ok(acc = ARRAY[nt4] || ids || nt1,
    format('keyset paging of mentions does not return each once in order (%s)', acc));
  n := n + 1; failed := failed || pg_temp.cv_check('a mentions cursor from another clock', NULL, NULL,
    format('SELECT count(*)::text FROM case_mentions(%L, %L, 1, %L)', u_agent, t0 + interval '3 hours', cur),
    'ERROR 22023 CURSOR_INVALID%');
  FOREACH st IN ARRAY ARRAY['not json', '{}', '[1]', '{"now": "x", "note_id": "y", "created_at": "z"}'] LOOP
    n := n + 1; failed := failed || pg_temp.cv_check(format('the mentions cursor %s', st), NULL, NULL,
      format('SELECT count(*)::text FROM case_mentions(%L, %L, 1, %L)', u_agent, t0, st), 'ERROR 22023 CURSOR_INVALID%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cv_check('mentions limit 0', NULL, NULL,
    format('SELECT count(*)::text FROM case_mentions(%L, %L, 0)', u_agent, t0), 'ERROR 22023 LIMIT_INVALID%');
  n := n + 1; failed := failed || pg_temp.cv_check('mentions limit 500 is not capped quietly', NULL, NULL,
    format('SELECT count(*)::text FROM case_mentions(%L, %L, 500)', u_agent, t0 + interval '2 hours'), '4');
  n := n + 1; failed := failed || pg_temp.cv_check('mentions with no clock', NULL, NULL,
    format('SELECT count(*)::text FROM case_mentions(%L, NULL)', u_agent), 'ERROR 22023 NOW_REQUIRED%');
  n := n + 1; failed := failed || pg_temp.cv_check('mentions with an infinite clock', NULL, NULL,
    format('SELECT count(*)::text FROM case_mentions(%L, ''infinity'')', u_agent), 'ERROR 22023 NOW_REQUIRED%');
  n := n + 1; failed := failed || pg_temp.cv_check('mentions with no actor', NULL, NULL,
    format('SELECT count(*)::text FROM case_mentions(NULL, %L)', t0), 'ERROR 42501 NOT_ALLOWED%');
  -- readable only: the bank holder is mentioned on k2, then loses the bank
  n := n + 1; failed := failed || pg_temp.cv_ok(
    (SELECT array_agg(x.note_id) FROM case_mentions(u_hold, t0 + interval '10 minutes') x) = ARRAY[nt3],
    'the bank holder does not see their mention');
  DELETE FROM coordinator_banks WHERE account_id = a_acct AND user_id = u_hold AND bank_code = 'ENBD';
  n := n + 1; failed := failed || pg_temp.cv_ok(
    NOT EXISTS (SELECT 1 FROM case_mentions(u_hold, t0 + interval '10 minutes'))
    AND NOT EXISTS (SELECT 1 FROM case_mentions(u_bown, t0 + interval '10 minutes')),
    'a mention on a case the actor can no longer read (or of another workspace) is listed');
  INSERT INTO coordinator_banks (account_id, user_id, bank_code, created_by) VALUES (a_acct, u_hold, 'ENBD', u_owner);
  -- a system note's mention is listed with its system author
  st := case_note_add_system(k1, 'system:rules', 'rule fired @' || u_coord::text, t0 + interval '4 minutes')::text;
  n := n + 1; failed := failed || pg_temp.cv_ok(
    (SELECT x.author_id IS NULL AND x.system_author = 'system:rules'
       FROM case_mentions(u_coord, t0 + interval '10 minutes') x WHERE x.note_id = st::uuid),
    'a system note''s mention is not listed with its system author');
  -- mentioned_me (k2 and k3 are still snoozed at t0 + 10 minutes)
  n := n + 1; failed := failed || pg_temp.cv_ok(
    (SELECT array_agg(x ORDER BY x) FROM unnest(pg_temp.cv_ids(u_agent, a_acct, '{"mentioned_me": true, "snoozed": "all"}',
       t0 + interval '10 minutes')) x) = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[k1, k2, k3]) x)
    AND pg_temp.cv_ids(u_agent, a_acct, '{"mentioned_me": true}', t0 + interval '10 minutes') = ARRAY[k1]
    AND pg_temp.cv_ids(u_agent, a_acct, '{"mentioned_me": true, "snoozed": "all"}', t0) = '{}'
    AND pg_temp.cv_ids(u_agent, a_acct, '{"mentioned_me": false, "snoozed": "all"}', t0 + interval '10 minutes') = '{}'
    AND pg_temp.cv_ids(u_owner, a_acct, '{"mentioned_me": true, "snoozed": "all"}', t0 + interval '10 minutes') = '{}'
    AND pg_temp.cv_ids(u_owner, a_acct, '{"mentioned_me": false, "snoozed": "all"}', t0 + interval '10 minutes')
        @> ARRAY[k1, k2, k3, k4],
    'the mentioned_me filter does not select the cases with a note mentioning the actor by the clock');

  -- ---------- a system note is not a touch ----------
  SELECT x.last_activity_at, x.last_touched_by::text INTO ts1, st
    FROM case_inbox(u_owner, a_acct, '{}', t0 + interval '2 hours', 200) x WHERE x.case_id = k3;
  n := n + 1; failed := failed || pg_temp.cv_ok(ts1 = t0 + interval '3 minutes' AND st = u_agent::text,
    format('k3''s last touch is not the agent''s note (%s, %s)', ts1 - t0, st));
  PERFORM case_note_add_system(k3, 'system:files', 'the trade licence failed its checks', t0 + interval '30 minutes');
  SELECT x.last_activity_at, x.last_touched_by::text INTO ts1, st
    FROM case_inbox(u_owner, a_acct, '{}', t0 + interval '2 hours', 200) x WHERE x.case_id = k3;
  n := n + 1; failed := failed || pg_temp.cv_ok(ts1 = t0 + interval '3 minutes' AND st = u_agent::text,
    format('a system note became k3''s last touch (%s, %s)', ts1 - t0, st));
  n := n + 1; failed := failed || pg_temp.cv_ok(
    k3 = ANY (pg_temp.cv_ids(u_owner, a_acct, '{"no_activity_days": 1}', t0 + interval '1 day 10 minutes')),
    'a system note kept k3 out of no_activity_days');

  -- ---------- grants: service_role only ----------
  FOREACH st IN ARRAY ARRAY['case_inbox(uuid,uuid,jsonb,timestamptz,integer,text)', 'case_inbox_validate_filters(jsonb)',
                           'case_view_list(uuid)', 'case_view_save(uuid,uuid,text,jsonb,text,boolean)',
                           'case_view_delete(uuid,uuid)', 'case_snooze(uuid,uuid,timestamptz,text,timestamptz)',
                           'case_unsnooze(uuid,uuid,timestamptz)', 'case_mentions(uuid,timestamptz,integer,text)'] LOOP
    n := n + 1; failed := failed || pg_temp.cv_ok(
      has_function_privilege('service_role', ('public.' || st)::regprocedure, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', ('public.' || st)::regprocedure, 'EXECUTE')
      AND NOT has_function_privilege('anon', ('public.' || st)::regprocedure, 'EXECUTE'),
      format('%s is not executable by service_role alone', st));
  END LOOP;
  FOREACH st IN ARRAY ARRAY['case_view_account(uuid)', 'case_snooze_lock(uuid,uuid)'] LOOP
    n := n + 1; failed := failed || pg_temp.cv_ok(
      NOT has_function_privilege('service_role', ('public.' || st)::regprocedure, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', ('public.' || st)::regprocedure, 'EXECUTE')
      AND NOT has_function_privilege('anon', ('public.' || st)::regprocedure, 'EXECUTE'),
      format('the internal %s is executable by an API role', st));
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cv_check('authenticated called case_snooze', 'authenticated', u_owner,
    format('SELECT case_snooze(%L, %L, %L, NULL, %L)::text', u_owner, k4, t0 + interval '1 hour', t0), 'ERROR 42501 %');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT185', MESSAGE = 'verify-case-views rollback';
  EXCEPTION WHEN SQLSTATE 'ZT185' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'case views verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'case views verification passed (% checks)', n;
END
$verify$;
