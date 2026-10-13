-- Behavioural regression suite for workspaces (migrations 082, 083, 099, 105).
--
-- A person now has one profiles row per account they belong to, and
-- exactly one of them is_active: the workspace they are working in.
-- Every policy means "the caller's ACTIVE account" because
-- is_account_member(), current_account_id() and current_role_rank()
-- read that row alone. This asserts that a person with two
-- memberships sees one account at a time (and the other after
-- switch_account, and the first again after switching back), that a
-- bank_guest sees nothing, that only switch_account() moves the active
-- mark, and that the 080 deals policies and the storage policies no
-- longer read "the caller's profile" as a single row. Also that a
-- member removed from their only workspace leaves as neither owner nor
-- admin, and that add_workspace_member adds only someone the caller
-- administers elsewhere, refusing anyone else as it refuses an unknown
-- email. And that a person deactivated in one workspace and live in
-- another reads none of the first's notifications, gets none of its
-- team-activity alerts, and cannot approve or retire its AI policies.
-- And (099) that a team leader adds agents and viewers, by email and by
-- invite link, and nothing else: no other role, no new login, no roster
-- change, no one else's links (a DELETE with no WHERE included); that an
-- agent adds nobody; that a leader of another workspace writes no link
-- into this one; and that a link stops working when its creator may no
-- longer grant its role. And (105) that only a live owner archives or
-- restores a workspace; that archiving refuses while the owner has
-- nowhere else to go, a number or phone system is connected, or a live
-- member has no other workspace; that it moves everyone active there,
-- revokes its pending links and is audited; and that afterwards nobody
-- reads it, switches or redeems into it, or is made active there by
-- anything else (remove_account_member's promotion included), nor
-- made live there again (deactivated_at cleared); that another
-- workspace's phone system routing a number or an extension there
-- refuses the archive too; that afterwards no number, phone system,
-- route or extension is connected to it; and that its notifications
-- leave its members' bell.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_oa     UUID := '00000000-0000-4000-8000-000000083001';  -- owner of A
  u_ob     UUID := '00000000-0000-4000-8000-000000083002';  -- owner of B
  u_u      UUID := '00000000-0000-4000-8000-000000083003';  -- agent in A, B and C
  u_x      UUID := '00000000-0000-4000-8000-000000083004';  -- agent in A only
  u_g      UUID := '00000000-0000-4000-8000-000000083005';  -- bank guest in A, agent in B
  u_ad     UUID := '00000000-0000-4000-8000-000000083006';  -- admin of A
  a_acct   UUID;
  b_acct   UUID;
  c_acct   UUID;   -- U's third membership (deactivated for checks 4 and 8)
  d_acct   UUID;   -- U has no row here
  p_u_a    UUID;   -- U's profile ids (deals.assigned_to is a profile id)
  p_u_b    UUID;
  p_x      UUID;
  ct       UUID;
  cv_a     UUID;   -- A's conversation assigned to U
  cv_b     UUID;   -- B's conversation assigned to U
  pl       UUID;
  st       UUID;
  team     UUID;
  tm_ctid  TEXT;
  tt_ctid  TEXT;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given);
  -- 'ok', or the error as 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ws_try(p_role text, p_uid uuid, p_sql text)
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

  -- The value of a one-column query run as a signed-in user ('null' for
  -- NULL), or the error as 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ws_val(p_uid uuid, p_sql text)
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
        RETURN coalesce(v, 'null');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  -- Fixture: each auth user gets a personal account and its owner row.
  INSERT INTO auth.users (id, email) VALUES
    (u_oa, 'ws-owner-a@example.invalid'),
    (u_ob, 'ws-owner-b@example.invalid'),
    (u_u,  'ws-multi@example.invalid'),
    (u_x,  'ws-a-only@example.invalid'),
    (u_g,  'ws-guest@example.invalid'),
    (u_ad, 'ws-admin-a@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_oa;
  SELECT id INTO b_acct FROM accounts WHERE owner_user_id = u_ob;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  INSERT INTO accounts (name, owner_user_id) VALUES ('WS C', u_oa) RETURNING id INTO c_acct;
  INSERT INTO accounts (name, owner_user_id) VALUES ('WS D', u_oa) RETURNING id INTO d_acct;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_u, u_x);
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_ad;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB'
   WHERE user_id = u_g;

  -- ---------- 1. one active row per person ----------
  -- Every existing row became active (column default) and each person
  -- still has exactly one, before anyone gains a second membership.
  n := n + 1;
  IF EXISTS (SELECT 1 FROM profiles GROUP BY user_id
              HAVING count(*) FILTER (WHERE is_active) <> 1)
     OR (SELECT count(*) FROM profiles WHERE user_id IN (u_oa, u_ob, u_u, u_x, u_g, u_ad)) <> 6 THEN
    failed := array_append(failed, 'backfill: a person does not have exactly one active row'::text);
  END IF;

  -- Second memberships, inactive, written as the migration owner.
  INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active) VALUES
    (u_u, '', 'ws-multi@example.invalid', b_acct, 'agent', false),
    (u_u, '', 'ws-multi@example.invalid', c_acct, 'agent', false),
    (u_g, '', 'ws-guest@example.invalid', b_acct, 'agent', false);
  SELECT id INTO p_u_a FROM profiles WHERE user_id = u_u AND account_id = a_acct;
  SELECT id INTO p_u_b FROM profiles WHERE user_id = u_u AND account_id = b_acct;
  SELECT id INTO p_x   FROM profiles WHERE user_id = u_x;

  -- Per account: a contact and conversation assigned to U, and one not.
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_oa, '971500083001', 'WS A for U') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, contact_id, user_id, assigned_agent_id)
  VALUES (a_acct, ct, u_oa, u_u) RETURNING id INTO cv_a;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_oa, '971500083002', 'WS A for X') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, contact_id, user_id, assigned_agent_id)
  VALUES (a_acct, ct, u_oa, u_x);
  INSERT INTO pipelines (account_id, user_id, name) VALUES (a_acct, u_oa, 'WS A') RETURNING id INTO pl;
  INSERT INTO pipeline_stages (pipeline_id, name) VALUES (pl, 'New') RETURNING id INTO st;
  INSERT INTO deals (account_id, user_id, pipeline_id, stage_id, contact_id, title, assigned_to) VALUES
    (a_acct, u_oa, pl, st, ct, 'A own',   p_u_a),
    (a_acct, u_oa, pl, st, ct, 'A for X', p_x);

  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (b_acct, u_ob, '971500083003', 'WS B for U') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, contact_id, user_id, assigned_agent_id)
  VALUES (b_acct, ct, u_ob, u_u) RETURNING id INTO cv_b;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (b_acct, u_ob, '971500083004', 'WS B unassigned') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, contact_id, user_id) VALUES (b_acct, ct, u_ob);
  INSERT INTO pipelines (account_id, user_id, name) VALUES (b_acct, u_ob, 'WS B') RETURNING id INTO pl;
  INSERT INTO pipeline_stages (pipeline_id, name) VALUES (pl, 'New') RETURNING id INTO st;
  INSERT INTO deals (account_id, user_id, pipeline_id, stage_id, contact_id, title, assigned_to) VALUES
    (b_acct, u_ob, pl, st, ct, 'B own',   p_u_b),
    (b_acct, u_ob, pl, st, ct, 'B owner', NULL);

  INSERT INTO teams (account_id, name) VALUES (a_acct, 'WS team') RETURNING id INTO team;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (team, u_u, a_acct);
  SELECT ctid::text INTO tm_ctid FROM team_members WHERE team_id = team AND user_id = u_u;
  SELECT ctid::text INTO tt_ctid FROM teams WHERE id = team;

  INSERT INTO storage.objects (bucket_id, name)
  VALUES ('chat-media', 'account-' || a_acct::text || '/inbound/ws-083.jpg');

  -- ---------- 2, 3, 9. one account at a time: A, then B, then A again ----------
  -- Switching back defeats a helper that reads "the first row" instead
  -- of the active one: whichever row that is, one of the states fails.
  FOR i IN 1..3 LOOP
    DECLARE
      k     TEXT := CASE i WHEN 1 THEN 'A' WHEN 2 THEN 'B' ELSE 'A again' END;
      want  UUID := CASE i WHEN 2 THEN b_acct ELSE a_acct END;
      w_ct  TEXT := CASE i WHEN 2 THEN 'WS B for U' ELSE 'WS A for U' END;
      w_cv  TEXT := CASE i WHEN 2 THEN cv_b::text ELSE cv_a::text END;
      w_dl  TEXT := CASE i WHEN 2 THEN 'B own' ELSE 'A own' END;
    BEGIN
      IF i > 1 THEN
        r := pg_temp.ws_try('authenticated', u_u, format('SELECT public.switch_account(%L)', want));
        n := n + 1;
        IF r <> 'ok' OR (SELECT account_id FROM profiles WHERE user_id = u_u AND is_active) IS DISTINCT FROM want THEN
          failed := array_append(failed, ('isolation: switch_account to ' || k || ': ' || r)::text);
        END IF;
      END IF;
      r := pg_temp.ws_val(u_u, 'SELECT public.current_account_id()::text');
      n := n + 1;
      IF r <> want::text THEN
        failed := array_append(failed, ('isolation: current_account_id() with ' || k || ' active: ' || r)::text);
      END IF;
      r := pg_temp.ws_val(u_u, 'SELECT coalesce(string_agg(name, '','' ORDER BY name), '''') FROM contacts');
      n := n + 1;
      IF r <> w_ct THEN
        failed := array_append(failed, ('isolation: contacts with ' || k || ' active: got "' || r || '", want "' || w_ct || '"')::text);
      END IF;
      r := pg_temp.ws_val(u_u, 'SELECT coalesce(string_agg(id::text, '','' ORDER BY id), '''') FROM conversations');
      n := n + 1;
      IF r <> w_cv THEN
        failed := array_append(failed, ('isolation: conversations with ' || k || ' active: got "' || r || '"')::text);
      END IF;
      -- 9. The 080 deals policies took "the caller's profile" by user_id
      -- alone, which is more than one row now.
      r := pg_temp.ws_val(u_u, 'SELECT coalesce(string_agg(title, '','' ORDER BY title), '''') FROM deals');
      n := n + 1;
      IF r <> w_dl THEN
        failed := array_append(failed, ('deals with ' || k || ' active: got "' || r || '", want "' || w_dl || '"')::text);
      END IF;
      -- 3. Profiles: the active account's members, never the other's.
      r := pg_temp.ws_val(u_u, format(
        'SELECT count(*) FILTER (WHERE user_id = %L) || ''/'' || count(*) FILTER (WHERE user_id = %L) FROM profiles',
        u_x, u_ob));
      n := n + 1;
      IF r <> (CASE i WHEN 2 THEN '0/1' ELSE '1/0' END) THEN
        failed := array_append(failed, ('isolation: profiles of A-only/B-owner with ' || k || ' active: ' || r)::text);
      END IF;
    END;
  END LOOP;

  -- ---------- 5. team membership survives switching ----------
  n := n + 1;
  IF (SELECT ctid::text FROM team_members WHERE team_id = team AND user_id = u_u) IS DISTINCT FROM tm_ctid
     OR (SELECT ctid::text FROM teams WHERE id = team) IS DISTINCT FROM tt_ctid THEN
    failed := array_append(failed, 'switching away and back rewrote or removed U''s team membership'::text);
  END IF;

  -- ---------- 6. a bank guest sees nothing ----------
  r := pg_temp.ws_val(u_g, format(
    'SELECT public.is_account_member(%L, ''viewer'') || ''/'' || public.current_role_rank()'
    ' || ''/'' || coalesce(public.current_account_id()::text, ''null'')', a_acct));
  n := n + 1;
  IF r <> 'false/0/null' THEN
    failed := array_append(failed, ('guest: member/rank/current account = ' || r || ', want false/0/null')::text);
  END IF;
  r := pg_temp.ws_val(u_g,
    'SELECT (SELECT count(*) FROM contacts) || ''/'' || (SELECT count(*) FROM conversations)'
    ' || ''/'' || (SELECT count(*) FROM deals)');
  n := n + 1;
  IF r <> '0/0/0' THEN
    failed := array_append(failed, ('isolation: guest sees contacts/conversations/deals: ' || r)::text);
  END IF;
  r := pg_temp.ws_val(u_g, format(
    'SELECT count(*) FILTER (WHERE user_id = %L) || ''/'' || count(*) FROM profiles', u_g));
  n := n + 1;
  IF r <> '2/2' THEN
    failed := array_append(failed, ('isolation: guest sees profiles (own/all): ' || r || ', want 2/2')::text);
  END IF;
  r := pg_temp.ws_val(u_g,
    'SELECT string_agg(account_id || ''/'' || role || ''/'' || is_active, '','' ORDER BY is_active DESC) FROM public.my_workspaces()');
  n := n + 1;
  IF r <> a_acct || '/bank_guest/true,' || b_acct || '/agent/false' THEN
    failed := array_append(failed, ('guest: my_workspaces() = ' || r)::text);
  END IF;

  -- ---------- 7. the guard: only switch_account moves the mark ----------
  r := pg_temp.ws_try('authenticated', u_u, format(
    'UPDATE profiles SET is_active = true WHERE user_id = %L AND account_id = %L', u_u, b_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('guard: U activated its inactive row: ' || r)::text);
  END IF;
  r := pg_temp.ws_try('authenticated', u_u, format(
    'UPDATE profiles SET is_active = false WHERE user_id = %L AND account_id = %L', u_u, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('guard: U deactivated its active row: ' || r)::text);
  END IF;
  r := pg_temp.ws_try('authenticated', u_u, format(
    'UPDATE profiles SET account_role = ''admin'' WHERE user_id = %L AND account_id = %L', u_u, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('guard: U changed its account_role: ' || r)::text);
  END IF;
  r := pg_temp.ws_try('authenticated', u_u, format(
    'UPDATE profiles SET account_id = %L WHERE user_id = %L AND account_id = %L', d_acct, u_u, b_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('guard: U moved a row to another account: ' || r)::text);
  END IF;
  r := pg_temp.ws_try('authenticated', u_u, format(
    'UPDATE profiles SET bank_code = ''FAB'' WHERE user_id = %L AND account_id = %L', u_u, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('guard: U set a bank_code: ' || r)::text);
  END IF;
  -- A guest changing banks satisfies the CHECK, so only the guard refuses.
  r := pg_temp.ws_try('authenticated', u_g, format(
    'UPDATE profiles SET bank_code = ''FAB'' WHERE user_id = %L AND account_id = %L', u_g, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' OR (SELECT bank_code FROM profiles WHERE user_id = u_g AND account_id = a_acct) <> 'ADCB' THEN
    failed := array_append(failed, ('guard: guest changed its bank_code: ' || r)::text);
  END IF;
  r := pg_temp.ws_try('authenticated', u_u, format(
    'UPDATE profiles SET full_name = ''WS Renamed'' WHERE user_id = %L AND account_id = %L', u_u, a_acct));
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('guard: U could not rename itself: ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM profiles WHERE user_id = u_u AND full_name = 'WS Renamed') <> 3 THEN
    failed := array_append(failed, 'guard: a new name did not reach every row of the person'::text);
  END IF;

  -- ---------- 8. presence: one row per non-deactivated membership ----------
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_u AND account_id = c_acct;
  r := pg_temp.ws_try('authenticated', u_u, 'SELECT public.touch_presence(''online'')');
  n := n + 1;
  IF r <> 'ok'
     OR (SELECT array_agg(account_id ORDER BY account_id) FROM member_presence WHERE user_id = u_u)
        IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[a_acct, b_acct]) AS x) THEN
    failed := array_append(failed, ('presence: touch_presence did not write exactly A and B: ' || r)::text);
  END IF;

  -- ---------- 10. storage: a guest lists nothing of A's folder ----------
  r := pg_temp.ws_val(u_g, 'SELECT count(*) FROM storage.objects WHERE bucket_id = ''chat-media''');
  n := n + 1;
  IF r <> '0' THEN
    failed := array_append(failed, ('isolation: guest lists A''s chat media: ' || r)::text);
  END IF;
  r := pg_temp.ws_val(u_x, 'SELECT count(*) FROM storage.objects WHERE bucket_id = ''chat-media''');
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('storage: an agent of A does not list A''s chat media: ' || r)::text);
  END IF;

  -- ---------- 4. switch_account refusals, and leaving a deactivated row ----------
  r := pg_temp.ws_try('authenticated', u_u, format('SELECT public.switch_account(%L)', d_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('switch_account into an account without a row: ' || r)::text);
  END IF;
  r := pg_temp.ws_try('authenticated', u_u, format('SELECT public.switch_account(%L)', c_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('switch_account into a deactivated row: ' || r)::text);
  END IF;
  r := pg_temp.ws_try('authenticated', u_ad, format('SELECT public.set_member_active(%L, false)', u_u));
  n := n + 1;
  IF r <> 'ok' OR (SELECT deactivated_at FROM profiles WHERE user_id = u_u AND account_id = a_acct) IS NULL THEN
    failed := array_append(failed, ('set_member_active by A''s admin on U''s active row: ' || r)::text);
  END IF;
  r := pg_temp.ws_try('authenticated', u_u, format('SELECT public.switch_account(%L)', b_acct));
  n := n + 1;
  IF r <> 'ok' OR (SELECT account_id FROM profiles WHERE user_id = u_u AND is_active) IS DISTINCT FROM b_acct THEN
    failed := array_append(failed, ('switch_account out of a deactivated active row: ' || r)::text);
  END IF;

  -- ---------- 11. grants ----------
  n := n + 1;
  IF has_function_privilege('anon', 'public.switch_account(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.my_workspaces()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.switch_account(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.my_workspaces()', 'EXECUTE') THEN
    failed := array_append(failed, 'grants: anon may call switch_account/my_workspaces, or authenticated may not'::text);
  END IF;

  -- ---------- 12. member RPCs: one membership at a time ----------
  -- Every created_at in this block is equal, so a "which row becomes
  -- active" check gives its person exactly one other row.
  DECLARE
    u_m    UUID := '00000000-0000-4000-8000-000000083007';  -- agent in A (active) and B
    u_n    UUID := '00000000-0000-4000-8000-000000083008';  -- agent in A and B (active)
    u_s    UUID := '00000000-0000-4000-8000-000000083009';  -- agent in A only
    u_r    UUID := '00000000-0000-4000-8000-000000083010';  -- agent in B, redeems A's invitations
    u_p    UUID := '00000000-0000-4000-8000-000000083011';  -- new login, provisioned into A
    u_q    UUID := '00000000-0000-4000-8000-000000083012';  -- agent in B (active) and C
    u_gn   UUID := '00000000-0000-4000-8000-000000083013';  -- new login, provisioned into A as a guest
    u_gx   UUID := '00000000-0000-4000-8000-000000083014';  -- new login, refused provisions
    u_w    UUID := '00000000-0000-4000-8000-000000083015';  -- added to A as a guest by email
    u_gr   UUID := '00000000-0000-4000-8000-000000083016';  -- bank guest in A only, removed
    ws_new UUID;   -- the workspace A's admin creates
    r_none TEXT;   -- what add_workspace_member raises for an unknown email
    team_b UUID;
    tmb    TEXT;
    pid    UUID;
    acct_n BIGINT;
    old_p  UUID;
    sigs   TEXT;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES
      (u_m, 'ws-m@example.invalid'), (u_n, 'ws-n@example.invalid'), (u_s, 'ws-s@example.invalid'),
      (u_r, 'ws-r@example.invalid'), (u_p, 'ws-p@example.invalid'), (u_q, 'ws-q@example.invalid'),
      (u_gn, 'ws-gn@example.invalid'), (u_gx, 'ws-gx@example.invalid'), (u_w, 'ws-w@example.invalid'),
      (u_gr, 'ws-gr@example.invalid');
    UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_m, u_n, u_s);
    UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB'
     WHERE user_id = u_gr;
    UPDATE profiles SET account_id = b_acct, account_role = 'agent' WHERE user_id IN (u_r, u_q);
    UPDATE profiles SET is_active = false WHERE user_id = u_n;
    INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active) VALUES
      (u_m, '', 'ws-m@example.invalid', b_acct, 'agent', false),
      (u_n, '', 'ws-n@example.invalid', b_acct, 'agent', true),
      (u_q, '', 'ws-q@example.invalid', c_acct, 'agent', false);
    INSERT INTO team_members (team_id, user_id, account_id) VALUES (team, u_m, a_acct);
    INSERT INTO teams (account_id, name) VALUES (b_acct, 'WS team B') RETURNING id INTO team_b;
    INSERT INTO team_members (team_id, user_id, account_id) VALUES (team_b, u_m, b_acct);
    SELECT ctid::text INTO tmb FROM team_members WHERE team_id = team_b AND user_id = u_m;

    -- set_member_role / set_member_active by A's admin: the A row only.
    r := pg_temp.ws_try('authenticated', u_ad, format('SELECT public.set_member_role(%L, ''viewer'')', u_m));
    n := n + 1;
    IF r <> 'ok' OR (SELECT string_agg(account_role::text, ',' ORDER BY account_id = a_acct DESC)
                       FROM profiles WHERE user_id = u_m) IS DISTINCT FROM 'viewer,agent' THEN
      failed := array_append(failed, ('set_member_role: not exactly the A row changed: ' || r)::text);
    END IF;
    r := pg_temp.ws_try('authenticated', u_ad, format('SELECT public.set_member_role(%L, ''bank_guest'')', u_m))
      || ' | ' || pg_temp.ws_try('authenticated', u_ad, format('SELECT public.set_member_role(%L, ''agent'')', u_g));
    n := n + 1;
    IF r NOT LIKE 'ERROR 22023:% | ERROR 22023:%' THEN
      failed := array_append(failed, ('set_member_role: staff<->guest not refused: ' || r)::text);
    END IF;
    r := pg_temp.ws_try('authenticated', u_ad, format('SELECT public.set_member_role(%L, ''agent'')', u_ob))
      || ' | ' || pg_temp.ws_try('authenticated', u_ad, 'SELECT public.set_member_role(''00000000-0000-4000-8000-0000000830ff'', ''agent'')');
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501:% | ERROR 22023:%' THEN
      failed := array_append(failed, ('set_member_role: not-a-member refusals (want 42501 | 22023): ' || r)::text);
    END IF;
    r := pg_temp.ws_try('authenticated', u_ad, format('SELECT public.set_member_active(%L, false)', u_m));
    n := n + 1;
    IF r <> 'ok' OR (SELECT string_agg((deactivated_at IS NOT NULL) || '/' || is_active, ',' ORDER BY account_id = a_acct DESC)
                       FROM profiles WHERE user_id = u_m) IS DISTINCT FROM 'true/true,false/false' THEN
      failed := array_append(failed, ('set_member_active: not exactly the A row deactivated, or the mark moved: ' || r)::text);
    END IF;
    r := pg_temp.ws_try('authenticated', u_ad, format('SELECT public.set_member_active(%L, true)', u_m));
    n := n + 1;
    IF r <> 'ok' OR EXISTS (SELECT 1 FROM profiles WHERE user_id = u_m AND deactivated_at IS NOT NULL) THEN
      failed := array_append(failed, ('set_member_active: reactivating the A row: ' || r)::text);
    END IF;

    -- remove_account_member.
    r := pg_temp.ws_val(u_ad, format('SELECT public.remove_account_member(%L)::text', u_m));
    n := n + 1;
    IF r <> 'null'
       OR EXISTS (SELECT 1 FROM profiles WHERE user_id = u_m AND account_id = a_acct)
       OR (SELECT is_active FROM profiles WHERE user_id = u_m AND account_id = b_acct) IS NOT TRUE
       OR EXISTS (SELECT 1 FROM team_members WHERE user_id = u_m AND account_id = a_acct)
       OR (SELECT ctid::text FROM team_members WHERE team_id = team_b AND user_id = u_m) IS DISTINCT FROM tmb THEN
      failed := array_append(failed, ('remove (active in A): A row/teams not gone, or B row/team not kept active: ' || r)::text);
    END IF;
    r := pg_temp.ws_val(u_ad, format('SELECT public.remove_account_member(%L)::text', u_n));
    n := n + 1;
    IF r <> 'null' OR (SELECT string_agg(account_id || '/' || is_active, ',') FROM profiles WHERE user_id = u_n)
                        IS DISTINCT FROM b_acct || '/true' THEN
      failed := array_append(failed, ('remove (active in B): ' || r)::text);
    END IF;
    -- Their only row moves to a fresh account, never as its owner or an
    -- admin (an owner may add_workspace_member and create_workspace): a
    -- guest stays a guest, anyone else becomes a viewer, and a
    -- deactivation is cleared (nobody there could ever lift it). S is
    -- deactivated first.
    PERFORM pg_temp.ws_try('authenticated', u_ad, format('SELECT public.set_member_active(%L, false)', u_s));
    SELECT id INTO pid FROM profiles WHERE user_id = u_s AND deactivated_at IS NOT NULL;
    r := pg_temp.ws_val(u_ad, format('SELECT public.remove_account_member(%L)::text', u_s));
    n := n + 1;
    IF pid IS NULL
       OR (SELECT string_agg(id || '/' || account_id || '/' || account_role || '/' || is_active, ',')
             FROM profiles WHERE user_id = u_s) IS DISTINCT FROM pid || '/' || r || '/viewer/true'
       OR NOT EXISTS (SELECT 1 FROM accounts WHERE id::text = r AND owner_user_id = u_s) THEN
      failed := array_append(failed, ('remove (only row, agent): not one viewer row, same profile, in a fresh account: ' || r)::text);
    END IF;
    n := n + 1;
    IF EXISTS (SELECT 1 FROM profiles WHERE user_id = u_s
                AND (deactivated_at IS NOT NULL OR deactivated_by IS NOT NULL)) THEN
      failed := array_append(failed, 'remove (only row, deactivated): the deactivation followed them'::text);
    END IF;
    SELECT id INTO pid FROM profiles WHERE user_id = u_gr;
    r := pg_temp.ws_val(u_ad, format('SELECT public.remove_account_member(%L)::text', u_gr));
    n := n + 1;
    IF (SELECT string_agg(id || '/' || account_id || '/' || account_role || '/' || bank_code || '/' || is_active, ',')
          FROM profiles WHERE user_id = u_gr) IS DISTINCT FROM pid || '/' || r || '/bank_guest/ADCB/true'
       OR pg_temp.ws_val(u_gr, 'SELECT public.current_account_id()::text') <> 'null' THEN
      failed := array_append(failed, ('remove (only row, guest): not one guest row that sees nothing: ' || r)::text);
    END IF;
    n := n + 1;
    IF EXISTS (SELECT 1 FROM profiles WHERE user_id IN (u_s, u_gr) AND account_role IN ('owner', 'admin')) THEN
      failed := array_append(failed, 'remove (only row): a removed guest or agent is an owner or admin somewhere'::text);
    END IF;
    FOR i IN 1..2 LOOP
      DECLARE
        who UUID := CASE i WHEN 1 THEN u_gr ELSE u_s END;
      BEGIN
        r := pg_temp.ws_try('authenticated', who, 'SELECT public.add_workspace_member(''ws-a-only@example.invalid'', ''viewer'')')
          || ' | ' || pg_temp.ws_try('authenticated', who, 'SELECT public.create_workspace(''WS Mine'', ''WSM'')');
        n := n + 1;
        IF r NOT LIKE 'ERROR 42501:% | ERROR 42501:%' THEN
          failed := array_append(failed, ('remove (only row, ' || CASE i WHEN 1 THEN 'guest' ELSE 'agent' END
            || '): may add_workspace_member / create_workspace (want 42501 | 42501): ' || r)::text);
        END IF;
      END;
    END LOOP;

    -- redeem_invitation by a member of B. The links are A's admin's:
    -- since 099 a link with no creator who may grant it is refused.
    INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at) VALUES
      (a_acct, 'ws-083-invite-1', 'agent', u_ad, now() + interval '1 day'),
      (a_acct, 'ws-083-invite-2', 'agent', u_ad, now() + interval '1 day');
    SELECT count(*) INTO acct_n FROM accounts;
    r := pg_temp.ws_val(u_r, 'SELECT public.redeem_invitation(''ws-083-invite-1'')::text');
    n := n + 1;
    IF r IS DISTINCT FROM a_acct::text
       OR (SELECT string_agg(account_id || '/' || is_active, ',' ORDER BY is_active DESC) FROM profiles WHERE user_id = u_r)
          IS DISTINCT FROM a_acct || '/true,' || b_acct || '/false'
       OR (SELECT count(*) FROM accounts) <> acct_n THEN
      failed := array_append(failed, ('redeem (already in B): ' || r)::text);
    END IF;
    r := pg_temp.ws_try('authenticated', u_r, 'SELECT public.redeem_invitation(''ws-083-invite-2'')');
    n := n + 1;
    IF r NOT LIKE 'ERROR 23505:%' THEN
      failed := array_append(failed, ('redeem into an account already joined: ' || r)::text);
    END IF;

    -- provision_account_member (service role), named arguments as the API calls it.
    SELECT account_id INTO old_p FROM profiles WHERE user_id = u_p;
    r := pg_temp.ws_try('service_role', NULL, format(
      'SELECT public.provision_account_member(p_user_id => %L, p_account_id => %L, p_role => ''agent'')', u_p, a_acct));
    n := n + 1;
    IF r <> 'ok' OR (SELECT string_agg(account_id || '/' || account_role || '/' || is_active, ',') FROM profiles WHERE user_id = u_p)
                      IS DISTINCT FROM a_acct || '/agent/true'
       OR EXISTS (SELECT 1 FROM accounts WHERE id = old_p) THEN
      failed := array_append(failed, ('provision (new login): ' || r)::text);
    END IF;
    SELECT count(*) INTO acct_n FROM accounts;
    r := pg_temp.ws_try('service_role', NULL, format(
      'SELECT public.provision_account_member(p_user_id => %L, p_account_id => %L, p_role => ''agent'')', u_q, d_acct));
    n := n + 1;
    IF r <> 'ok' OR (SELECT string_agg(account_id || '/' || is_active, ',' ORDER BY account_id = b_acct DESC, account_id = c_acct DESC)
                       FROM profiles WHERE user_id = u_q)
                      IS DISTINCT FROM b_acct || '/true,' || c_acct || '/false,' || d_acct || '/false'
       OR (SELECT count(*) FROM accounts) <> acct_n THEN
      failed := array_append(failed, ('provision (multi-row person): ' || r)::text);
    END IF;
    SELECT account_id INTO old_p FROM profiles WHERE user_id = u_gn;
    r := pg_temp.ws_try('service_role', NULL, format(
      'SELECT public.provision_account_member(p_user_id => %L, p_account_id => %L, p_role => ''bank_guest'', p_bank_code => ''FAB'')',
      u_gn, a_acct));
    n := n + 1;
    IF r <> 'ok' OR (SELECT string_agg(account_id || '/' || account_role || '/' || bank_code || '/' || is_active, ',')
                       FROM profiles WHERE user_id = u_gn) IS DISTINCT FROM a_acct || '/bank_guest/FAB/true'
       OR EXISTS (SELECT 1 FROM accounts WHERE id = old_p) THEN
      failed := array_append(failed, ('provision (new guest login): ' || r)::text);
    END IF;
    r := pg_temp.ws_val(u_gn, 'SELECT public.current_account_id()::text');
    n := n + 1;
    IF r <> 'null' THEN
      failed := array_append(failed, ('provision (new guest login): current_account_id() = ' || r)::text);
    END IF;
    r := pg_temp.ws_try('service_role', NULL, format('SELECT public.provision_account_member(%L, %L, ''bank_guest'', ''  '')', u_gx, a_acct))
      || ' | ' || pg_temp.ws_try('service_role', NULL, format('SELECT public.provision_account_member(%L, %L, ''agent'', ''FAB'')', u_gx, a_acct))
      || ' | ' || pg_temp.ws_try('service_role', NULL, format('SELECT public.provision_account_member(%L, %L, ''bank_guest'', ''FAB'')', u_q, a_acct));
    n := n + 1;
    IF r NOT LIKE 'ERROR 22023:% | ERROR 22023:% | ERROR 22023:%' OR r LIKE '%ERROR 2350%'
       OR EXISTS (SELECT 1 FROM profiles WHERE user_id IN (u_gx, u_q) AND account_id = a_acct) THEN
      failed := array_append(failed, ('provision: blank code / code on staff / guest for an existing login not refused: ' || r)::text);
    END IF;

    -- create_workspace.
    r := pg_temp.ws_val(u_ad, 'SELECT public.create_workspace(''WS New'', ''WSN'')::text');
    n := n + 1;
    IF (SELECT string_agg(account_role || '/' || is_active, ',') FROM profiles WHERE user_id = u_ad AND account_id::text = r)
         IS DISTINCT FROM 'owner/false'
       OR NOT EXISTS (SELECT 1 FROM accounts WHERE id::text = r AND owner_user_id = u_ad)
       OR (SELECT account_id FROM profiles WHERE user_id = u_ad AND is_active) IS DISTINCT FROM a_acct THEN
      failed := array_append(failed, ('create_workspace by an admin: ' || r)::text);
    END IF;
    ws_new := r::uuid;
    r := pg_temp.ws_try('authenticated', u_x, 'SELECT public.create_workspace(''WS X'', ''WSX'')')
      || ' | ' || pg_temp.ws_try('authenticated', u_ad, 'SELECT public.create_workspace(''WS Bad'', ''WSBAD'')');
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501:% | ERROR 22023:%' THEN
      failed := array_append(failed, ('create_workspace: agent caller / bad short name (want 42501 | 22023): ' || r)::text);
    END IF;

    -- add_workspace_member by A's admin.
    FOR i IN 1..5 LOOP
      DECLARE
        args TEXT := CASE i WHEN 1 THEN '''ws-nobody@example.invalid'', ''agent'''
                            WHEN 2 THEN '''WS-A-ONLY@example.invalid'', ''agent'''
                            WHEN 3 THEN '''ws-w@example.invalid'', ''owner'''
                            WHEN 4 THEN '''ws-w@example.invalid'', ''bank_guest'''
                            ELSE '''ws-w@example.invalid'', ''agent'', ''ADIB''' END;
        want TEXT := CASE i WHEN 1 THEN 'P0002' WHEN 2 THEN '23505' ELSE '22023' END;
      BEGIN
        r := pg_temp.ws_try('authenticated', u_ad, 'SELECT public.add_workspace_member(' || args || ')');
        n := n + 1;
        IF r NOT LIKE 'ERROR ' || want || ':%' THEN
          failed := array_append(failed, ('add_workspace_member(' || args || '): want ' || want || ', got ' || r)::text);
        END IF;
      END;
    END LOOP;
    -- Only someone the caller administers elsewhere may be added. W (its
    -- own account only), M (live in B only) and, from WS New, U (live in B;
    -- its row in A is deactivated) raise exactly what an unknown email
    -- raises, so the RPC is no oracle for "has a login".
    r_none := pg_temp.ws_try('authenticated', u_ad, 'SELECT public.add_workspace_member(''ws-nobody@example.invalid'', ''agent'')');
    r := pg_temp.ws_try('authenticated', u_ad, 'SELECT public.add_workspace_member(''ws-w@example.invalid'', ''agent'')')
      || ' | ' || pg_temp.ws_try('authenticated', u_ad, 'SELECT public.add_workspace_member(''ws-m@example.invalid'', ''agent'')');
    n := n + 1;
    IF r_none NOT LIKE 'ERROR P0002:%' OR r <> r_none || ' | ' || r_none
       OR EXISTS (SELECT 1 FROM profiles WHERE user_id IN (u_w, u_m) AND account_id = a_acct) THEN
      failed := array_append(failed, ('add_workspace_member of a stranger: want "' || r_none || '" twice, got ' || r)::text);
    END IF;
    PERFORM pg_temp.ws_try('authenticated', u_ad, format('SELECT public.switch_account(%L)', ws_new));
    r := pg_temp.ws_try('authenticated', u_ad, 'SELECT public.add_workspace_member(''ws-multi@example.invalid'', ''agent'')');
    n := n + 1;
    IF r IS DISTINCT FROM r_none OR EXISTS (SELECT 1 FROM profiles WHERE user_id = u_u AND account_id = ws_new) THEN
      failed := array_append(failed, ('add_workspace_member of a person deactivated where the caller is admin: ' || r)::text);
    END IF;
    -- The cross-workspace add: from WS New, X (live agent in A, where the
    -- caller is admin; the caller's A row is not the active one).
    r := pg_temp.ws_val(u_ad, 'SELECT public.add_workspace_member(''ws-a-only@example.invalid'', ''agent'')::text');
    n := n + 1;
    IF r IS DISTINCT FROM u_x::text
       OR (SELECT account_role || '/' || is_active FROM profiles WHERE user_id = u_x AND account_id = ws_new)
          IS DISTINCT FROM 'agent/false' THEN
      failed := array_append(failed, ('add_workspace_member from another workspace the caller administers: ' || r)::text);
    END IF;
    PERFORM pg_temp.ws_try('authenticated', u_ad, format('SELECT public.switch_account(%L)', a_acct));
    -- W works in WS New (A's admin owns it): now W may be added to A.
    INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active)
    VALUES (u_w, '', 'ws-w@example.invalid', ws_new, 'agent', false);
    r := pg_temp.ws_val(u_ad, 'SELECT public.add_workspace_member(''ws-w@example.invalid'', ''bank_guest'', ''ADIB'')::text');
    n := n + 1;
    IF r IS DISTINCT FROM u_w::text
       OR (SELECT string_agg(account_role || '/' || bank_code || '/' || is_active, ',') FROM profiles
            WHERE user_id = u_w AND account_id = a_acct) IS DISTINCT FROM 'bank_guest/ADIB/false'
       OR (SELECT count(*) FROM profiles WHERE user_id = u_w AND is_active) <> 1 THEN
      failed := array_append(failed, ('add_workspace_member: guest with a code: ' || r)::text);
    END IF;
    r := pg_temp.ws_try('authenticated', u_x, 'SELECT public.add_workspace_member(''ws-q@example.invalid'', ''agent'')');
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501:%' THEN
      failed := array_append(failed, ('add_workspace_member by an agent: ' || r)::text);
    END IF;

    -- transfer_account_ownership by A's owner.
    r := pg_temp.ws_try('authenticated', u_oa, format('SELECT public.transfer_account_ownership(%L)', u_g));
    n := n + 1;
    IF r NOT LIKE 'ERROR 22023:%' OR (SELECT owner_user_id FROM accounts WHERE id = a_acct) IS DISTINCT FROM u_oa THEN
      failed := array_append(failed, ('transfer to a bank guest: ' || r)::text);
    END IF;
    r := pg_temp.ws_try('authenticated', u_oa, format('SELECT public.transfer_account_ownership(%L)', u_r));
    n := n + 1;
    IF r <> 'ok' OR (SELECT owner_user_id FROM accounts WHERE id = a_acct) IS DISTINCT FROM u_r
       OR (SELECT account_role::text FROM profiles WHERE user_id = u_oa AND account_id = a_acct) IS DISTINCT FROM 'admin'
       OR (SELECT string_agg(account_role::text, ',' ORDER BY account_id = a_acct DESC) FROM profiles WHERE user_id = u_r)
          IS DISTINCT FROM 'owner,agent' THEN
      failed := array_append(failed, ('transfer to a staff member: ' || r)::text);
    END IF;

    -- grants: nothing here is anon's; provision is the service role's alone.
    SELECT string_agg(s, ', ') INTO sigs FROM unnest(ARRAY[
      'public.create_workspace(text,text)', 'public.add_workspace_member(text,account_role_enum,text)',
      'public.provision_account_member(uuid,uuid,account_role_enum,text)', 'public.raise_not_a_member(uuid)',
      'public.disposable_personal_account(uuid)', 'public.set_member_role(uuid,account_role_enum)',
      'public.set_member_active(uuid,boolean)', 'public.transfer_account_ownership(uuid)',
      'public.remove_account_member(uuid)', 'public.redeem_invitation(text)']) AS s
     WHERE to_regprocedure(s) IS NULL OR has_function_privilege('anon', to_regprocedure(s), 'EXECUTE');
    n := n + 1;
    IF sigs IS NOT NULL THEN
      failed := array_append(failed, ('grants: missing or executable by anon: ' || sigs)::text);
    END IF;
    n := n + 1;
    IF to_regprocedure('public.provision_account_member(uuid,uuid,account_role_enum)') IS NOT NULL
       OR has_function_privilege('authenticated', to_regprocedure('public.provision_account_member(uuid,uuid,account_role_enum,text)'), 'EXECUTE') IS NOT FALSE
       OR has_function_privilege('service_role', to_regprocedure('public.provision_account_member(uuid,uuid,account_role_enum,text)'), 'EXECUTE') IS NOT TRUE THEN
      failed := array_append(failed, 'grants: a 3-argument provision_account_member remains, or the 4-argument one is not service-role only'::text);
    END IF;
  END;

  -- ---------- 13. deactivated in B, live in A: nothing of B through A ----------
  -- Deactivation bans the login only when the person has no other live
  -- workspace, so D (admin in B, deactivated there; agent in A, active)
  -- still has a session. B's bell rows, B's team-activity alerts and B's
  -- guardrail policies are B's, not D's.
  DECLARE
    u_d   UUID := '00000000-0000-4000-8000-000000083017';  -- agent in A (active), admin in B (deactivated)
    u_b2  UUID := '00000000-0000-4000-8000-000000083018';  -- live admin of B
    u_gb  UUID := '00000000-0000-4000-8000-000000083019';  -- bank guest in B
    u_lb  UUID := '00000000-0000-4000-8000-000000083020';  -- team leader in B (deactivated)
    u_sb  UUID := '00000000-0000-4000-8000-000000083021';  -- agent in B, over the daily limit
    w_b   UUID;
    tb    UUID;
    pol_b UUID;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES
      (u_d, 'ws-d@example.invalid'), (u_b2, 'ws-b2@example.invalid'), (u_gb, 'ws-gb@example.invalid'),
      (u_lb, 'ws-lb@example.invalid'), (u_sb, 'ws-sb@example.invalid');
    UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_d;
    UPDATE profiles SET account_id = b_acct, account_role = 'admin' WHERE user_id = u_b2;
    UPDATE profiles SET account_id = b_acct, account_role = 'team_leader' WHERE user_id = u_lb;
    UPDATE profiles SET account_id = b_acct, account_role = 'agent' WHERE user_id = u_sb;
    UPDATE profiles SET account_id = b_acct, account_role = 'bank_guest', bank_code = 'FAB' WHERE user_id = u_gb;
    INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active)
    VALUES (u_d, '', 'ws-d@example.invalid', b_acct, 'admin', false);
    INSERT INTO teams (account_id, name, leader_user_id) VALUES (b_acct, 'WS team BL', u_lb) RETURNING id INTO tb;
    INSERT INTO team_members (team_id, user_id, account_id) VALUES (tb, u_sb, b_acct);
    UPDATE profiles SET deactivated_at = now() WHERE user_id IN (u_d, u_lb) AND account_id = b_acct;

    INSERT INTO notifications (account_id, user_id, type, title, body) VALUES
      (b_acct, u_d, 'conversation_assigned', 'WS B note', 'x'),
      (a_acct, u_d, 'conversation_assigned', 'WS A note', 'x'),
      (b_acct, u_gb, 'conversation_assigned', 'WS guest note', 'x');
    r := pg_temp.ws_val(u_d, 'SELECT coalesce(string_agg(title, '','' ORDER BY title), '''') FROM notifications');
    n := n + 1;
    IF r <> 'WS A note' THEN
      failed := array_append(failed, ('deactivated in B: D reads notifications "' || r || '", want only A''s')::text);
    END IF;
    r := pg_temp.ws_val(u_d, format(
      'WITH x AS (UPDATE notifications SET read_at = now() WHERE account_id = %L RETURNING 1) SELECT count(*) FROM x', b_acct));
    n := n + 1;
    IF r <> '0' THEN
      failed := array_append(failed, ('deactivated in B: D marked B''s notifications read: ' || r)::text);
    END IF;
    r := pg_temp.ws_val(u_gb, 'SELECT coalesce(string_agg(title, '',''), '''') FROM notifications');
    n := n + 1;
    IF r <> 'WS guest note' THEN
      failed := array_append(failed, ('a bank guest does not read its own notification: ' || r)::text);
    END IF;

    -- The sweep: SB starts a chat on B's Whapi number, over a limit of 1.
    INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, label, status, is_primary)
    VALUES (u_ob, b_acct, 'whapi', 'WS-083-B1', 'x', '971500083099', 'WS B number', 'connected', true)
    RETURNING id INTO w_b;
    INSERT INTO team_activity_settings (account_id, timezone, daily_new_chats_per_user, daily_new_chats_per_number)
    VALUES (b_acct, 'UTC', 1, 50);
    INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (b_acct, u_ob, '971500083021', 'WS B swept') RETURNING id INTO ct;
    INSERT INTO conversations (account_id, contact_id, user_id) VALUES (b_acct, ct, u_ob) RETURNING id INTO cv_b;
    INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, created_at, channel_id, provider, status)
    VALUES (cv_b, 'agent', u_sb, 'WS hello', now() - interval '1 minute', w_b, 'whapi', 'sent');
    PERFORM public.team_activity_alert_sweep();
    n := n + 1;
    IF (SELECT array_agg(user_id ORDER BY user_id) FROM notifications
         WHERE account_id = b_acct AND type = 'team_activity_alert' AND user_id IN (u_ob, u_sb))
       IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[u_ob, u_sb]) AS x) THEN
      failed := array_append(failed, 'sweep fixture: B''s owner and the agent over the limit were not alerted'::text);
    END IF;
    n := n + 1;
    IF EXISTS (SELECT 1 FROM notifications WHERE account_id = b_acct AND type = 'team_activity_alert'
                AND user_id IN (u_d, u_lb, u_gb)) THEN
      failed := array_append(failed, 'sweep: a deactivated admin or leader of B, or B''s bank guest, got a B alert'::text);
    END IF;

    -- Guardrail policies: proposed by B's owner; D may neither approve nor retire.
    INSERT INTO ts_policy (account_id, check_name, version, model_id, question_set_version, thresholds, shadow, proposed_by)
    VALUES (b_acct, 'triage', 1, 'jev-1.13.0', 'qs-013-v0.2', '{"intentConfidenceMin":0.5,"possibleComplaintMin":0.25,"wantsHumanMin":0.7,"complaintConfidenceMin":0.5,"instructsAssistantMin":0.7,"nonPartnerBankMin":0.7,"dissatisfiedMin":0.7,"leadTemperatureMin":2,"leadTemperatureConfMin":0.5,"urgencyHighMin":1,"urgencyUrgentMin":1.6,"optOutRecordMin":0.8,"optOutReviewMin":0.4}'::jsonb, false, u_ob)
    RETURNING id INTO pol_b;
    r := pg_temp.ws_try('authenticated', u_d, format('SELECT public.ts_approve_policy(%L)', pol_b));
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501:%' OR (SELECT status FROM ts_policy WHERE id = pol_b) <> 'proposed' THEN
      failed := array_append(failed, ('ts_approve_policy by an admin deactivated in B: ' || r)::text);
    END IF;
    r := pg_temp.ws_try('authenticated', u_b2, format('SELECT public.ts_approve_policy(%L)', pol_b));
    n := n + 1;
    IF r <> 'ok' OR (SELECT status || '/' || approved_by FROM ts_policy WHERE id = pol_b) IS DISTINCT FROM 'active/' || u_b2 THEN
      failed := array_append(failed, ('ts_approve_policy by a live admin of B: ' || r)::text);
    END IF;
    r := pg_temp.ws_try('authenticated', u_d, format('SELECT public.ts_retire_policy(%L)', pol_b));
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501:%' OR (SELECT status FROM ts_policy WHERE id = pol_b) <> 'active' THEN
      failed := array_append(failed, ('ts_retire_policy by an admin deactivated in B: ' || r)::text);
    END IF;
  END;

  -- ---------- 14. a team leader adds agents and viewers (099) ----------
  -- L leads in A (active) and owns a workspace of their own, P, where T1
  -- and T2 work: people L administers elsewhere, so add_workspace_member
  -- may bring them in. LB leads in B; AG is an agent in A.
  DECLARE
    u_l   UUID := '00000000-0000-4000-8000-000000099001';  -- team leader in A (active), owner of P
    u_t1  UUID := '00000000-0000-4000-8000-000000099002';  -- agent in P only
    u_t2  UUID := '00000000-0000-4000-8000-000000099003';  -- agent in P only
    u_lb  UUID := '00000000-0000-4000-8000-000000099004';  -- team leader in B (active)
    u_ag  UUID := '00000000-0000-4000-8000-000000099005';  -- agent in A (active)
    u_r1  UUID := '00000000-0000-4000-8000-000000099006';  -- new login, redeems links to A
    u_r2  UUID := '00000000-0000-4000-8000-000000099007';  -- new login, redeems links to A
    u_r3  UUID := '00000000-0000-4000-8000-000000099008';  -- new login, refused every link
    p_l   UUID;
    ins   TEXT := 'INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at) VALUES ';
  BEGIN
    INSERT INTO auth.users (id, email) VALUES
      (u_l, 'ldinv-l@example.invalid'), (u_t1, 'ldinv-t1@example.invalid'),
      (u_t2, 'ldinv-t2@example.invalid'), (u_lb, 'ldinv-lb@example.invalid'),
      (u_ag, 'ldinv-ag@example.invalid');
    SELECT account_id INTO p_l FROM profiles WHERE user_id = u_l;
    UPDATE profiles SET is_active = false WHERE user_id = u_l;
    INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active)
    VALUES (u_l, '', 'ldinv-l@example.invalid', a_acct, 'team_leader', true);
    UPDATE profiles SET account_id = p_l, account_role = 'agent' WHERE user_id IN (u_t1, u_t2);
    UPDATE profiles SET account_id = b_acct, account_role = 'team_leader' WHERE user_id = u_lb;
    UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_ag;

    -- Any other role is 42501, decided before the email is looked up: an
    -- unknown address asked for as admin must not answer P0002, on which
    -- the members API would create the login with the service role.
    FOR i IN 1..5 LOOP
      DECLARE
        args TEXT := CASE i WHEN 1 THEN '''ldinv-t1@example.invalid'', ''admin'''
                            WHEN 2 THEN '''ldinv-t1@example.invalid'', ''team_leader'''
                            WHEN 3 THEN '''ldinv-t1@example.invalid'', ''bank_guest'', ''ADIB'''
                            WHEN 4 THEN '''ldinv-t1@example.invalid'', ''owner'''
                            ELSE '''ldinv-nobody@example.invalid'', ''admin''' END;
      BEGIN
        r := pg_temp.ws_try('authenticated', u_l, 'SELECT public.add_workspace_member(' || args || ')');
        n := n + 1;
        IF r NOT LIKE 'ERROR 42501:%' OR EXISTS (SELECT 1 FROM profiles WHERE user_id = u_t1 AND account_id = a_acct) THEN
          failed := array_append(failed, ('leader add_workspace_member(' || args || '): want 42501, got ' || r)::text);
        END IF;
      END;
    END LOOP;
    r := pg_temp.ws_val(u_l, 'SELECT public.add_workspace_member(''ldinv-t1@example.invalid'', ''agent'')::text');
    n := n + 1;
    IF r IS DISTINCT FROM u_t1::text
       OR (SELECT account_role || '/' || is_active FROM profiles WHERE user_id = u_t1 AND account_id = a_acct)
          IS DISTINCT FROM 'agent/false' THEN
      failed := array_append(failed, ('leader adds an agent: ' || r)::text);
    END IF;
    r := pg_temp.ws_val(u_l, 'SELECT public.add_workspace_member(''ldinv-t2@example.invalid'', ''viewer'')::text');
    n := n + 1;
    IF r IS DISTINCT FROM u_t2::text
       OR (SELECT account_role || '/' || is_active FROM profiles WHERE user_id = u_t2 AND account_id = a_acct)
          IS DISTINCT FROM 'viewer/false' THEN
      failed := array_append(failed, ('leader adds a viewer: ' || r)::text);
    END IF;
    -- An unknown address, or a login L does not administer anywhere, as
    -- an agent: one 42501, never the P0002 on which the members API
    -- creates the login with a password the caller chose.
    r := pg_temp.ws_try('authenticated', u_l, 'SELECT public.add_workspace_member(''ldinv-nobody@example.invalid'', ''agent'')');
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501:%'
       OR r IS DISTINCT FROM pg_temp.ws_try('authenticated', u_l, 'SELECT public.add_workspace_member(''ldinv-lb@example.invalid'', ''agent'')') THEN
      failed := array_append(failed, ('leader adds an unknown address / a login they do not administer (want one 42501, never P0002): ' || r)::text);
    END IF;
    -- The roster stays the admins': no role change, deactivation or removal.
    r := pg_temp.ws_try('authenticated', u_l, format('SELECT public.set_member_role(%L, ''viewer'')', u_t1))
      || ' | ' || pg_temp.ws_try('authenticated', u_l, format('SELECT public.set_member_active(%L, false)', u_t1))
      || ' | ' || pg_temp.ws_try('authenticated', u_l, format('SELECT public.remove_account_member(%L)', u_t1));
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501:% | ERROR 42501:% | ERROR 42501:%'
       OR (SELECT account_role || '/' || (deactivated_at IS NULL) FROM profiles WHERE user_id = u_t1 AND account_id = a_acct)
          IS DISTINCT FROM 'agent/true' THEN
      failed := array_append(failed, ('leader changes a role / deactivates / removes (want 42501 x3): ' || r)::text);
    END IF;
    r := pg_temp.ws_try('authenticated', u_ag, 'SELECT public.add_workspace_member(''ldinv-t2@example.invalid'', ''viewer'')');
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501:%' THEN
      failed := array_append(failed, ('agent adds a viewer: ' || r)::text);
    END IF;

    -- Invite links: a leader writes agent/viewer links of their active
    -- workspace, in their own name, for at most the API's 365 days.
    r := pg_temp.ws_try('authenticated', u_l, ins || format('(%L, ''ldinv-own'', ''viewer'', %L, now() + interval ''30 days'')', a_acct, u_l));
    n := n + 1;
    IF r <> 'ok' THEN
      failed := array_append(failed, ('leader invites a viewer: ' || r)::text);
    END IF;
    FOR i IN 1..8 LOOP
      DECLARE
        who  UUID := CASE i WHEN 7 THEN u_lb WHEN 8 THEN u_ag ELSE u_l END;
        vals TEXT := CASE i
          WHEN 1 THEN format('(%L, ''ldinv-x'', ''admin'', %L, now() + interval ''1 day'')', a_acct, u_l)
          WHEN 2 THEN format('(%L, ''ldinv-x'', ''team_leader'', %L, now() + interval ''1 day'')', a_acct, u_l)
          WHEN 3 THEN format('(%L, ''ldinv-x'', ''bank_guest'', %L, now() + interval ''1 day'')', a_acct, u_l)
          WHEN 4 THEN format('(%L, ''ldinv-x'', ''agent'', %L, now() + interval ''1 day'')', a_acct, u_ad)
          WHEN 5 THEN format('(%L, ''ldinv-x'', ''agent'', %L, now() + interval ''400 days'')', a_acct, u_l)
          WHEN 6 THEN format('(%L, ''ldinv-x'', ''agent'', %L, now() + interval ''1 day'')', b_acct, u_l)
          WHEN 7 THEN format('(%L, ''ldinv-x'', ''agent'', %L, now() + interval ''1 day'')', a_acct, u_lb)
          ELSE format('(%L, ''ldinv-x'', ''agent'', %L, now() + interval ''1 day'')', a_acct, u_ag) END;
      BEGIN
        r := pg_temp.ws_try('authenticated', who, ins || vals);
        n := n + 1;
        IF r NOT LIKE 'ERROR 42501:%' THEN
          failed := array_append(failed, ('invite link ' || i || ' ' || vals || ': want 42501, got ' || r)::text);
        END IF;
      END;
    END LOOP;
    -- Their own links only: an admin's, and its token_hash (which
    -- redeem_invitation takes), stay out of reach. No UPDATE at all.
    INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at) VALUES
      (a_acct, 'ldinv-admin', 'agent', u_ad, now() + interval '1 day'),
      (a_acct, 'ldinv-own-2', 'agent', u_l, now() + interval '1 day');
    r := pg_temp.ws_val(u_l, 'SELECT string_agg(token_hash, '','' ORDER BY token_hash) FROM account_invitations');
    n := n + 1;
    IF r IS DISTINCT FROM 'ldinv-own,ldinv-own-2' THEN
      failed := array_append(failed, ('leader reads invite links (want only their own): ' || r)::text);
    END IF;
    r := pg_temp.ws_try('authenticated', u_l, 'UPDATE account_invitations SET role = ''admin''')
      || ' | ' || pg_temp.ws_try('authenticated', u_l, 'DELETE FROM account_invitations WHERE token_hash IN (''ldinv-admin'', ''ldinv-own-2'')');
    n := n + 1;
    IF r <> 'ok | ok'
       OR (SELECT string_agg(token_hash || '/' || role, ',' ORDER BY token_hash) FROM account_invitations
            WHERE token_hash LIKE 'ldinv-%') IS DISTINCT FROM 'ldinv-admin/agent,ldinv-own/viewer' THEN
      failed := array_append(failed, ('leader updates / revokes invite links (want only their own revoked): ' || r)::text);
    END IF;
    -- A DELETE with no WHERE: no SELECT policy narrows it, so the DELETE
    -- policy alone must keep it to L's own agent/viewer links of their
    -- active workspace. Not another leader's, not L's admin link (made
    -- while an admin, say), not L's link in a workspace they are not in.
    INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at) VALUES
      (a_acct, 'ldinv-del-own', 'agent', u_l, now() + interval '1 day'),
      (a_acct, 'ldinv-del-lb', 'agent', u_lb, now() + interval '1 day'),
      (a_acct, 'ldinv-del-adm', 'admin', u_l, now() + interval '1 day'),
      (b_acct, 'ldinv-del-b', 'agent', u_l, now() + interval '1 day');
    r := pg_temp.ws_try('authenticated', u_l, 'DELETE FROM account_invitations');
    n := n + 1;
    IF r <> 'ok'
       OR (SELECT string_agg(token_hash, ',' ORDER BY token_hash) FROM account_invitations
            WHERE token_hash LIKE 'ldinv-%') IS DISTINCT FROM 'ldinv-admin,ldinv-del-adm,ldinv-del-b,ldinv-del-lb' THEN
      failed := array_append(failed, ('leader DELETE with no WHERE (want only their own agent/viewer links of A gone): ' || r)::text);
    END IF;

    -- redeem_invitation re-checks the creator. An admin's link and a
    -- leader's agent link work; a leader's admin link, a link whose
    -- creator has no row in A, and a demoted leader's link answer as an
    -- expired link would, and nobody joins.
    INSERT INTO auth.users (id, email) VALUES
      (u_r1, 'ldinv-r1@example.invalid'), (u_r2, 'ldinv-r2@example.invalid'),
      (u_r3, 'ldinv-r3@example.invalid');
    INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at) VALUES
      (a_acct, 'ldinv-rd-l', 'agent', u_l, now() + interval '1 day'),
      (a_acct, 'ldinv-rd-l2', 'viewer', u_l, now() + interval '1 day');
    r := pg_temp.ws_val(u_r1, 'SELECT public.redeem_invitation(''ldinv-admin'')::text')
      || ' | ' || pg_temp.ws_val(u_r2, 'SELECT public.redeem_invitation(''ldinv-rd-l'')::text');
    n := n + 1;
    IF r IS DISTINCT FROM a_acct || ' | ' || a_acct
       OR (SELECT string_agg(account_role::text, ',' ORDER BY user_id) FROM profiles
            WHERE user_id IN (u_r1, u_r2) AND account_id = a_acct) IS DISTINCT FROM 'agent,agent' THEN
      failed := array_append(failed, ('redeem an admin''s link / a leader''s agent link (want both joined): ' || r)::text);
    END IF;
    -- While L still leads: their admin link, and LB's link (no row in A).
    r := pg_temp.ws_try('authenticated', u_r3, 'SELECT public.redeem_invitation(''ldinv-del-adm'')')
      || ' | ' || pg_temp.ws_try('authenticated', u_r3, 'SELECT public.redeem_invitation(''ldinv-del-lb'')');
    -- L demoted to agent: their viewer link, valid a moment ago, is dead.
    UPDATE profiles SET account_role = 'agent' WHERE user_id = u_l AND account_id = a_acct;
    r := r || ' | ' || pg_temp.ws_try('authenticated', u_r3, 'SELECT public.redeem_invitation(''ldinv-rd-l2'')');
    n := n + 1;
    IF r IS DISTINCT FROM 'ERROR 22023: Invitation has expired | ERROR 22023: Invitation has expired | ERROR 22023: Invitation has expired'
       OR EXISTS (SELECT 1 FROM profiles WHERE user_id = u_r3 AND account_id = a_acct)
       OR EXISTS (SELECT 1 FROM account_invitations
                   WHERE token_hash IN ('ldinv-del-adm', 'ldinv-del-lb', 'ldinv-rd-l2') AND accepted_at IS NOT NULL) THEN
      failed := array_append(failed, ('redeem a demoted leader''s / a leader''s admin / a non-member''s link (want 22023 expired x3): ' || r)::text);
    END IF;
  END;

  -- ---------- 15. archiving a workspace (105) ----------
  -- OW owns T (active there), Alpha and Aardvark. Active in T: M1 (agent;
  -- also a viewer in Alpha, a deactivated agent in Aardvark, which sorts
  -- first, and owner of a personal workspace renamed Zulu), GU (bank
  -- guest; a personal workspace), AD (admin; a personal workspace), M4
  -- (agent; Alpha is their only other row) and LN (T is their only row).
  DECLARE
    u_ow   UUID := '00000000-0000-4000-8000-000000105001';
    u_m1   UUID := '00000000-0000-4000-8000-000000105002';
    u_m4   UUID := '00000000-0000-4000-8000-000000105003';
    u_gu   UUID := '00000000-0000-4000-8000-000000105004';
    u_ad2  UUID := '00000000-0000-4000-8000-000000105005';
    u_ln   UUID := '00000000-0000-4000-8000-000000105006';
    u_rd   UUID := '00000000-0000-4000-8000-000000105007';
    t_acct UUID;
    al_acct UUID;
    aa_acct UUID;
    p_ow   UUID;
    p_m1   UUID;
    p_gu   UUID;
    pbx_al UUID;
    bell   TEXT;
    res    JSONB;
    arch   TEXT;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES
      (u_ow, 'wsarch-ow@example.invalid'), (u_m1, 'wsarch-m1@example.invalid'),
      (u_m4, 'wsarch-m4@example.invalid'), (u_gu, 'wsarch-gu@example.invalid'),
      (u_ad2, 'wsarch-ad@example.invalid'), (u_ln, 'wsarch-ln@example.invalid'),
      (u_rd, 'wsarch-rd@example.invalid');
    SELECT account_id INTO p_ow FROM profiles WHERE user_id = u_ow;
    SELECT account_id INTO p_m1 FROM profiles WHERE user_id = u_m1;
    SELECT account_id INTO p_gu FROM profiles WHERE user_id = u_gu;
    UPDATE accounts SET name = 'WSARCH Zulu ' || id WHERE id IN (p_ow, p_m1);
    INSERT INTO accounts (name, owner_user_id) VALUES ('WSARCH T', u_ow) RETURNING id INTO t_acct;
    INSERT INTO accounts (name, owner_user_id) VALUES ('WSARCH Alpha', u_ow) RETURNING id INTO al_acct;
    INSERT INTO accounts (name, owner_user_id) VALUES ('WSARCH Aardvark', u_ow) RETURNING id INTO aa_acct;
    UPDATE profiles SET is_active = false WHERE user_id IN (u_ow, u_m1, u_gu, u_ad2);
    INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active, bank_code, deactivated_at) VALUES
      (u_ow,  '', 'wsarch-ow@example.invalid', t_acct,  'owner',      true,  NULL,   NULL),
      (u_m1,  '', 'wsarch-m1@example.invalid', t_acct,  'agent',      true,  NULL,   NULL),
      (u_gu,  '', 'wsarch-gu@example.invalid', t_acct,  'bank_guest', true,  'ADCB', NULL),
      (u_ad2, '', 'wsarch-ad@example.invalid', t_acct,  'admin',      true,  NULL,   NULL),
      (u_ow,  '', 'wsarch-ow@example.invalid', al_acct, 'owner',      false, NULL,   NULL),
      (u_m1,  '', 'wsarch-m1@example.invalid', al_acct, 'viewer',     false, NULL,   NULL),
      (u_m4,  '', 'wsarch-m4@example.invalid', al_acct, 'agent',      false, NULL,   NULL),
      (u_m1,  '', 'wsarch-m1@example.invalid', aa_acct, 'agent',      false, NULL,   now());
    UPDATE profiles SET account_id = t_acct, account_role = 'agent' WHERE user_id IN (u_m4, u_ln) AND is_active;
    -- 083's promotion order (live, then newest) would pick M1's T row.
    UPDATE profiles SET created_at = now() + interval '1 hour' WHERE user_id = u_m1 AND account_id = t_acct;
    INSERT INTO contacts (user_id, phone, account_id) VALUES (u_ow, '+971500105001', t_acct);
    INSERT INTO notifications (account_id, user_id, title) VALUES (t_acct, u_m1, 'wsarch bell');
    INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at, accepted_at, accepted_by_user_id) VALUES
      (t_acct, 'wsarch-pend-1', 'agent', u_ow, now() + interval '1 day', NULL, NULL),
      (t_acct, 'wsarch-pend-2', 'viewer', u_ow, now() + interval '1 day', NULL, NULL),
      (t_acct, 'wsarch-used', 'agent', u_ow, now() + interval '1 day', now(), u_m1);
    arch := format('SELECT public.archive_workspace(%L, true)', t_acct);

    -- An admin is not an owner.
    r := pg_temp.ws_try('authenticated', u_ad2, arch);
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501:%' OR (SELECT archived_at FROM accounts WHERE id = t_acct) IS NOT NULL THEN
      failed := array_append(failed, ('archive by an admin (want 42501): ' || r)::text);
    END IF;

    -- The owner's other workspaces are all archived: nowhere to land.
    UPDATE accounts SET archived_at = now() WHERE id IN (p_ow, al_acct);
    r := pg_temp.ws_try('authenticated', u_ow, arch);
    UPDATE accounts SET archived_at = NULL WHERE id IN (p_ow, al_acct);
    n := n + 1;
    IF r NOT LIKE 'ERROR WS001:%' THEN
      failed := array_append(failed, ('archive with no other workspace for the owner (want WS001): ' || r)::text);
    END IF;

    -- A phone system, then a WhatsApp number, still connected.
    INSERT INTO pbx_connections (account_id, label, edition, base_url)
    VALUES (t_acct, 'wsarch', 'cloud', 'https://pbx.example.invalid');
    r := pg_temp.ws_try('authenticated', u_ow, arch);
    DELETE FROM pbx_connections WHERE account_id = t_acct;
    INSERT INTO whatsapp_config (user_id, phone_number_id, access_token, account_id)
    VALUES (u_ow, 'wsarch-105', 'x', t_acct);
    r := r || ' | ' || pg_temp.ws_try('authenticated', u_ow, arch);
    DELETE FROM whatsapp_config WHERE account_id = t_acct;
    n := n + 1;
    IF r NOT LIKE 'ERROR WS002:% | ERROR WS002:%' THEN
      failed := array_append(failed, ('archive with a phone system / a number connected (want WS002 x2): ' || r)::text);
    END IF;

    -- Alpha's phone system routes a number here, then maps an extension
    -- here: refused, naming each, and Alpha's configuration left alone.
    INSERT INTO pbx_connections (account_id, label, edition, base_url)
    VALUES (al_acct, 'wsarch-alpha', 'cloud', 'https://pbx-alpha.example.invalid') RETURNING id INTO pbx_al;
    INSERT INTO pbx_did_routes (connection_id, did_number, account_id) VALUES (pbx_al, '97143105001', t_acct);
    r := pg_temp.ws_try('authenticated', u_ow, arch);
    DELETE FROM pbx_did_routes WHERE connection_id = pbx_al;
    INSERT INTO pbx_extensions (connection_id, extension, account_id) VALUES (pbx_al, '1051', t_acct);
    r := r || ' | ' || pg_temp.ws_try('authenticated', u_ow, arch);
    n := n + 1;
    IF r IS DISTINCT FROM 'ERROR WS002: Another workspace''s phone system still sends calls here (numbers 97143105001); remove them in its phone settings first'
         || ' | ERROR WS002: Another workspace''s phone system still sends calls here (extensions 1051); remove them in its phone settings first'
       OR NOT EXISTS (SELECT 1 FROM pbx_extensions WHERE connection_id = pbx_al AND account_id = t_acct)
       OR (SELECT archived_at FROM accounts WHERE id = t_acct) IS NOT NULL THEN
      failed := array_append(failed, ('archive with another workspace''s number / extension routed here (want WS002 x2, named): ' || r)::text);
    END IF;
    DELETE FROM pbx_extensions WHERE connection_id = pbx_al;
    -- Alpha's own number, for the guard below.
    INSERT INTO pbx_did_routes (connection_id, did_number, account_id) VALUES (pbx_al, '97143105003', al_acct);

    -- LN, live, has no other workspace.
    r := pg_temp.ws_try('authenticated', u_ow, arch);
    n := n + 1;
    IF r IS DISTINCT FROM 'ERROR WS003: 1 member(s) have no other workspace to move to; deactivate or remove them first'
       OR (SELECT archived_at FROM accounts WHERE id = t_acct) IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM account_invitations WHERE token_hash = 'wsarch-pend-1') THEN
      failed := array_append(failed, ('archive with a stranded member (want WS003, 1, nothing changed): ' || r)::text);
    END IF;

    -- Deactivated, LN no longer counts. Before: the owner and the admin read T's customer.
    UPDATE profiles SET deactivated_at = now() WHERE user_id = u_ln;
    r := pg_temp.ws_val(u_ow, format('SELECT count(*)::text FROM public.contacts WHERE account_id = %L', t_acct))
      || pg_temp.ws_val(u_ad2, format('SELECT count(*)::text FROM public.contacts WHERE account_id = %L', t_acct));
    bell := pg_temp.ws_val(u_m1, format('SELECT count(*)::text FROM public.notifications WHERE account_id = %L', t_acct));
    r := r || ' | ' || pg_temp.ws_val(u_ow, arch || '::text');
    n := n + 1;
    IF r NOT LIKE '11 | {%' THEN
      failed := array_append(failed, ('archive (want reads 11, then a result): ' || r)::text);
    ELSE
      res := split_part(r, ' | ', 2)::jsonb;
      IF res IS DISTINCT FROM jsonb_build_object('account_id', t_acct, 'archived', true,
           'active_account_id', al_acct, 'active_role', 'owner', 'moved', 5, 'invitations_revoked', 2) THEN
        failed := array_append(failed, ('archive result: ' || res::text)::text);
      END IF;
    END IF;
    -- Everyone live moved out, M1 to Alpha (by name; Aardvark's row is
    -- deactivated), GU to their own; LN stays, deactivated; the pending
    -- links are gone, the redeemed one kept; one audit row.
    n := n + 1;
    IF (SELECT archived_by FROM accounts WHERE id = t_acct AND archived_at IS NOT NULL) IS DISTINCT FROM u_ow
       OR EXISTS (SELECT 1 FROM profiles WHERE account_id = t_acct AND is_active AND deactivated_at IS NULL)
       OR (SELECT account_id FROM profiles WHERE user_id = u_m1 AND is_active) IS DISTINCT FROM al_acct
       OR (SELECT account_id FROM profiles WHERE user_id = u_gu AND is_active) IS DISTINCT FROM p_gu
       OR (SELECT account_id FROM profiles WHERE user_id = u_ln AND is_active) IS DISTINCT FROM t_acct
       OR (SELECT string_agg(token_hash, ',' ORDER BY token_hash) FROM account_invitations
            WHERE account_id = t_acct) IS DISTINCT FROM 'wsarch-used'
       OR (SELECT string_agg(action || ':' || coalesce(actor_id::text, 'null'), ',') FROM workspace_audit
            WHERE account_id = t_acct AND action IN ('workspace_archived', 'workspace_restored'))
          IS DISTINCT FROM 'workspace_archived:' || u_ow THEN
      failed := array_append(failed, 'archive: stamp, moves, revoked links or audit row wrong'::text);
    END IF;

    -- Afterwards: no reads of T, no way back in, a dead link, archiving
    -- again changes nothing, and only the owner lists T.
    INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at)
    VALUES (t_acct, 'wsarch-late', 'agent', u_ow, now() + interval '1 day');
    r := pg_temp.ws_val(u_ow, format('SELECT count(*)::text FROM public.contacts WHERE account_id = %L', t_acct))
      || pg_temp.ws_val(u_ad2, format('SELECT count(*)::text FROM public.contacts WHERE account_id = %L', t_acct))
      || ' | ' || pg_temp.ws_try('authenticated', u_m1, format('SELECT public.switch_account(%L)', t_acct))
      || ' | ' || pg_temp.ws_try('authenticated', u_ow, format('SELECT public.switch_account(%L)', t_acct))
      || ' | ' || pg_temp.ws_try('authenticated', u_rd, 'SELECT public.redeem_invitation(''wsarch-late'')')
      || ' | ' || pg_temp.ws_val(u_ow, format('SELECT (public.archive_workspace(%L, true)->>''moved'')', t_acct))
      || ' | ' || pg_temp.ws_val(u_ow, format('SELECT archived::text FROM public.my_workspaces() WHERE account_id = %L', t_acct))
      || ' | ' || pg_temp.ws_val(u_m1, format('SELECT archived::text FROM public.my_workspaces() WHERE account_id = %L', t_acct));
    n := n + 1;
    IF r IS DISTINCT FROM '00 | ERROR 42501: That workspace is archived | ERROR 42501: That workspace is archived'
         || ' | ERROR 22023: Invitation has expired | 0 | true | null'
       OR EXISTS (SELECT 1 FROM profiles WHERE user_id = u_rd AND account_id = t_acct)
       OR (SELECT count(*) FROM workspace_audit WHERE account_id = t_acct AND action = 'workspace_archived') <> 1 THEN
      failed := array_append(failed, ('archived T (want no reads, switches refused, link dead, no-op, owner-only listing): ' || r)::text);
    END IF;

    -- T's notifications leave M1's bell, though M1 is still live in T.
    r := bell || pg_temp.ws_val(u_m1, format('SELECT count(*)::text FROM public.notifications WHERE account_id = %L', t_acct));
    n := n + 1;
    IF r IS DISTINCT FROM '10'
       OR NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = u_m1 AND account_id = t_acct AND deactivated_at IS NULL) THEN
      failed := array_append(failed, ('archived T in the bell (want 1 before, 0 after): ' || r)::text);
    END IF;

    -- LN, left active and deactivated in T, is not made live there again.
    r := pg_temp.ws_try('service_role', NULL,
           format('UPDATE public.profiles SET deactivated_at = NULL WHERE user_id = %L AND account_id = %L', u_ln, t_acct))
      || ' | ' || pg_temp.ws_val(u_ln, 'SELECT public.current_account_id()::text');
    n := n + 1;
    IF r IS DISTINCT FROM 'ERROR 42501: That workspace is archived | null'
       OR NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = u_ln AND account_id = t_acct
                        AND is_active AND deactivated_at IS NOT NULL) THEN
      failed := array_append(failed, ('reactivating LN in archived T (want 42501, null): ' || r)::text);
    END IF;

    -- Nothing connects to T: a number, a phone system, Alpha's route and
    -- extension, or Alpha's number moved to T (a connect in flight).
    r := pg_temp.ws_try('service_role', NULL, format(
           'INSERT INTO public.whatsapp_config (user_id, phone_number_id, access_token, account_id) VALUES (%L, ''wsarch-105-late'', ''x'', %L)', u_ow, t_acct))
      || ' | ' || pg_temp.ws_try('service_role', NULL, format(
           'INSERT INTO public.pbx_connections (account_id, label, edition, base_url) VALUES (%L, ''wsarch-late'', ''cloud'', ''https://pbx-late.example.invalid'')', t_acct))
      || ' | ' || pg_temp.ws_try('service_role', NULL, format(
           'INSERT INTO public.pbx_did_routes (connection_id, did_number, account_id) VALUES (%L, ''97143105002'', %L)', pbx_al, t_acct))
      || ' | ' || pg_temp.ws_try('service_role', NULL, format(
           'INSERT INTO public.pbx_extensions (connection_id, extension, account_id) VALUES (%L, ''1052'', %L)', pbx_al, t_acct))
      || ' | ' || pg_temp.ws_try('service_role', NULL, format(
           'UPDATE public.pbx_did_routes SET account_id = %L WHERE connection_id = %L', t_acct, pbx_al))
      || ' | ' || pg_temp.ws_try('service_role', NULL, format(
           'UPDATE public.pbx_did_routes SET name_on_pbx = ''wsarch'' WHERE connection_id = %L', pbx_al));
    n := n + 1;
    IF r IS DISTINCT FROM 'ERROR 42501: That workspace is archived | ERROR 42501: That workspace is archived'
         || ' | ERROR 42501: That workspace is archived | ERROR 42501: That workspace is archived'
         || ' | ERROR 42501: That workspace is archived | ok'
       OR EXISTS (SELECT 1 FROM whatsapp_config WHERE account_id = t_acct)
       OR EXISTS (SELECT 1 FROM pbx_connections WHERE account_id = t_acct)
       OR EXISTS (SELECT 1 FROM pbx_did_routes WHERE account_id = t_acct)
       OR EXISTS (SELECT 1 FROM pbx_extensions WHERE account_id = t_acct) THEN
      failed := array_append(failed, ('connect to archived T (want 42501 x5, then an unmoved route ok): ' || r)::text);
    END IF;

    -- Only archive_workspace writes the stamp; and no other writer makes
    -- a row in T active (the service role here).
    UPDATE profiles SET is_active = false WHERE user_id = u_gu AND is_active;
    r := pg_temp.ws_try('authenticated', u_ow, format('UPDATE public.accounts SET archived_at = now() WHERE id = %L', al_acct))
      || ' | ' || pg_temp.ws_try('service_role', NULL,
           format('UPDATE public.profiles SET is_active = true WHERE user_id = %L AND account_id = %L', u_gu, t_acct));
    UPDATE profiles SET is_active = false WHERE user_id = u_gu AND is_active;
    UPDATE profiles SET is_active = true WHERE user_id = u_gu AND account_id = p_gu;
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501:% | ERROR 42501: That workspace is archived'
       OR (SELECT archived_at FROM accounts WHERE id = al_acct) IS NOT NULL THEN
      failed := array_append(failed, ('client stamp / service-role activation into T (want 42501 x2): ' || r)::text);
    END IF;

    -- remove_account_member never hands the active mark to a T row: M1
    -- falls back to their own workspace, and M4, whose only other row is
    -- T's, gets 083's fresh account as a viewer.
    r := pg_temp.ws_val(u_ow, format('SELECT public.remove_account_member(%L)::text', u_m1))
      || ' | ' || pg_temp.ws_val(u_ow, format('SELECT public.remove_account_member(%L)::text', u_m4));
    n := n + 1;
    IF r NOT LIKE 'null | ________-%'
       OR (SELECT account_id FROM profiles WHERE user_id = u_m1 AND is_active) IS DISTINCT FROM p_m1
       OR (SELECT account_id::text || ':' || account_role FROM profiles WHERE user_id = u_m4 AND is_active)
          IS DISTINCT FROM split_part(r, ' | ', 2) || ':viewer'
       OR NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = u_m4 AND account_id = t_acct AND NOT is_active) THEN
      failed := array_append(failed, ('remove with T rows left (want M1 home, M4 a fresh account): ' || r)::text);
    END IF;

    -- Restore: an admin may not; the owner may, staying in Alpha; members
    -- switch back in; revoked links stay revoked; one audit row.
    r := pg_temp.ws_try('authenticated', u_ad2, format('SELECT public.archive_workspace(%L, false)', t_acct))
      || ' | ' || pg_temp.ws_val(u_ow, format('SELECT public.archive_workspace(%L, false)::text', t_acct))
      || ' | ' || pg_temp.ws_val(u_m1, format('SELECT public.switch_account(%L)::text', t_acct));
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501:% | {%} | ' || t_acct
       OR split_part(r, ' | ', 2)::jsonb IS DISTINCT FROM jsonb_build_object('account_id', t_acct, 'archived', false,
            'active_account_id', al_acct, 'active_role', 'owner', 'moved', 0, 'invitations_revoked', 0)
       OR (SELECT archived_at FROM accounts WHERE id = t_acct) IS NOT NULL
       OR EXISTS (SELECT 1 FROM account_invitations WHERE token_hash IN ('wsarch-pend-1', 'wsarch-pend-2'))
       OR (SELECT string_agg(action || ':' || coalesce(actor_id::text, 'null'), ',' ORDER BY at, action) FROM workspace_audit
            WHERE account_id = t_acct AND action IN ('workspace_archived', 'workspace_restored'))
          IS DISTINCT FROM 'workspace_archived:' || u_ow || ',workspace_restored:' || u_ow THEN
      failed := array_append(failed, ('restore (want 42501, the owner''s result, M1 back in, links still gone): ' || r)::text);
    END IF;
  END;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT083', MESSAGE = 'verify-workspaces rollback';
  EXCEPTION WHEN SQLSTATE 'ZT083' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'workspaces verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'workspaces verification passed (% checks)', n;
END
$verify$;
