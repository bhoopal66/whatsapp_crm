-- Behavioural regression suite for bank workspaces (migration 126,
-- threads, posts, versioned pins and 'Action needed' over 122-123's
-- cases and case tasks).
--
-- Access equals "live owner / admin of the account, else a reader of an
-- OPEN case of that bank" for every person of the fixture and every bank
-- workspace, before and after a member's last open case of the bank
-- closes (the lapse is immediate; their posts stay). Non-members get
-- NOT_ALLOWED on every write and nothing from every read. Pins are
-- versioned and edited only by admins, team leads and coordinators of an
-- open case of the bank. Links are the same account, same bank and
-- readable (LINK_INVALID otherwise) and listings hide an unreadable
-- case's stage / product. 'Action needed' is once per thread and, on a
-- case-linked thread, a real case task from the seeded template. Every
-- 126 table refuses UPDATE / DELETE / TRUNCATE; the grants are exactly
-- authenticated SELECT (not bank_ws_posts) under RLS, the API to
-- service_role, bank_ws_rls_access to authenticated, nothing else.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000126001';
  u_admin  UUID := '00000000-0000-4000-8000-000000126002';
  u_lead   UUID := '00000000-0000-4000-8000-000000126003';  -- leads T1 (u_agent, u_coord)
  u_lead2  UUID := '00000000-0000-4000-8000-000000126004';  -- leads T2 (u_agent2)
  u_coord  UUID := '00000000-0000-4000-8000-000000126005';  -- agent role; coordinator of k1
  u_agent  UUID := '00000000-0000-4000-8000-000000126006';  -- agent of k1
  u_agent2 UUID := '00000000-0000-4000-8000-000000126007';  -- agent of k2 (ENBD), k3 (ADCB)
  u_agent3 UUID := '00000000-0000-4000-8000-000000126008';  -- agent of k5 (ENBD, closed) only
  u_viewer UUID := '00000000-0000-4000-8000-000000126009';
  u_guest  UUID := '00000000-0000-4000-8000-000000126010';
  u_gone   UUID := '00000000-0000-4000-8000-000000126011';  -- agent of k4 (ADCB), then deactivated
  u_bown   UUID := '00000000-0000-4000-8000-000000126012';  -- owner of account B
  u_agent4 UUID := '00000000-0000-4000-8000-000000126013';  -- on no case
  a_acct   UUID;
  b_acct   UUID;
  wa       UUID;
  wb       UUID;
  ca       UUID;
  cb       UUID;
  team1    UUID;
  team2    UUID;
  g        UUID[] := '{}';
  gb       UUID;
  k1       UUID;  -- ADCB 'Loan': agent u_agent, coordinator u_coord
  k2       UUID;  -- ENBD: agent u_agent2
  k3       UUID;  -- ADCB 'Loan': agent u_agent2 (closed mid-suite)
  k4       UUID;  -- ADCB: agent u_gone
  k5       UUID;  -- ENBD: agent u_agent3, closed
  kb       UUID;  -- account B, ADCB
  ws_a     UUID;  -- A / ADCB
  ws_e     UUID;  -- A / ENBD
  ws_b     UUID;  -- B / ADCB
  wsx      UUID;
  th1      UUID;  -- ws_a, root linked to k1, by u_agent
  th2      UUID;  -- ws_a, unlinked, by u_agent
  th3      UUID;  -- ws_a, root linked to k3, by u_lead2
  th4      UUID;  -- ws_e, by u_admin (not a member)
  th5      UUID;  -- ws_b
  th_m     UUID;  -- ws_a, unmarked, for the non-member marks
  root1    UUID;
  root2    UUID;
  rp1      UUID;
  rp2      UUID;
  rp3      UUID;
  tk_e     UUID;
  tk1      UUID;
  act1     UUID;
  act2     UUID;
  t0       TIMESTAMPTZ := now();
  usr      UUID[];
  lbl      TEXT[];
  nonmem   UUID[];
  ph       INT;
  i        INT;
  st       TEXT;
  r        TEXT;
  b1       BOOLEAN;
  ids      UUID[];
  ids2     UUID[];
  r2       TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (NULL: as the current user) signed in as
  -- p_uid: a SELECT's value, 'ok', or 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_try(p_role text, p_uid uuid, p_sql text)
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
    CREATE FUNCTION pg_temp.cs_check(p_name text, p_role text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.cs_try(p_role, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- p_sql, called as service_role, must fail with hint p_hint.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.bw_err(p_name text, p_sql text, p_hint text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.cs_check(p_name || ' was not ' || p_hint, 'service_role', NULL, p_sql,
                              'ERROR _____ ' || p_hint || ':%')
    $body$
  $fn$;
  -- The rule, computed independently of 126: a live owner / admin of the
  -- workspace's account is 'admin'; anyone else who reads an OPEN case of
  -- that account and bank is 'member'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.bw_expect(p_ws uuid, p_user uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT CASE
               WHEN EXISTS (SELECT 1 FROM public.profiles p
                             WHERE p.user_id = p_user AND p.account_id = w.account_id
                               AND p.deactivated_at IS NULL AND p.account_role IN ('owner', 'admin')) THEN 'admin'
               WHEN EXISTS (SELECT 1 FROM public.cases c
                             WHERE c.account_id = w.account_id AND c.bank_code = w.bank_code
                               AND c.closed_at IS NULL AND public.case_can_read(c.id, p_user)) THEN 'member'
             END
        FROM public.bank_workspaces w WHERE w.id = p_ws
    $body$
  $fn$;
  -- bank_ws_access of each person, in order, '-' for none.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.bw_matrix(p_ws uuid, p_users uuid[])
    RETURNS text LANGUAGE sql AS $body$
      SELECT string_agg(coalesce(public.bank_ws_access(p_ws, u.id), '-'), ',' ORDER BY u.o)
        FROM unnest(p_users) WITH ORDINALITY AS u(id, o)
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'bw-owner@example.invalid'),
    (u_admin,  'bw-admin@example.invalid'),
    (u_lead,   'bw-lead@example.invalid'),
    (u_lead2,  'bw-lead2@example.invalid'),
    (u_coord,  'bw-coord@example.invalid'),
    (u_agent,  'bw-agent@example.invalid'),
    (u_agent2, 'bw-agent2@example.invalid'),
    (u_agent3, 'bw-agent3@example.invalid'),
    (u_viewer, 'bw-viewer@example.invalid'),
    (u_guest,  'bw-guest@example.invalid'),
    (u_gone,   'bw-gone@example.invalid'),
    (u_bown,   'bw-bown@example.invalid'),
    (u_agent4, 'bw-agent4@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_bown;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id IN (u_lead, u_lead2);
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'
   WHERE user_id IN (u_coord, u_agent, u_agent2, u_agent3, u_gone, u_agent4);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;

  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'BW T1', u_lead) RETURNING id INTO team1;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (team1, u_agent, a_acct), (team1, u_coord, a_acct);
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'BW T2', u_lead2) RETURNING id INTO team2;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (team2, u_agent2, a_acct);

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CT-126-A1', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_bown, b_acct, 'whapi', 'CT-126-B1', 'x', 'connected', true) RETURNING id INTO wb;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500126001', 'BW one')
    RETURNING id INTO ca;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b_acct, u_bown, '971500126002', 'BW bee')
    RETURNING id INTO cb;

  FOR i IN 1 .. 5 LOOP
    g[i] := (SELECT x.group_id FROM sg_open(a_acct, 'CT-126-' || i, ca, wa, 'bank ws ' || i, NULL, CASE i
        WHEN 1 THEN jsonb_build_array(jsonb_build_object('user_id', u_coord, 'label', 'coordinator'),
                                      jsonb_build_object('user_id', u_agent, 'label', 'agent'))
        WHEN 2 THEN jsonb_build_array(jsonb_build_object('user_id', u_agent2, 'label', 'agent'))
        WHEN 3 THEN jsonb_build_array(jsonb_build_object('user_id', u_agent2, 'label', 'agent'))
        WHEN 4 THEN jsonb_build_array(jsonb_build_object('user_id', u_gone, 'label', 'agent'))
        ELSE jsonb_build_array(jsonb_build_object('user_id', u_agent3, 'label', 'agent')) END, NULL) x);
    IF g[i] IS NULL THEN RAISE EXCEPTION 'fixture: sg_open returned no group %', i; END IF;
  END LOOP;
  gb := (SELECT x.group_id FROM sg_open(b_acct, 'CT-126-B', cb, wb, 'bank ws b', NULL,
    jsonb_build_array(jsonb_build_object('user_id', u_bown, 'label', 'agent')), NULL) x);

  PERFORM case_bank_upsert(u_owner, a_acct, 'ADCB', 'ADCB Bank');
  PERFORM case_bank_upsert(u_owner, a_acct, 'ENBD', 'Emirates NBD');
  PERFORM case_bank_upsert(u_bown, b_acct, 'ADCB', 'ADCB in B');
  k1 := (SELECT x.case_id FROM case_open(g[1], 'ADCB', NULL, 'Loan', 1000, NULL) x);
  k2 := (SELECT x.case_id FROM case_open(g[2], 'ENBD', NULL, 'Card', 2000, NULL) x);
  k3 := (SELECT x.case_id FROM case_open(g[3], 'ADCB', NULL, 'Mortgage', 3000, NULL) x);
  k4 := (SELECT x.case_id FROM case_open(g[4], 'ADCB', NULL, NULL, NULL, NULL) x);
  k5 := (SELECT x.case_id FROM case_open(g[5], 'ENBD', NULL, NULL, NULL, NULL) x);
  kb := (SELECT x.case_id FROM case_open(gb, 'ADCB', NULL, NULL, NULL, NULL) x);
  IF k1 IS NULL OR k2 IS NULL OR k3 IS NULL OR k4 IS NULL OR k5 IS NULL OR kb IS NULL THEN
    RAISE EXCEPTION 'fixture: case_open returned no case';
  END IF;
  PERFORM case_set_stage(k5, u_owner, 'Closed', NULL, false);
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;
  -- An existing ENBD 'bank_ws_action_needed' template is kept as configured.
  PERFORM case_task_template_upsert(u_owner, a_acct, 'ENBD', 'bank_ws_action_needed', 'Custom action', 1, 24);

  usr := ARRAY[u_owner, u_admin, u_lead, u_lead2, u_coord, u_agent, u_agent2, u_agent3, u_viewer, u_guest, u_gone,
               u_bown, u_agent4];
  lbl := ARRAY['owner', 'admin', 'team lead', 'other team''s lead', 'coordinator', 'agent', 'agent2',
               'agent of a closed case only', 'viewer', 'bank guest', 'deactivated agent', 'B owner', 'agent on no case'];
  nonmem := ARRAY[u_agent3, u_viewer, u_guest, u_gone, u_bown, u_agent4];

  -- ---------- create ----------
  FOREACH r IN ARRAY ARRAY[format('%L, %L, ''ADCB''', u_lead, a_acct), format('%L, %L, ''ADCB''', u_agent, a_acct),
    format('%L, %L, ''ADCB''', u_coord, a_acct), format('%L, %L, ''ADCB''', u_viewer, a_acct),
    format('%L, %L, ''ADCB''', u_gone, a_acct), format('%L, %L, ''ADCB''', u_bown, a_acct),
    format('NULL, %L, ''ADCB''', a_acct)] LOOP
    n := n + 1; failed := failed || pg_temp.bw_err(format('bank_ws_create(%s)', r),
      format('SELECT bank_ws_create(%s)::text', r), 'NOT_ALLOWED');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.bw_err('bank_ws_create of an unknown bank',
    format('SELECT bank_ws_create(%L, %L, ''NOPE'')::text', u_owner, a_acct), 'BANK_UNKNOWN');
  n := n + 1; failed := failed || pg_temp.bw_err('bank_ws_create of another account''s bank code',
    format('SELECT bank_ws_create(%L, %L, ''ENBD'')::text', u_bown, b_acct), 'BANK_UNKNOWN');
  ws_a := pg_temp.cs_try('service_role', NULL, format('SELECT bank_ws_create(%L, %L, ''ADCB'', %L)::text',
    u_owner, a_acct, t0))::uuid;
  ws_e := bank_ws_create(u_admin, a_acct, 'ENBD', t0);
  ws_b := bank_ws_create(u_bown, b_acct, 'ADCB', t0);
  n := n + 1; failed := failed || pg_temp.cs_ok(
    bank_ws_create(u_admin, a_acct, 'ADCB') = ws_a AND bank_ws_create(u_owner, a_acct, 'ADCB', t0) = ws_a
    AND (SELECT count(*) FROM bank_workspaces WHERE account_id = a_acct) = 2
    AND (SELECT count(*) FROM bank_workspaces WHERE account_id = b_acct) = 1,
    'a second bank_ws_create did not return the same id (or duplicated the workspace)');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_task_templates
      WHERE account_id = a_acct AND bank_code = 'ADCB' AND template_key = 'bank_ws_action_needed'
        AND title = 'Action needed' AND due_hours IS NULL) = 1
    AND (SELECT count(*) FROM case_task_templates
          WHERE template_key = 'bank_ws_action_needed' AND account_id IN (a_acct, b_acct)) = 3
    AND (SELECT title || '/' || due_hours FROM case_task_templates
          WHERE account_id = a_acct AND bank_code = 'ENBD' AND template_key = 'bank_ws_action_needed') = 'Custom action/24',
    'bank_ws_create did not seed one ''Action needed'' template per (account, bank), or overwrote a configured one');

  -- ---------- access parity (twice: before and after k3 closes) ----------
  FOR ph IN 1 .. 2 LOOP
    IF ph = 2 THEN
      PERFORM case_set_stage(k3, u_owner, 'Closed', NULL, false);
    END IF;
    FOR i IN 1 .. array_length(usr, 1) LOOP
      FOREACH wsx IN ARRAY ARRAY[ws_a, ws_e, ws_b] LOOP
        st := bank_ws_access(wsx, usr[i]);
        r := pg_temp.bw_expect(wsx, usr[i]);
        n := n + 1; failed := failed || pg_temp.cs_ok(st IS NOT DISTINCT FROM r,
          format('phase %s: bank_ws_access of %s in %s is %s, the rule says %s', ph, lbl[i],
            CASE wsx WHEN ws_a THEN 'A/ADCB' WHEN ws_e THEN 'A/ENBD' ELSE 'B/ADCB' END, st, r));
        -- bank_ws_list shows exactly the accessible workspaces of the account asked for, with the level.
        b1 := EXISTS (SELECT 1 FROM bank_workspaces w, bank_ws_list(usr[i], w.account_id) l
                       WHERE w.id = wsx AND l.bank_ws_id = wsx AND l.access = st);
        n := n + 1; failed := failed || pg_temp.cs_ok(b1 = (st IS NOT NULL),
          format('phase %s: bank_ws_list for %s lists %s: %s, access is %s', ph, lbl[i],
            CASE wsx WHEN ws_a THEN 'A/ADCB' WHEN ws_e THEN 'A/ENBD' ELSE 'B/ADCB' END, b1, st));
        -- bank_ws_cases: the readable cases of the bank (open and closed), only with access.
        ids := (SELECT coalesce(array_agg(x.case_id ORDER BY x.case_id), '{}') FROM bank_ws_cases(wsx, usr[i]) x);
        ids2 := (SELECT coalesce(array_agg(c.id ORDER BY c.id), '{}') FROM cases c, bank_workspaces w
                  WHERE w.id = wsx AND c.account_id = w.account_id AND c.bank_code = w.bank_code
                    AND st IS NOT NULL AND case_can_read(c.id, usr[i]));
        n := n + 1; failed := failed || pg_temp.cs_ok(ids = ids2,
          format('phase %s: bank_ws_cases for %s in %s lists %s cases, expected %s', ph, lbl[i],
            CASE wsx WHEN ws_a THEN 'A/ADCB' WHEN ws_e THEN 'A/ENBD' ELSE 'B/ADCB' END,
            cardinality(ids), cardinality(ids2)));
      END LOOP;
    END LOOP;
    -- The parity is not vacuous: who is what, pinned.
    -- owner, admin, lead, lead2, coord, agent, agent2, agent3, viewer, guest, gone, B owner, agent4
    n := n + 1; failed := failed || pg_temp.cs_ok(
      pg_temp.bw_matrix(ws_a, usr) = CASE ph
        WHEN 1 THEN 'admin,admin,member,member,member,member,member,-,-,-,-,-,-'
        ELSE        'admin,admin,member,-,member,member,-,-,-,-,-,-,-' END
      AND pg_temp.bw_matrix(ws_e, usr) = 'admin,admin,-,member,-,-,member,-,-,-,-,-,-'
      AND pg_temp.bw_matrix(ws_b, usr) = '-,-,-,-,-,-,-,-,-,-,-,admin,-',
      format('phase %s: access is not as pinned (A/ADCB %s; A/ENBD %s; B/ADCB %s)', ph,
        pg_temp.bw_matrix(ws_a, usr), pg_temp.bw_matrix(ws_e, usr), pg_temp.bw_matrix(ws_b, usr)));
    IF ph = 1 THEN
      n := n + 1; failed := failed || pg_temp.cs_ok(
        (SELECT string_agg(l.bank_code || '/' || l.bank_name || '/' || l.access, ',' ORDER BY l.bank_code)
           FROM bank_ws_list(u_lead2, a_acct) l) = 'ADCB/ADCB Bank/member,ENBD/Emirates NBD/member'
        AND NOT EXISTS (SELECT 1 FROM bank_ws_list(u_owner, b_acct))
        AND NOT EXISTS (SELECT 1 FROM bank_ws_list(u_bown, a_acct))
        AND (SELECT array_agg(x.case_id) FROM bank_ws_cases(ws_a, u_agent) x) = ARRAY[k1]
        AND NOT EXISTS (SELECT 1 FROM bank_ws_cases(ws_a, u_bown))
        AND NOT EXISTS (SELECT 1 FROM bank_ws_cases(ws_b, u_owner)),
        'bank_ws_list / bank_ws_cases are not as pinned (lead2: ADCB and ENBD members; nothing across accounts; agent: k1 only)');

      -- ---------- threads and posts (k3 still open) ----------
      th1 := bank_ws_thread_create(ws_a, u_agent, 'Docs for k1', 'root of k1', k1, NULL, t0);
      root1 := (SELECT p.id FROM bank_ws_posts p WHERE p.thread_id = th1 AND p.parent_post_id IS NULL);
      rp1 := bank_ws_post_add(th1, u_agent2, NULL, 'agent2 reply', NULL, NULL, t0 + interval '1 minute');
      rp2 := bank_ws_post_add(th1, u_lead, rp1, 'nested reply', NULL, NULL, t0 + interval '2 minutes');
      rp3 := bank_ws_post_add(th1, u_agent2, NULL, 'agent2 stays', NULL, NULL, t0 + interval '3 minutes');
      PERFORM bank_ws_post_add(th1, u_admin, NULL, 'admin note', NULL, NULL, t0 + interval '4 minutes');
      th2 := pg_temp.cs_try('service_role', NULL, format(
        'SELECT bank_ws_thread_create(%L, %L, ''Unlinked'', ''general'', NULL, NULL, %L)::text', ws_a, u_agent,
        t0 + interval '5 minutes'))::uuid;
      root2 := (SELECT p.id FROM bank_ws_posts p WHERE p.thread_id = th2 AND p.parent_post_id IS NULL);
      th3 := bank_ws_thread_create(ws_a, u_lead2, 'About k3', 'k3 root', k3, NULL, t0 + interval '6 minutes');
      th4 := bank_ws_thread_create(ws_e, u_admin, 'ENBD notes', 'admin root', NULL, NULL, t0 + interval '7 minutes');
      th5 := bank_ws_thread_create(ws_b, u_bown, 'B notes', 'b root', kb, NULL, t0 + interval '8 minutes');
      n := n + 1; failed := failed || pg_temp.cs_ok(
        th1 IS NOT NULL AND th2 IS NOT NULL AND th3 IS NOT NULL AND th4 IS NOT NULL AND th5 IS NOT NULL
        AND (SELECT parent_post_id FROM bank_ws_posts WHERE id = rp1) = root1
        AND (SELECT parent_post_id FROM bank_ws_posts WHERE id = rp2) = rp1
        AND (SELECT string_agg(t.title || '/' || t.post_count || '/' || coalesce(t.case_id::text, '-'), ','
                               ORDER BY t.created_at) FROM bank_ws_threads_list(ws_a, u_coord) t)
            = format('Docs for k1/5/%s,Unlinked/1/-,About k3/1/%s', k1, k3),
        'members / admins could not create threads and replies as pinned (threads_list titles, counts, root links)');

      -- bodies and titles
      FOREACH r IN ARRAY ARRAY['''''', ''' ''', 'E''\t\n \r''', 'NULL', format('%L', repeat('x', 4001))] LOOP
        n := n + 1; failed := failed || pg_temp.bw_err(format('post_add body %s', left(r, 20)),
          format('SELECT bank_ws_post_add(%L, %L, NULL, %s)::text', th2, u_agent, r), 'BODY_INVALID');
        n := n + 1; failed := failed || pg_temp.bw_err(format('thread_create body %s', left(r, 20)),
          format('SELECT bank_ws_thread_create(%L, %L, ''t'', %s)::text', ws_a, u_agent, r), 'BODY_INVALID');
      END LOOP;
      FOREACH r IN ARRAY ARRAY['''''', ''' ''', 'E''\t\n \r''', 'NULL', format('%L', repeat('t', 201))] LOOP
        n := n + 1; failed := failed || pg_temp.bw_err(format('thread_create title %s', left(r, 20)),
          format('SELECT bank_ws_thread_create(%L, %L, %s, ''body'')::text', ws_a, u_agent, r), 'TITLE_INVALID');
      END LOOP;
      n := n + 1; failed := failed || pg_temp.cs_ok(
        bank_ws_post_add(th2, u_agent, NULL, repeat('x', 4000)) IS NOT NULL
        AND bank_ws_thread_create(ws_a, u_agent, repeat('t', 200), repeat('y', 4000)) IS NOT NULL,
        'a 4000-character post or a 200-character title was refused');
      n := n + 1; failed := failed || pg_temp.bw_err('post_add to an unknown thread',
        format('SELECT bank_ws_post_add(%L, %L, NULL, ''b'')::text', gen_random_uuid(), u_agent), 'THREAD_NOT_FOUND');
      n := n + 1; failed := failed || pg_temp.bw_err('thread_create in an unknown bank workspace',
        format('SELECT bank_ws_thread_create(%L, %L, ''t'', ''b'')::text', gen_random_uuid(), u_owner),
        'BANK_WS_NOT_FOUND');
      FOREACH r IN ARRAY ARRAY[root2::text, gen_random_uuid()::text] LOOP
        n := n + 1; failed := failed || pg_temp.bw_err('post_add with a parent outside the thread',
          format('SELECT bank_ws_post_add(%L, %L, %L, ''b'')::text', th1, u_agent, r), 'PARENT_INVALID');
      END LOOP;

      -- links: same account, same bank, readable by the poster; else LINK_INVALID
      tk_e := case_task_create(k2, u_owner, 'bank_ws_action_needed', u_agent2, t0 + interval '1 day', t0);
      tk1 := case_task_create(k1, u_agent, 'bank_ws_action_needed', u_agent, t0 + interval '1 day', t0);
      FOREACH r IN ARRAY ARRAY[
        format('%L, NULL', k2), format('%L, NULL', kb), format('%L, NULL', k5), format('%L, NULL', gen_random_uuid()),
        format('NULL, %L', tk_e), format('%L, %L', k1, tk_e), format('%L, %L', k3, tk1),
        format('NULL, %L', gen_random_uuid())] LOOP
        n := n + 1; failed := failed || pg_temp.bw_err(format('owner''s thread in A/ADCB linking (%s)', r),
          format('SELECT bank_ws_thread_create(%L, %L, ''t'', ''b'', %s)::text', ws_a, u_owner, r), 'LINK_INVALID');
        n := n + 1; failed := failed || pg_temp.bw_err(format('owner''s reply in A/ADCB linking (%s)', r),
          format('SELECT bank_ws_post_add(%L, %L, NULL, ''b'', %s)::text', th1, u_owner, r), 'LINK_INVALID');
      END LOOP;
      n := n + 1; failed := failed || pg_temp.bw_err('agent linking a same-bank case they cannot read',
        format('SELECT bank_ws_post_add(%L, %L, NULL, ''b'', %L)::text', th1, u_agent, k3), 'LINK_INVALID');
      n := n + 1; failed := failed || pg_temp.bw_err('B owner linking A''s case in B',
        format('SELECT bank_ws_post_add(%L, %L, NULL, ''b'', %L)::text', th5, u_bown, k1), 'LINK_INVALID');
      st := bank_ws_post_add(th1, u_owner, NULL, 'task link', NULL, tk1, t0 + interval '9 minutes')::text;
      n := n + 1; failed := failed || pg_temp.cs_ok(
        (SELECT case_id = k1 AND task_id = tk1 FROM bank_ws_posts WHERE id = st::uuid)
        AND (SELECT case_id = k1 AND task_id IS NULL FROM bank_ws_posts WHERE id = root1)
        AND bank_ws_post_add(th1, u_owner, NULL, 'case and task', k1, tk1) IS NOT NULL,
        'a task link did not store its case, or a valid case / task link was refused');
      -- listings: stage / product only to a reader of the case
      n := n + 1; failed := failed || pg_temp.cs_ok(
        (SELECT x.case_id = k3 AND NOT x.case_readable AND x.case_stage IS NULL AND x.case_product IS NULL
           FROM bank_ws_posts_list(th3, u_agent) x WHERE x.parent_post_id IS NULL)
        AND (SELECT x.case_readable AND x.case_stage = 'Submitted' AND x.case_product = 'Mortgage'
               FROM bank_ws_posts_list(th3, u_lead2) x WHERE x.parent_post_id IS NULL)
        AND (SELECT x.case_readable AND x.case_stage = 'Submitted' AND x.case_product = 'Mortgage'
               FROM bank_ws_posts_list(th3, u_admin) x WHERE x.parent_post_id IS NULL)
        AND (SELECT x.case_readable AND x.case_product = 'Loan' AND x.body = 'root of k1'
               FROM bank_ws_posts_list(th1, u_coord) x WHERE x.post_id = root1)
        AND (SELECT NOT x.case_readable AND x.case_stage IS NULL FROM bank_ws_posts_list(th1, u_coord) x
              WHERE x.post_id = rp1),
        'bank_ws_posts_list shows an unreadable case''s stage / product, or hides a readable one''s');

      -- retraction: author only, once
      n := n + 1; failed := failed || pg_temp.bw_err('another member retracting a post',
        format('SELECT bank_ws_post_retract(%L, %L)::text', rp1, u_agent), 'NOT_ALLOWED');
      n := n + 1; failed := failed || pg_temp.bw_err('an admin retracting someone else''s post',
        format('SELECT bank_ws_post_retract(%L, %L)::text', rp1, u_owner), 'NOT_ALLOWED');
      n := n + 1; failed := failed || pg_temp.cs_check('the author could not retract their post',
        'service_role', NULL, format('SELECT bank_ws_post_retract(%L, %L, %L)::text', rp1, u_agent2, t0), '');
      n := n + 1; failed := failed || pg_temp.bw_err('a second retraction',
        format('SELECT bank_ws_post_retract(%L, %L)::text', rp1, u_agent2), 'ALREADY_RETRACTED');
      n := n + 1; failed := failed || pg_temp.bw_err('retracting an unknown post',
        format('SELECT bank_ws_post_retract(%L, %L)::text', gen_random_uuid(), u_agent2), 'POST_NOT_FOUND');
      n := n + 1; failed := failed || pg_temp.cs_ok(
        (SELECT x.retracted AND x.body IS NULL AND x.author_id = u_agent2 FROM bank_ws_posts_list(th1, u_agent) x
          WHERE x.post_id = rp1)
        AND (SELECT count(*) FROM bank_ws_posts_list(th1, u_agent) x WHERE x.retracted) = 1
        AND (SELECT NOT x.retracted AND x.body = 'nested reply' FROM bank_ws_posts_list(th1, u_agent) x
              WHERE x.post_id = rp2)
        AND (SELECT body FROM bank_ws_posts WHERE id = rp1) = 'agent2 reply'
        AND (SELECT retracted_by FROM bank_ws_post_retractions WHERE post_id = rp1) = u_agent2,
        'a retracted post does not list as retracted with no body (or its row or a neighbour changed)');

      -- ---------- pins ----------
      PERFORM bank_ws_pin_set(ws_a, u_admin, 'bank_contacts', 'v1 admin', t0);
      PERFORM bank_ws_pin_set(ws_a, u_lead, 'bank_contacts', 'v2 lead', t0 + interval '1 minute');
      st := pg_temp.cs_try('service_role', NULL, format('SELECT bank_ws_pin_set(%L, %L, ''bank_contacts'', ''v3 coord'', %L)::text',
        ws_a, u_coord, t0 + interval '2 minutes'));
      PERFORM bank_ws_pin_set(ws_a, u_admin, 'product_rules', 'p1', t0);
      PERFORM bank_ws_pin_set(ws_a, u_owner, 'known_pitfalls', repeat('k', 8000), t0);
      PERFORM bank_ws_pin_set(ws_a, u_owner, 'known_pitfalls', '', t0 + interval '1 minute');
      PERFORM bank_ws_pin_set(ws_e, u_lead2, 'required_documents', 'ENBD docs', t0);
      n := n + 1; failed := failed || pg_temp.cs_ok(st ~ '^[0-9]+$',
        format('the coordinator of an open case could not edit a pin (%s)', st));
      FOREACH r IN ARRAY ARRAY[format('%L, %L', ws_a, u_agent), format('%L, %L', ws_a, u_agent2),
        format('%L, %L', ws_e, u_coord), format('%L, %L', ws_e, u_agent2), format('%L, %L', ws_a, u_agent3),
        format('%L, %L', ws_a, u_viewer), format('%L, %L', ws_a, u_bown), format('%L, %L', ws_b, u_owner)] LOOP
        n := n + 1; failed := failed || pg_temp.bw_err(format('bank_ws_pin_set(%s)', r),
          format('SELECT bank_ws_pin_set(%s, ''bank_contacts'', ''x'')::text', r), 'NOT_ALLOWED');
      END LOOP;
      FOREACH r IN ARRAY ARRAY['''other''', 'NULL', '''Bank_contacts'''] LOOP
        n := n + 1; failed := failed || pg_temp.bw_err(format('pin kind %s', r),
          format('SELECT bank_ws_pin_set(%L, %L, %s, ''x'')::text', ws_a, u_admin, r), 'KIND_INVALID');
      END LOOP;
      FOREACH r IN ARRAY ARRAY[format('%L', repeat('x', 8001)), 'NULL'] LOOP
        n := n + 1; failed := failed || pg_temp.bw_err(format('pin body %s', left(r, 12)),
          format('SELECT bank_ws_pin_set(%L, %L, ''bank_contacts'', %s)::text', ws_a, u_admin, r), 'BODY_INVALID');
      END LOOP;
      n := n + 1; failed := failed || pg_temp.bw_err('pin_set in an unknown bank workspace',
        format('SELECT bank_ws_pin_set(%L, %L, ''bank_contacts'', ''x'')::text', gen_random_uuid(), u_admin),
        'BANK_WS_NOT_FOUND');
      n := n + 1; failed := failed || pg_temp.cs_ok(
        (SELECT string_agg(x.kind || '=' || left(x.body, 8), ',' ORDER BY x.kind) FROM bank_ws_pins_list(ws_a, u_agent) x)
          = 'bank_contacts=v3 coord,known_pitfalls=,product_rules=p1'
        AND (SELECT string_agg(x.kind || '=' || left(x.body, 8), ',' ORDER BY x.kind, x.pin_id)
               FROM bank_ws_pins_list(ws_a, u_agent, true) x)
          = 'bank_contacts=v1 admin,bank_contacts=v2 lead,bank_contacts=v3 coord,known_pitfalls=kkkkkkkk,known_pitfalls=,product_rules=p1'
        AND (SELECT count(*) FROM bank_ws_pins WHERE bank_ws_id = ws_a) = 6
        AND (SELECT string_agg(x.body, ',') FROM bank_ws_pins_list(ws_e, u_agent2) x) = 'ENBD docs',
        'pins are not versioned as pinned (latest per kind; every version with p_history)');

      -- ---------- action needed ----------
      act1 := bank_ws_action_mark(th1, u_agent, u_coord, t0 + interval '1 day', t0);
      n := n + 1; failed := failed || pg_temp.cs_ok(
        (SELECT a.case_id = k1 AND a.task_id IS NOT NULL AND a.owner_id = u_coord AND a.due_at = t0 + interval '1 day'
                AND a.created_by = u_agent
           FROM bank_ws_actions a WHERE a.id = act1)
        AND (SELECT k.case_id = k1 AND k.template_key = 'bank_ws_action_needed' AND k.title = 'Action needed'
                    AND k.owner_id = u_coord AND k.due_at = t0 + interval '1 day' AND k.status = 'open'
                    AND k.created_by = u_agent
               FROM case_tasks k JOIN bank_ws_actions a ON a.task_id = k.id WHERE a.id = act1)
        AND (SELECT count(*) FROM case_task_status_log l JOIN bank_ws_actions a ON a.task_id = l.task_id
              WHERE a.id = act1 AND l.from_status IS NULL AND l.to_status = 'open' AND l.actor_id = u_agent
                AND l.case_id = k1) = 1,
        'Action needed on a case-linked thread did not create the template''s case task (with its status log row) and store it');
      n := n + 1; failed := failed || pg_temp.bw_err('a second Action needed',
        format('SELECT bank_ws_action_mark(%L, %L, %L, %L)::text', th1, u_owner, u_agent, t0), 'ALREADY_MARKED');
      n := n + 1; failed := failed || pg_temp.bw_err('Action needed with no due date',
        format('SELECT bank_ws_action_mark(%L, %L, %L, NULL)::text', th2, u_agent, u_agent), 'DUE_REQUIRED');
      FOREACH r IN ARRAY ARRAY['infinity', '-infinity'] LOOP
        n := n + 1; failed := failed || pg_temp.bw_err(format('Action needed due %s', r),
          format('SELECT bank_ws_action_mark(%L, %L, %L, %L)::text', th2, u_agent, u_agent, r), 'DUE_INVALID');
      END LOOP;
      -- unlinked: owner must be a MEMBER (an admin who is not one may not own it)
      FOREACH r IN ARRAY ARRAY['NULL', format('%L', u_owner), format('%L', u_admin), format('%L', u_agent4),
        format('%L', u_agent3), format('%L', u_bown), format('%L', u_gone)] LOOP
        n := n + 1; failed := failed || pg_temp.bw_err(format('Action needed on an unlinked thread owned by %s', r),
          format('SELECT bank_ws_action_mark(%L, %L, %s, %L)::text', th2, u_agent, r, t0), 'OWNER_INVALID');
      END LOOP;
      -- case-linked: case_task_create's owner rule (u_agent cannot write k3)
      n := n + 1; failed := failed || pg_temp.bw_err('Action needed on a k3 thread owned by an agent off k3',
        format('SELECT bank_ws_action_mark(%L, %L, %L, %L)::text', th3, u_lead2, u_agent, t0), 'OWNER_INVALID');
      n := n + 1; failed := failed || pg_temp.bw_err('Action needed on a case-linked thread with a NULL owner',
        format('SELECT bank_ws_action_mark(%L, %L, NULL, %L)::text', th3, u_lead2, t0), 'OWNER_INVALID');
      n := n + 1; failed := failed || pg_temp.bw_err('Action needed on an unknown thread',
        format('SELECT bank_ws_action_mark(%L, %L, %L, %L)::text', gen_random_uuid(), u_agent, u_agent, t0),
        'THREAD_NOT_FOUND');
      -- th3 links k3 (ADCB); once case_set_details moves k3 to ENBD, the
      -- ADCB workspace may not mark it (no task from ENBD's template).
      -- Rolled back, so th3 is marked normally below.
      BEGIN
        PERFORM case_set_details(k3, u_owner, 'ENBD', 'Mortgage', 3000);
        n := n + 1; failed := failed || pg_temp.bw_err('Action needed on a thread whose case moved to another bank',
          format('SELECT bank_ws_action_mark(%L, %L, %L, %L)::text', th3, u_admin, u_agent2, t0), 'LINK_INVALID');
        n := n + 1; failed := failed || pg_temp.cs_ok(
          (SELECT count(*) FROM case_tasks WHERE case_id = k3) = 0
          AND (SELECT count(*) FROM bank_ws_actions WHERE thread_id = th3) = 0,
          'a refused Action needed on a moved case created a task or an action');
        RAISE EXCEPTION USING ERRCODE = 'ZT126', MESSAGE = 'moved-case rollback';
      EXCEPTION WHEN SQLSTATE 'ZT126' THEN
        NULL;
      END;
      act2 := pg_temp.cs_try('service_role', NULL, format('SELECT bank_ws_action_mark(%L, %L, %L, %L, %L)::text',
        th2, u_agent, u_agent2, t0 + interval '2 days', t0))::uuid;
      PERFORM bank_ws_action_mark(th3, u_lead2, u_agent2, t0 + interval '3 days', t0);
      PERFORM bank_ws_action_mark(th4, u_admin, u_agent2, t0 + interval '4 days', t0);
      n := n + 1; failed := failed || pg_temp.cs_ok(
        (SELECT a.case_id IS NULL AND a.task_id IS NULL AND a.owner_id = u_agent2 FROM bank_ws_actions a WHERE a.id = act2)
        AND (SELECT string_agg(coalesce(x.task_status, '-'), ',' ORDER BY x.due_at) FROM bank_ws_actions_list(ws_a, u_agent) x)
          = 'open,-,-'
        AND (SELECT string_agg(coalesce(x.task_status, '-'), ',' ORDER BY x.due_at) FROM bank_ws_actions_list(ws_a, u_lead2) x)
          = '-,-,open'
        AND (SELECT string_agg(t.action_owner_id::text, ',' ORDER BY t.created_at) FROM bank_ws_threads_list(ws_a, u_admin) t
              WHERE t.action_owner_id IS NOT NULL) = format('%s,%s,%s', u_coord, u_agent2, u_agent2),
        'actions are not listed as pinned (unlinked action without a task; task status only to a reader of its case)');

      -- ---------- non-members: NOT_ALLOWED on every write, nothing from every read ----------
      th_m := bank_ws_thread_create(ws_a, u_agent, 'to mark', 'b');
      FOR i IN 1 .. array_length(nonmem, 1) LOOP
        FOREACH r IN ARRAY ARRAY[
          format('SELECT bank_ws_thread_create(%L, %L, ''t'', ''b'')::text', ws_a, nonmem[i]),
          format('SELECT bank_ws_post_add(%L, %L, NULL, ''b'')::text', th1, nonmem[i]),
          format('SELECT bank_ws_post_add(%L, %L, %L, ''b'')::text', th1, nonmem[i], rp2),
          format('SELECT bank_ws_post_retract(%L, %L)::text', rp2, nonmem[i]),
          format('SELECT bank_ws_pin_set(%L, %L, ''bank_contacts'', ''x'')::text', ws_a, nonmem[i]),
          format('SELECT bank_ws_action_mark(%L, %L, %L, %L)::text', th_m, nonmem[i], u_agent, t0)] LOOP
          n := n + 1; failed := failed || pg_temp.bw_err(format('%s: %s', lbl[array_position(usr, nonmem[i])],
            left(regexp_replace(r, '^SELECT (bank_ws_[a-z_]+).*$', '\1'), 40)), r, 'NOT_ALLOWED');
        END LOOP;
        n := n + 1; failed := failed || pg_temp.cs_ok(
          NOT EXISTS (SELECT 1 FROM bank_ws_threads_list(ws_a, nonmem[i]))
          AND NOT EXISTS (SELECT 1 FROM bank_ws_posts_list(th1, nonmem[i]))
          AND NOT EXISTS (SELECT 1 FROM bank_ws_pins_list(ws_a, nonmem[i], true))
          AND NOT EXISTS (SELECT 1 FROM bank_ws_actions_list(ws_a, nonmem[i]))
          AND NOT EXISTS (SELECT 1 FROM bank_ws_cases(ws_a, nonmem[i]))
          AND NOT EXISTS (SELECT 1 FROM bank_ws_list(nonmem[i], a_acct)),
          format('the %s reads something of A/ADCB', lbl[array_position(usr, nonmem[i])]));
      END LOOP;
      -- the admin who is not a member writes everywhere in the account
      n := n + 1; failed := failed || pg_temp.cs_ok(
        bank_ws_post_add(th4, u_owner, NULL, 'owner too') IS NOT NULL
        AND bank_ws_thread_create(ws_a, u_admin, 'k3 by admin', 'b', k3) IS NOT NULL,
        'an admin could not post or link a case');
    END IF;
  END LOOP;

  -- ---------- after the lapse (k3 closed: agent2 and lead2 left A/ADCB) ----------
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT x.body = 'agent2 stays' AND NOT x.retracted FROM bank_ws_posts_list(th1, u_agent) x WHERE x.post_id = rp3)
    AND NOT EXISTS (SELECT 1 FROM bank_ws_posts_list(th1, u_agent2))
    AND NOT EXISTS (SELECT 1 FROM bank_ws_threads_list(ws_a, u_lead2))
    AND (SELECT count(*) FROM bank_ws_threads_list(ws_e, u_agent2)) = 1,
    'after the lapse, the lapsed member''s posts are not visible to others, or the lapsed member still reads A/ADCB');
  FOREACH r IN ARRAY ARRAY[
    format('SELECT bank_ws_post_add(%L, %L, NULL, ''b'')::text', th1, u_agent2),
    format('SELECT bank_ws_post_retract(%L, %L)::text', rp3, u_agent2),
    format('SELECT bank_ws_thread_create(%L, %L, ''t'', ''b'')::text', ws_a, u_lead2),
    format('SELECT bank_ws_pin_set(%L, %L, ''bank_contacts'', ''x'')::text', ws_a, u_lead2)] LOOP
    n := n + 1; failed := failed || pg_temp.bw_err(format('after the lapse: %s', left(r, 30)), r, 'NOT_ALLOWED');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    bank_ws_post_add(th1, u_admin, NULL, 'admin unaffected') IS NOT NULL
    AND bank_ws_post_add(th4, u_agent2, NULL, 'still on ENBD') IS NOT NULL,
    'the lapse touched the admin or the member''s other bank workspace');

  -- ---------- RLS as authenticated (active account, own access) ----------
  -- u_agent: A/ADCB only; owner: all of A; agent on no case: nothing; B owner: B only.
  FOREACH r IN ARRAY ARRAY['bank_workspaces', 'bank_ws_threads', 'bank_ws_pins', 'bank_ws_actions',
                           'bank_ws_post_retractions'] LOOP
    st := concat_ws(',',
      pg_temp.cs_try('authenticated', u_agent, format('SELECT count(*)::text FROM public.%I', r)),
      pg_temp.cs_try('authenticated', u_owner, format('SELECT count(*)::text FROM public.%I', r)),
      pg_temp.cs_try('authenticated', u_agent4, format('SELECT count(*)::text FROM public.%I', r)),
      pg_temp.cs_try('authenticated', u_bown, format('SELECT count(*)::text FROM public.%I', r)));
    EXECUTE format($q$SELECT concat_ws(',',
        (SELECT count(*) FROM public.%1$I WHERE %2$I = %3$L),
        (SELECT count(*) FROM public.%1$I WHERE account_id = %4$L),
        0,
        (SELECT count(*) FROM public.%1$I WHERE account_id = %5$L))$q$,
      r, CASE r WHEN 'bank_workspaces' THEN 'id' ELSE 'bank_ws_id' END, ws_a, a_acct, b_acct) INTO r2;
    n := n + 1; failed := failed || pg_temp.cs_ok(st = r2 AND split_part(r2, ',', 1) <> '0'
      AND split_part(r2, ',', 1) <> split_part(r2, ',', 2) OR (r = 'bank_ws_post_retractions' AND st = r2),
      format('RLS on %s as authenticated (agent, owner, agent on no case, B owner) gives %s, expected %s', r, st, r2));
  END LOOP;
  FOREACH r IN ARRAY ARRAY['SELECT count(*)::text FROM public.bank_ws_posts',
    'INSERT INTO public.bank_ws_threads (bank_ws_id, account_id, title, author_id) SELECT bank_ws_id, account_id, ''x'', author_id FROM public.bank_ws_threads LIMIT 1',
    'UPDATE public.bank_ws_threads SET title = title',
    'DELETE FROM public.bank_ws_pins'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('authenticated was not refused: %s', left(r, 50)),
      'authenticated', u_owner, r, 'ERROR 42501 %');
  END LOOP;
  FOREACH r IN ARRAY ARRAY['bank_workspaces', 'bank_ws_pins', 'bank_ws_threads', 'bank_ws_posts',
                           'bank_ws_post_retractions', 'bank_ws_actions'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('service_role read %s directly', r),
      'service_role', NULL, format('SELECT count(*)::text FROM public.%I', r), 'ERROR 42501 %');
    n := n + 1; failed := failed || pg_temp.cs_check(format('anon read %s', r),
      'anon', NULL, format('SELECT count(*)::text FROM public.%I', r), 'ERROR 42501 %');
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('%s could call bank_ws_list', r), r, u_owner,
      format('SELECT count(*)::text FROM bank_ws_list(%L, %L)', u_owner, a_acct), 'ERROR 42501 %');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.cs_try('service_role', NULL, format('SELECT count(*)::text FROM bank_ws_posts_list(%L, %L)', th1, u_agent))
      = (SELECT count(*)::text FROM bank_ws_posts WHERE thread_id = th1),
    'service_role cannot read a thread through bank_ws_posts_list');

  -- ---------- grants ----------
  SELECT string_agg(rl || '/' || pv || '/' || t, ',' ORDER BY rl, pv, t) INTO st
    FROM unnest(ARRAY['bank_workspaces', 'bank_ws_pins', 'bank_ws_threads', 'bank_ws_posts',
                      'bank_ws_post_retractions', 'bank_ws_actions']) t,
         unnest(ARRAY['anon', 'authenticated', 'service_role']) rl,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) pv
   WHERE has_table_privilege(rl, 'public.' || t, pv);
  SELECT string_agg('authenticated/SELECT/' || t, ',' ORDER BY t) INTO r2
    FROM unnest(ARRAY['bank_workspaces', 'bank_ws_pins', 'bank_ws_threads', 'bank_ws_post_retractions',
                      'bank_ws_actions']) t;
  n := n + 1; failed := failed || pg_temp.cs_ok(st = r2 AND NOT EXISTS (
      SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) rl,
                    unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) pv
       WHERE has_sequence_privilege(rl, 'public.bank_ws_pins_id_seq', pv)),
    format('126 table privileges are not exactly authenticated SELECT on every table but bank_ws_posts (%s)', st));
  SELECT string_agg(rl || '/' || f, ',' ORDER BY rl, f) INTO st
    FROM unnest(ARRAY['bank_ws_viewer(uuid,uuid)', 'bank_ws_access(uuid,uuid)', 'bank_ws_rls_access(uuid)',
      'bank_ws_require_member(uuid,uuid)', 'bank_ws_link_case(uuid,text,uuid,uuid,uuid)', 'bank_ws_check_body(text)',
      'bank_ws_create(uuid,uuid,text,timestamptz)', 'bank_ws_list(uuid,uuid)', 'bank_ws_cases(uuid,uuid)',
      'bank_ws_pin_set(uuid,uuid,text,text,timestamptz)', 'bank_ws_pins_list(uuid,uuid,boolean)',
      'bank_ws_thread_create(uuid,uuid,text,text,uuid,uuid,timestamptz)',
      'bank_ws_post_add(uuid,uuid,uuid,text,uuid,uuid,timestamptz)', 'bank_ws_post_retract(uuid,uuid,timestamptz)',
      'bank_ws_threads_list(uuid,uuid)', 'bank_ws_posts_list(uuid,uuid)',
      'bank_ws_action_mark(uuid,uuid,uuid,timestamptz,timestamptz)', 'bank_ws_actions_list(uuid,uuid)']) f,
         unnest(ARRAY['anon', 'authenticated', 'service_role']) rl
   WHERE has_function_privilege(rl, 'public.' || f, 'EXECUTE');
  SELECT string_agg(rl || '/' || f, ',' ORDER BY rl, f) INTO r2
    FROM (SELECT 'authenticated' AS rl, 'bank_ws_rls_access(uuid)' AS f
          UNION ALL
          SELECT 'service_role', f FROM unnest(ARRAY['bank_ws_create(uuid,uuid,text,timestamptz)',
            'bank_ws_list(uuid,uuid)', 'bank_ws_cases(uuid,uuid)', 'bank_ws_pin_set(uuid,uuid,text,text,timestamptz)',
            'bank_ws_pins_list(uuid,uuid,boolean)', 'bank_ws_thread_create(uuid,uuid,text,text,uuid,uuid,timestamptz)',
            'bank_ws_post_add(uuid,uuid,uuid,text,uuid,uuid,timestamptz)', 'bank_ws_post_retract(uuid,uuid,timestamptz)',
            'bank_ws_threads_list(uuid,uuid)', 'bank_ws_posts_list(uuid,uuid)',
            'bank_ws_action_mark(uuid,uuid,uuid,timestamptz,timestamptz)', 'bank_ws_actions_list(uuid,uuid)']) f) e;
  n := n + 1; failed := failed || pg_temp.cs_ok(st = r2,
    format('126 function privileges are not exactly the API to service_role and bank_ws_rls_access to authenticated (%s)', st));

  -- ---------- append-only, the owner included (last: some of these succeed on a broken tree) ----------
  FOREACH r IN ARRAY ARRAY['bank_workspaces', 'bank_ws_pins', 'bank_ws_threads', 'bank_ws_posts',
                           'bank_ws_post_retractions', 'bank_ws_actions'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('UPDATE of %s as the owner was not refused', r), NULL, NULL,
      format('UPDATE public.%I SET account_id = account_id', r), format('ERROR 42501 -: public.%s is append-only (UPDATE refused)', r));
    n := n + 1; failed := failed || pg_temp.cs_check(format('DELETE from %s as the owner was not refused', r), NULL, NULL,
      format('DELETE FROM public.%I', r), format('ERROR 42501 -: public.%s is append-only (DELETE refused)', r));
    n := n + 1; failed := failed || pg_temp.cs_check(format('TRUNCATE of %s as the owner was not refused', r), NULL, NULL,
      format('TRUNCATE public.%I CASCADE', r), 'ERROR 42501 -: public.% is append-only (TRUNCATE refused)');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
      WHERE c.relnamespace = 'public'::regnamespace AND NOT tg.tgisinternal
        AND tg.tgfoid = 'public.case_append_only()'::regprocedure
        AND c.relname IN ('bank_workspaces', 'bank_ws_pins', 'bank_ws_threads', 'bank_ws_posts',
                          'bank_ws_post_retractions', 'bank_ws_actions')) = 12,
    'not every 126 table has its row and TRUNCATE append-only triggers');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT126', MESSAGE = 'verify-bank-workspaces rollback';
  EXCEPTION WHEN SQLSTATE 'ZT126' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'bank workspaces verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'bank workspaces verification passed (% checks)', n;
END
$verify$;
