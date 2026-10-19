-- Behavioural regression suite for CRM memory (migration 129): redacted
-- items per contact / case / workspace, the one read predicate, audit.
--
-- memory_can_read needs a live staff profile in the account (active or
-- not, never a bank guest); then owner / admin read every scope, any
-- member the account's workspace scope, a contact scope follows 072's
-- can_view_contact for an explicit user (creator, own / assigned chat,
-- the leader of their team), a case scope 122's case_role, plus active
-- memory_acl rows. memory_put stores content as given, dedupes on the
-- scope's live hash (a superseded match is ignored), refuses untrusted
-- importance > 2, expires within 24 months, checks the scope inside the
-- account (SCOPE_INVALID), never lets an untrusted write supersede a
-- verified item, and evicts over a per-scope cap (superseded first,
-- then importance x recency, never verified), each eviction audited.
-- Recall candidates are read-only; marking recalled bumps only readable
-- live ids and audits once per call. Erasure (forget, TTL sweep, a
-- deleted contact) is audited with counts; compaction supersedes every
-- source or nothing. The audit is append-only and items / acl rows are
-- never deleted directly, the owner included; no API role holds a table
-- privilege and service_role executes exactly the 11 API functions.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000129001';
  u_admin  UUID := '00000000-0000-4000-8000-000000129002';
  u_lead   UUID := '00000000-0000-4000-8000-000000129003';  -- leads team T (u_agent, u_agent2)
  u_agent  UUID := '00000000-0000-4000-8000-000000129004';  -- created c1; agent of case k1
  u_agent2 UUID := '00000000-0000-4000-8000-000000129005';  -- assignee of c2's chat
  u_agent3 UUID := '00000000-0000-4000-8000-000000129006';  -- owns c3's chat; in no team
  u_viewer UUID := '00000000-0000-4000-8000-000000129007';
  u_guest  UUID := '00000000-0000-4000-8000-000000129008';  -- bank_guest of A
  u_bown   UUID := '00000000-0000-4000-8000-000000129009';  -- owner of account B
  u_multi  UUID := '00000000-0000-4000-8000-000000129010';  -- active in its own account, inactive viewer row in A
  a_acct   UUID;
  b_acct   UUID;
  wa       UUID;
  wb       UUID;
  c1       UUID;
  c2       UUID;
  c3       UUID;
  c4       UUID;  -- eviction scope
  c5       UUID;  -- deleted with memory
  c6       UUID;  -- deleted without memory
  cb       UUID;
  team1    UUID;
  gid      UUID;
  k1       UUID;
  kb       UUID;
  rec      RECORD;
  i        INT;
  j        INT;
  m        INT;
  x1       UUID;
  x2       UUID;
  x3       UUID;
  x4       UUID;
  x5       UUID;
  ids      UUID[];
  ts       TIMESTAMPTZ;
  usr      UUID[];
  lbl      TEXT[];
  expect   TEXT[];
  scp      TEXT[] := ARRAY['contact', 'contact', 'contact', 'case', 'workspace'];
  sid      UUID[];
  r        TEXT;
  p1       TEXT;
  p2       TEXT;
  p3       TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
  api_fns  TEXT[] := ARRAY['memory_acl_grant', 'memory_acl_revoke', 'memory_can_read', 'memory_compact_apply',
    'memory_compact_candidates', 'memory_expire_due', 'memory_forget', 'memory_list', 'memory_mark_recalled',
    'memory_put', 'memory_recall_candidates'];
  priv_fns TEXT[] := ARRAY['memory_acl_guard', 'memory_append_only', 'memory_forget_deleted_contact',
    'memory_items_guard'];
  tbls     TEXT[] := ARRAY['memory_items', 'memory_acl', 'memory_audit'];
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
  -- NULL when cs_try's result is LIKE p_like, else the check's name and
  -- the result (so `failed := failed || cs_check(…)` records failures only).
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
  -- sha256 hex of a text: the content hash the app passes.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.h(p text) RETURNS text LANGUAGE sql IMMUTABLE AS
    $body$ SELECT encode(sha256(convert_to(p, 'UTF8')), 'hex') $body$
  $fn$;
  -- memory_put with the arguments a check varies (kind 'fact', source 'chat').
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.mp(p_acct uuid, p_st text, p_sid uuid, p_content text, p_imp int, p_trust text,
                               p_sup uuid, p_cap int)
    RETURNS TABLE (item_id uuid, deduped boolean, evicted integer, item_trust text, item_importance smallint)
    LANGUAGE sql AS $body$
      SELECT * FROM public.memory_put(p_acct, p_st, p_sid, 'fact', p_content, pg_temp.h(p_content), p_imp::smallint,
        p_trust, 'chat', NULL, NULL, NULL, NULL, p_sup, p_cap, '{"phone": 1}'::jsonb)
    $body$
  $fn$;
  -- A row written directly as the owner, created p_age ago and expiring
  -- 24 months after that (so an age over 24 months is already expired).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.mi(p_acct uuid, p_st text, p_sid uuid, p_content text, p_imp int, p_trust text,
                               p_kind text, p_age interval)
    RETURNS uuid LANGUAGE sql AS $body$
      INSERT INTO public.memory_items (account_id, scope_type, scope_id, kind, content, content_hash, importance, trust,
                                       source_type, created_at, expires_at)
      VALUES (p_acct, p_st, p_sid, p_kind, p_content, pg_temp.h(p_content), p_imp::smallint, p_trust, 'chat',
              now() - p_age, now() - p_age + interval '24 months')
      RETURNING id
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'mem-owner@example.invalid'),
    (u_admin,  'mem-admin@example.invalid'),
    (u_lead,   'mem-lead@example.invalid'),
    (u_agent,  'mem-agent@example.invalid'),
    (u_agent2, 'mem-agent2@example.invalid'),
    (u_agent3, 'mem-agent3@example.invalid'),
    (u_viewer, 'mem-viewer@example.invalid'),
    (u_guest,  'mem-guest@example.invalid'),
    (u_bown,   'mem-bown@example.invalid'),
    (u_multi,  'mem-multi@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_bown;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_agent2, u_agent3);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;
  INSERT INTO profiles (user_id, account_id, account_role, full_name, email, is_active)
  VALUES (u_multi, a_acct, 'viewer', 'Mem multi', 'mem-multi@example.invalid', false);

  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'Mem T', u_lead) RETURNING id INTO team1;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (team1, u_agent, a_acct), (team1, u_agent2, a_acct);

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CT-129-A1', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_bown, b_acct, 'whapi', 'CT-129-B1', 'x', 'connected', true) RETURNING id INTO wb;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500129001', 'Mem one')
    RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500129002', 'Mem two')
    RETURNING id INTO c2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500129003', 'Mem three')
    RETURNING id INTO c3;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500129004', 'Mem four')
    RETURNING id INTO c4;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500129005', 'Mem five')
    RETURNING id INTO c5;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500129006', 'Mem six')
    RETURNING id INTO c6;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b_acct, u_bown, '971500129007', 'Mem B')
    RETURNING id INTO cb;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id) VALUES (a_acct, u_owner, c2, u_agent2);
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent3, c3);

  gid := (SELECT x.group_id FROM sg_open(a_acct, 'CT-129-1', c1, wa, 'mem 1', NULL,
    jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
  k1 := (SELECT x.case_id FROM case_open(gid, NULL, NULL, NULL, NULL, NULL) x);
  gid := (SELECT x.group_id FROM sg_open(b_acct, 'CT-129-2', cb, wb, 'mem 2', NULL,
    jsonb_build_array(jsonb_build_object('user_id', u_bown, 'label', 'agent')), NULL) x);
  kb := (SELECT x.case_id FROM case_open(gid, NULL, NULL, NULL, NULL, NULL) x);
  IF k1 IS NULL OR kb IS NULL THEN
    RAISE EXCEPTION 'fixture: case_open returned no case';
  END IF;

  -- ---------- memory_can_read ----------
  -- Scopes in order: c1 (created by u_agent), c2 (chat assigned to
  -- u_agent2), c3 (chat owned by u_agent3), case k1 (agent u_agent), the
  -- account's workspace. Called as service_role, as the app does.
  sid := ARRAY[c1, c2, c3, k1, a_acct];
  usr := ARRAY[u_owner, u_admin, u_agent, u_agent2, u_lead, u_agent3, u_viewer, u_guest, u_bown, u_multi];
  lbl := ARRAY['owner', 'admin', 'contact creator / case agent', 'chat assignee', 'team leader', 'chat owner',
    'viewer', 'bank guest', 'another account''s owner', 'inactive viewer row'];
  expect := ARRAY['TTTTT', 'TTTTT', 'TFFTT', 'FTFFT', 'TTFTT', 'FFTFT', 'FFFFT', 'FFFFF', 'FFFFF', 'FFFFT'];
  FOR i IN 1 .. array_length(usr, 1) LOOP
    FOR j IN 1 .. 5 LOOP
      n := n + 1; failed := failed || pg_temp.cs_check(
        format('memory_can_read: the %s on %s scope #%s should be %s', lbl[i], scp[j], j, substr(expect[i], j, 1)),
        'service_role', NULL,
        format('SELECT memory_can_read(%L, %L, %L, %L)::text', usr[i], a_acct, scp[j], sid[j]),
        CASE substr(expect[i], j, 1) WHEN 'T' THEN 'true' ELSE 'false' END);
    END LOOP;
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_ok(memory_can_read(u_bown, b_acct, 'workspace', b_acct)
      AND memory_can_read(u_bown, b_acct, 'contact', cb) AND memory_can_read(u_bown, b_acct, 'case', kb),
    'memory_can_read: account B''s owner cannot read B''s own scopes');
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT memory_can_read(u_agent, a_acct, 'workspace', b_acct)
      AND NOT memory_can_read(u_agent, a_acct, 'workspace', c1),
    'memory_can_read: a workspace scope that is not the account is readable');
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT memory_can_read(u_agent, a_acct, 'contact', cb)
      AND NOT memory_can_read(u_agent, a_acct, 'case', kb),
    'memory_can_read: a member reads another account''s case through its own account');
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT memory_can_read(u_owner, b_acct, 'contact', cb)
      AND NOT memory_can_read(NULL, a_acct, 'workspace', a_acct),
    'memory_can_read: a non-member of the account (or a NULL user) reads it');

  -- Demoting and deactivating take effect at once.
  UPDATE profiles SET account_role = 'agent' WHERE user_id = u_lead AND account_id = a_acct;
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT memory_can_read(u_lead, a_acct, 'contact', c1)
      AND NOT memory_can_read(u_lead, a_acct, 'case', k1),
    'memory_can_read: a team leader demoted to agent still reads the team''s contact / case');
  UPDATE profiles SET account_role = 'team_leader' WHERE user_id = u_lead AND account_id = a_acct;
  UPDATE profiles SET account_role = 'viewer' WHERE user_id = u_admin AND account_id = a_acct;
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT memory_can_read(u_admin, a_acct, 'contact', c3),
    'memory_can_read: an admin demoted to viewer still reads every contact');
  UPDATE profiles SET account_role = 'admin' WHERE user_id = u_admin AND account_id = a_acct;
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_agent AND account_id = a_acct;
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT memory_can_read(u_agent, a_acct, 'contact', c1)
      AND NOT memory_can_read(u_agent, a_acct, 'case', k1) AND NOT memory_can_read(u_agent, a_acct, 'workspace', a_acct),
    'memory_can_read: a deactivated agent still reads');
  UPDATE profiles SET deactivated_at = NULL WHERE user_id = u_agent AND account_id = a_acct;
  n := n + 1; failed := failed || pg_temp.cs_ok(memory_can_read(u_agent, a_acct, 'contact', c1),
    'memory_can_read: a reactivated agent does not read again');

  -- An explicit acl row opens exactly one scope; revoking closes it.
  n := n + 1; failed := failed || pg_temp.cs_ok(memory_acl_grant(u_owner, a_acct, 'contact', c1, u_viewer, 'member'),
    'memory_acl_grant: a new grant did not return true');
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT memory_acl_grant(u_owner, a_acct, 'contact', c1, u_viewer, 'member'),
    'memory_acl_grant: a repeated grant was not idempotent');
  n := n + 1; failed := failed || pg_temp.cs_ok(memory_can_read(u_viewer, a_acct, 'contact', c1)
      AND NOT memory_can_read(u_viewer, a_acct, 'contact', c2),
    'memory_can_read: a member acl row does not open exactly its scope');
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT memory_can_read(u_guest, a_acct, 'contact', c1)
      AND memory_acl_grant(u_owner, a_acct, 'contact', c1, u_guest, 'member')
      AND NOT memory_can_read(u_guest, a_acct, 'contact', c1),
    'memory_can_read: an acl row lets a bank guest read');
  n := n + 1; failed := failed || pg_temp.cs_ok(memory_acl_revoke(u_owner, a_acct, 'contact', c1, u_viewer) = 1,
    'memory_acl_revoke: did not revoke the one active row');
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT memory_can_read(u_viewer, a_acct, 'contact', c1),
    'memory_can_read: a revoked acl row still opens the scope');
  PERFORM memory_acl_grant(u_owner, a_acct, 'workspace', a_acct, u_viewer, 'admin');
  n := n + 1; failed := failed || pg_temp.cs_ok(memory_can_read(u_viewer, a_acct, 'contact', c2)
      AND memory_can_read(u_viewer, a_acct, 'case', k1),
    'memory_can_read: an admin acl row on the workspace does not read every scope');
  PERFORM memory_acl_revoke(u_owner, a_acct, 'workspace', a_acct, u_viewer);
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT memory_can_read(u_viewer, a_acct, 'contact', c2),
    'memory_can_read: a revoked workspace admin acl row still reads every scope');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM memory_audit WHERE account_id = a_acct AND action = 'acl_grant') = 3
    AND (SELECT count(*) FROM memory_audit WHERE account_id = a_acct AND action = 'acl_revoke') = 2,
    'memory_acl: grants / revokes are not audited once each');

  -- ---------- memory_put ----------
  n := n + 1; failed := failed || pg_temp.cs_check('memory_put as service_role does not store an item',
    'service_role', NULL, format('SELECT x.deduped::text FROM pg_temp.mp(%L, %L, %L, %L, 1, NULL, NULL, 100) x',
      a_acct, 'contact', c1, '  Likes  apple, ٤٢ ' ), 'false');
  SELECT * INTO rec FROM memory_items WHERE scope_id = c1 AND content_hash = pg_temp.h('  Likes  apple, ٤٢ ');
  x1 := rec.id;
  n := n + 1; failed := failed || pg_temp.cs_ok(rec.content = '  Likes  apple, ٤٢ ' AND rec.trust = 'untrusted'
      AND rec.importance = 1 AND rec.created_by IS NULL AND rec.superseded_by IS NULL AND rec.recall_count = 0,
    'memory_put: the item is not stored as given');
  n := n + 1; failed := failed || pg_temp.cs_ok(rec.expires_at = rec.created_at + interval '24 months',
    'memory_put: expiry is not created_at + 24 months');
  n := n + 1; failed := failed || pg_temp.cs_ok(rec.search @@ to_tsquery('simple', '42'),
    'memory_put: Arabic-Indic digits are not folded into the search vector');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM memory_audit WHERE scope_id = c1 AND action = 'put' AND item_count = 1
       AND detail->'redactions' = '{"phone": 1}'::jsonb AND NOT detail ? 'content') = 1,
    'memory_put: the write is not audited once, with counts only');
  SELECT * INTO rec FROM pg_temp.mp(a_acct, 'contact', c1, '  Likes  apple, ٤٢ ', 2, NULL, NULL, 100);
  n := n + 1; failed := failed || pg_temp.cs_ok(rec.item_id = x1 AND rec.deduped AND rec.evicted = 0
      AND rec.item_importance = 1,
    'memory_put: the same hash in the same scope does not dedupe onto the stored row');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM memory_items WHERE scope_id = c1 AND content_hash = pg_temp.h('  Likes  apple, ٤٢ ')) = 1
    AND (SELECT count(*) FROM memory_audit WHERE scope_id = c1 AND action = 'dedupe') = 1,
    'memory_put: a dedupe stored a second row or was not audited');
  SELECT * INTO rec FROM pg_temp.mp(a_acct, 'contact', c2, '  Likes  apple, ٤٢ ', 1, NULL, NULL, 100);
  x5 := rec.item_id;
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT rec.deduped AND x5 <> x1,
    'memory_put: the same hash in another scope dedupes across scopes');

  -- Supersede: once, and a superseded match is not a dedupe target.
  SELECT * INTO rec FROM pg_temp.mp(a_acct, 'contact', c1, 'Likes pear', 1, NULL, x1, 100);
  x2 := rec.item_id;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT superseded_by FROM memory_items WHERE id = x1) = x2
    AND (SELECT count(*) FROM memory_audit WHERE scope_id = c1 AND action = 'supersede') = 1,
    'memory_put: a supersede did not set superseded_by (audited)');
  SELECT * INTO rec FROM pg_temp.mp(a_acct, 'contact', c1, '  Likes  apple, ٤٢ ', 1, NULL, NULL, 100);
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT rec.deduped AND rec.item_id <> x1,
    'memory_put: a re-put of superseded content deduped onto the superseded row');
  x3 := rec.item_id;
  n := n + 1; failed := failed || pg_temp.cs_check('memory_put: an item was superseded twice', NULL, NULL,
    format('SELECT x.item_id::text FROM pg_temp.mp(%L, %L, %L, %L, 1, NULL, %L, 100) x', a_acct, 'contact', c1,
      'Likes plum', x1), 'ERROR 22023 %superseded item must be a live item%');
  n := n + 1; failed := failed || pg_temp.cs_check('memory_items: superseded_by moved a second time as the owner',
    NULL, NULL, format('UPDATE memory_items SET superseded_by = %L WHERE id = %L', x3, x1),
    'ERROR 42501 %set once%');

  -- Verified items: only a verified write supersedes them.
  SELECT * INTO rec FROM pg_temp.mp(a_acct, 'contact', c1, 'Salary 20k (verified)', 5, 'verified', NULL, 100);
  x4 := rec.item_id;
  n := n + 1; failed := failed || pg_temp.cs_ok(rec.item_trust = 'verified' AND rec.item_importance = 5,
    'memory_put: a verified item does not keep importance 5');
  n := n + 1; failed := failed || pg_temp.cs_check('memory_put: an untrusted write superseded a verified item',
    NULL, NULL, format('SELECT x.item_id::text FROM pg_temp.mp(%L, %L, %L, %L, 1, %L, %L, 100) x', a_acct,
      'contact', c1, 'Salary 30k', 'untrusted', x4), 'ERROR 42501 SUPERSEDE_VERIFIED%');
  n := n + 1; failed := failed || pg_temp.cs_check('memory_put: an untrusted re-put of live content superseded a verified item',
    NULL, NULL, format('SELECT x.item_id::text FROM pg_temp.mp(%L, %L, %L, %L, 1, %L, %L, 100) x', a_acct,
      'contact', c1, 'Likes pear', 'untrusted', x4), 'ERROR 42501 SUPERSEDE_VERIFIED%');
  n := n + 1; failed := failed || pg_temp.cs_ok((SELECT superseded_by FROM memory_items WHERE id = x4) IS NULL,
    'memory_put: a refused supersede left the verified item superseded');
  n := n + 1; failed := failed || pg_temp.cs_check('memory_put: a verified write could not supersede a verified item',
    NULL, NULL, format('SELECT x.deduped::text FROM pg_temp.mp(%L, %L, %L, %L, 4, %L, %L, 100) x', a_acct,
      'contact', c1, 'Salary 25k (verified)', 'verified', x4), 'false');

  -- Untrusted importance is capped by a CHECK: the write is refused.
  n := n + 1; failed := failed || pg_temp.cs_check('memory_put: an untrusted item with importance 3 was stored',
    NULL, NULL, format('SELECT x.item_id::text FROM pg_temp.mp(%L, %L, %L, %L, 3, NULL, NULL, 100) x', a_acct,
      'contact', c1, 'Very important'), 'ERROR 23514 %memory_items_untrusted_importance%');
  n := n + 1; failed := failed || pg_temp.cs_check('memory_items: an expiry later than created_at + 24 months was stored',
    NULL, NULL, format($q$INSERT INTO memory_items (account_id, scope_type, scope_id, kind, content, content_hash,
      importance, source_type, expires_at) VALUES (%L, 'contact', %L, 'fact', 'late', %L, 1, 'chat',
      now() + interval '25 months')$q$, a_acct, c1, pg_temp.h('late')), 'ERROR 23514 %memory_items_ttl%');

  -- The scope must be inside the account.
  FOR i IN 1 .. 6 LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(
      format('memory_put: scope #%s outside the account was accepted', i), 'service_role', NULL,
      format('SELECT x.item_id::text FROM pg_temp.mp(%L, %L, %L, %L, 1, NULL, NULL, 100) x', a_acct,
        (ARRAY['contact', 'case', 'contact', 'case', 'workspace', 'workspace'])[i],
        (ARRAY[cb, kb, gen_random_uuid(), c1, b_acct, c1])[i], 'scope probe'),
      'ERROR 22023 SCOPE_INVALID%');
  END LOOP;

  -- Content, importance and identity are fixed, even for the owner.
  FOREACH r IN ARRAY ARRAY['content = content || ''!''', 'importance = 2', 'account_id = ' || quote_literal(b_acct),
                           'scope_id = ' || quote_literal(c2), 'trust = ''verified''', 'expires_at = expires_at - interval ''1 day''',
                           'kind = ''decision'''] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('memory_items: UPDATE SET %s accepted as the owner', r),
      NULL, NULL, format('UPDATE memory_items SET %s WHERE id = %L', r, x2), 'ERROR 42501 %UPDATE refused%');
  END LOOP;

  -- ---------- cap eviction (c4, cap 3) ----------
  -- v1 verified imp 1 (old), s1 superseded, l1 live imp 1, l2 live imp 2.
  ids := ARRAY[pg_temp.mi(a_acct, 'contact', c4, 'v1', 1, 'verified', 'fact', interval '10 days'),
               pg_temp.mi(a_acct, 'contact', c4, 's1', 2, 'untrusted', 'fact', interval '9 days'),
               pg_temp.mi(a_acct, 'contact', c4, 'l1', 1, 'untrusted', 'fact', interval '1 day'),
               pg_temp.mi(a_acct, 'contact', c4, 'l2', 2, 'untrusted', 'fact', interval '1 day')];
  UPDATE memory_items SET superseded_by = ids[4] WHERE id = ids[2];
  SELECT * INTO rec FROM pg_temp.mp(a_acct, 'contact', c4, 'n1', 2, NULL, NULL, 3);
  x1 := rec.item_id;
  n := n + 1; failed := failed || pg_temp.cs_ok(rec.evicted = 2
      AND (SELECT array_agg(content ORDER BY content) FROM memory_items WHERE scope_id = c4) = ARRAY['l2', 'n1', 'v1'],
    format('memory_put: cap eviction did not take the superseded row, then the lowest importance x recency (evicted %s, left %s)',
      rec.evicted, (SELECT string_agg(content, ',' ORDER BY content) FROM memory_items WHERE scope_id = c4)));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM memory_audit WHERE scope_id = c4 AND action = 'evict' AND item_count = 1
       AND reason = 'scope cap' AND (detail->>'cap')::int = 3) = 2,
    'memory_put: each eviction is not audited (evict, scope cap)');
  SELECT * INTO rec FROM pg_temp.mp(a_acct, 'contact', c4, 'n2', 2, NULL, NULL, 3);
  n := n + 1; failed := failed || pg_temp.cs_ok(rec.evicted = 1
      AND (SELECT array_agg(content ORDER BY content) FROM memory_items WHERE scope_id = c4) = ARRAY['n1', 'n2', 'v1'],
    'memory_put: cap eviction did not take the older of two equal-importance items');
  n := n + 1; failed := failed || pg_temp.cs_check('memory_put: a cap reachable only by evicting a verified item was accepted',
    NULL, NULL, format('SELECT x.evicted::text FROM pg_temp.mp(%L, %L, %L, %L, 1, NULL, NULL, 1) x', a_acct,
      'contact', c4, 'n3'), 'ERROR 54000 %no evictable item%');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT array_agg(content ORDER BY content) FROM memory_items WHERE scope_id = c4) = ARRAY['n1', 'n2', 'v1'],
    'memory_put: a refused over-cap write changed the scope');

  -- ---------- recall ----------
  -- c1 holds x2 'Likes pear', x3 apple (live), the verified salary
  -- items; c2 holds x5 apple (not readable by u_agent).
  INSERT INTO memory_items (account_id, scope_type, scope_id, kind, content, content_hash, importance, source_type)
  VALUES (a_acct, 'contact', c1, 'fact', 'pear tea pear', pg_temp.h('pear tea pear'), 1, 'chat');
  PERFORM pg_temp.mi(a_acct, 'contact', c1, 'pear expired', 1, 'untrusted', 'fact', interval '25 months');
  SELECT count(*), sum(recall_count) INTO i, j FROM memory_items;
  SELECT count(*) INTO m FROM memory_audit;
  SELECT array_agg(x.id ORDER BY x.rank DESC, x.id) INTO ids
    FROM memory_recall_candidates(u_agent, a_acct, NULL, NULL, NULL, 100) x;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    x2 = ANY (ids) AND x3 = ANY (ids) AND NOT x1 = ANY (ids) AND NOT x5 = ANY (ids)
    AND NOT EXISTS (SELECT 1 FROM memory_items WHERE id = ANY (ids) AND (superseded_by IS NOT NULL OR expires_at <= now()
                                                                        OR scope_id NOT IN (c1, k1, a_acct))),
    'memory_recall_candidates: returned an unreadable, superseded or expired item, or missed a readable one');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM memory_recall_candidates(u_bown, a_acct, NULL, NULL, NULL, 100)) = 0
    AND (SELECT count(*) FROM memory_recall_candidates(u_guest, a_acct, NULL, NULL, NULL, 100)) = 0,
    'memory_recall_candidates: a non-member read the account''s items');
  SELECT array_agg(x.content ORDER BY o) INTO lbl
    FROM memory_recall_candidates(u_agent, a_acct, ARRAY['contact'], ARRAY[c1], to_tsquery('simple', 'pear | tea'), 10)
         WITH ORDINALITY AS x(id, scope_type, scope_id, kind, content, importance, trust, source_type, created_at,
                              last_recalled_at, embedding, rank, o);
  n := n + 1; failed := failed || pg_temp.cs_ok(lbl = ARRAY['pear tea pear', 'Likes pear'],
    format('memory_recall_candidates: a full-text query did not rank the better match first and drop non-matches (%s)', lbl));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM memory_items) = i AND (SELECT sum(recall_count) FROM memory_items) = j
    AND (SELECT count(*) FROM memory_audit) = m AND NOT EXISTS (SELECT 1 FROM memory_items WHERE last_recalled_at IS NOT NULL),
    'memory_recall_candidates: a read changed items, counters or the audit');
  INSERT INTO memory_items (account_id, scope_type, scope_id, kind, content, content_hash, importance, source_type,
                            created_at, expires_at)
  SELECT a_acct, 'workspace', a_acct, 'fact', 'ws ' || g, pg_temp.h('ws ' || g), 1, 'chat',
         now() - g * interval '1 minute', now() - g * interval '1 minute' + interval '24 months'
    FROM generate_series(1, 210) g;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM memory_recall_candidates(u_viewer, a_acct, NULL, NULL, NULL, 1000)) = 100
    AND (SELECT count(*) FROM memory_recall_candidates(u_viewer, a_acct, NULL, NULL, NULL, 0)) = 1,
    'memory_recall_candidates: the limit is not clamped to 1..100');

  SELECT count(*) INTO m FROM memory_audit WHERE action = 'recall';
  i := memory_mark_recalled(u_agent, a_acct, ARRAY[x3, x5, x1, gen_random_uuid(), x3]);
  n := n + 1; failed := failed || pg_temp.cs_ok(i = 1
      AND (SELECT recall_count FROM memory_items WHERE id = x3) = 1
      AND (SELECT last_recalled_at FROM memory_items WHERE id = x3) IS NOT NULL
      AND (SELECT recall_count FROM memory_items WHERE id = x5) = 0
      AND (SELECT recall_count FROM memory_items WHERE id = x1) = 0,
    format('memory_mark_recalled: did not bump only the live readable id (returned %s)', i));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM memory_audit WHERE action = 'recall') = m + 1
    AND EXISTS (SELECT 1 FROM memory_audit WHERE action = 'recall' AND actor = u_agent AND item_count = 1
                  AND (detail->>'requested')::int = 5),
    'memory_mark_recalled: the call is not audited once (requested 5, count 1)');
  i := memory_mark_recalled(u_agent, a_acct, '{}');
  n := n + 1; failed := failed || pg_temp.cs_ok(i = 0 AND (SELECT count(*) FROM memory_audit WHERE action = 'recall') = m + 2
      AND EXISTS (SELECT 1 FROM memory_audit WHERE action = 'recall' AND item_count = 0 AND (detail->>'requested')::int = 0),
    'memory_mark_recalled: an empty list is not audited');
  n := n + 1; failed := failed || pg_temp.cs_check('memory_mark_recalled: 101 ids were accepted', 'service_role', NULL,
    format('SELECT memory_mark_recalled(%L, %L, (SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 101)))::text',
      u_agent, a_acct), 'ERROR 22023 %at most 100 ids%');

  -- ---------- memory_list ----------
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM memory_list(u_viewer, a_acct, 'workspace', a_acct)) = 50
    AND (SELECT count(*) FROM memory_list(u_viewer, a_acct, 'workspace', a_acct, 0)) = 1
    AND (SELECT count(*) FROM memory_list(u_viewer, a_acct, 'workspace', a_acct, 1000)) = 200,
    'memory_list: the limit is not 50 by default, clamped to 1..200');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT bool_and(l.created_at > l.nxt) FROM (
       SELECT x.created_at, lead(x.created_at) OVER (ORDER BY x.o) AS nxt
         FROM memory_list(u_viewer, a_acct, 'workspace', a_acct, 200) WITH ORDINALITY AS x(id, kind, content, importance,
              trust, source_type, source_id, created_by, created_at, expires_at, recall_count, last_recalled_at, o)) l
      WHERE l.nxt IS NOT NULL)
    AND (SELECT max(x.created_at) FROM memory_list(u_viewer, a_acct, 'workspace', a_acct) x)
        = (SELECT max(created_at) FROM memory_items WHERE scope_id = a_acct),
    'memory_list: rows are not newest first');
  SELECT min(x.created_at) INTO ts FROM memory_list(u_viewer, a_acct, 'workspace', a_acct) x;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT max(x.created_at) FROM memory_list(u_viewer, a_acct, 'workspace', a_acct, 50, ts) x)
      = (SELECT max(created_at) FROM memory_items WHERE scope_id = a_acct AND created_at < ts)
    AND (SELECT count(*) FROM memory_list(u_viewer, a_acct, 'workspace', a_acct, 200, ts)) = 160,
    'memory_list: p_before does not page to the rows strictly older');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM memory_list(u_agent3, a_acct, 'contact', c1)) = 0
    AND (SELECT count(*) FROM memory_list(u_bown, a_acct, 'workspace', a_acct)) = 0
    AND (SELECT count(*) FROM memory_list(u_guest, a_acct, 'workspace', a_acct)) = 0,
    'memory_list: a non-reader got rows');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    NOT EXISTS (SELECT 1 FROM memory_list(u_agent, a_acct, 'contact', c1) x WHERE x.id = x1 OR x.content = 'pear expired')
    AND EXISTS (SELECT 1 FROM memory_list(u_agent, a_acct, 'contact', c1) x WHERE x.id = x3),
    'memory_list: a superseded or expired item is listed (or a live one is not)');
  n := n + 1; failed := failed || pg_temp.cs_check('memory_list as service_role does not list the scope',
    'service_role', NULL, format('SELECT count(*)::text FROM memory_list(%L, %L, %L, %L)', u_agent, a_acct, 'contact', c1),
    '4');

  -- ---------- erasure ----------
  PERFORM pg_temp.mp(a_acct, 'contact', c3, 'c3 one', 1, NULL, NULL, 100);
  PERFORM pg_temp.mp(a_acct, 'contact', c3, 'c3 two', 1, NULL, NULL, 100);
  SELECT count(*) INTO j FROM memory_items WHERE scope_id = c1;
  FOREACH r IN ARRAY ARRAY['', '   ', E'\t\n'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('memory_forget: the blank reason %L was accepted', r),
      'service_role', NULL, format('SELECT memory_forget(%L, %L, %L, %L, %L)::text', u_owner, a_acct, 'contact', c3, r),
      'ERROR 22023 %reason%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_check('memory_forget: a reason over 1000 characters was accepted',
    'service_role', NULL, format('SELECT memory_forget(%L, %L, %L, %L, %L)::text', u_owner, a_acct, 'contact', c3,
      repeat('r', 1001)), 'ERROR 22023 %reason%');
  n := n + 1; failed := failed || pg_temp.cs_ok((SELECT count(*) FROM memory_items WHERE scope_id = c3) = 2
      AND NOT EXISTS (SELECT 1 FROM memory_audit WHERE scope_id = c3 AND action = 'forget'),
    'memory_forget: a refused call erased or audited');
  i := memory_forget(u_owner, a_acct, 'contact', c3, 'customer asked');
  n := n + 1; failed := failed || pg_temp.cs_ok(i = 2 AND NOT EXISTS (SELECT 1 FROM memory_items WHERE scope_id = c3)
      AND (SELECT count(*) FROM memory_audit WHERE scope_id = c3 AND action = 'forget') = 1
      AND EXISTS (SELECT 1 FROM memory_audit WHERE scope_id = c3 AND action = 'forget' AND item_count = 2
                    AND actor = u_owner AND reason = 'customer asked'),
    'memory_forget: did not erase the scope with one audit row (count, actor, reason)');
  n := n + 1; failed := failed || pg_temp.cs_ok((SELECT count(*) FROM memory_items WHERE scope_id = c1) = j
      AND EXISTS (SELECT 1 FROM memory_items WHERE scope_id = c4),
    'memory_forget: touched another scope');
  i := memory_forget(u_owner, a_acct, 'contact', c3, repeat('r', 1000));
  n := n + 1; failed := failed || pg_temp.cs_ok(i = 0
      AND EXISTS (SELECT 1 FROM memory_audit WHERE scope_id = c3 AND action = 'forget' AND item_count = 0
                    AND char_length(reason) = 500),
    'memory_forget: a 1000-character reason on an empty scope is not audited (reason kept to 500)');

  -- TTL sweep: the expired c1 row plus one aged in c2.
  PERFORM pg_temp.mi(a_acct, 'contact', c2, 'c2 old a', 1, 'untrusted', 'fact', interval '25 months');
  PERFORM pg_temp.mi(a_acct, 'contact', c2, 'c2 old b', 1, 'untrusted', 'fact', interval '30 months');
  SELECT count(*) INTO j FROM memory_items WHERE expires_at > now();
  i := memory_expire_due(NULL);
  n := n + 1; failed := failed || pg_temp.cs_ok(i = 3 AND NOT EXISTS (SELECT 1 FROM memory_items WHERE expires_at <= now())
      AND (SELECT count(*) FROM memory_items) = j,
    format('memory_expire_due: did not remove exactly the expired rows (returned %s)', i));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM memory_audit WHERE action = 'expire') = 2
    AND EXISTS (SELECT 1 FROM memory_audit WHERE action = 'expire' AND scope_id = c2 AND item_count = 2 AND actor IS NULL
                  AND reason = 'ttl')
    AND EXISTS (SELECT 1 FROM memory_audit WHERE action = 'expire' AND scope_id = c1 AND item_count = 1),
    'memory_expire_due: not one audit row per scope with its count');

  -- A deleted contact takes its memory with it.
  PERFORM pg_temp.mp(a_acct, 'contact', c5, 'c5 one', 1, NULL, NULL, 100);
  PERFORM pg_temp.mp(a_acct, 'contact', c5, 'c5 two', 1, NULL, NULL, 100);
  DELETE FROM contacts WHERE id = c5;
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT EXISTS (SELECT 1 FROM memory_items WHERE scope_id = c5)
      AND (SELECT count(*) FROM memory_audit WHERE scope_id = c5 AND action = 'forget') = 1
      AND EXISTS (SELECT 1 FROM memory_audit WHERE scope_id = c5 AND action = 'forget' AND item_count = 2
                    AND actor IS NULL AND reason = 'contact deleted'),
    'contact delete: the contact''s memory was not erased with one forget audit row');
  n := n + 1; failed := failed || pg_temp.cs_check('contact delete: a contact without memory could not be deleted',
    NULL, NULL, format('DELETE FROM contacts WHERE id = %L', c6), 'ok');
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT EXISTS (SELECT 1 FROM contacts WHERE id = c6)
      AND NOT EXISTS (SELECT 1 FROM memory_audit WHERE scope_id = c6),
    'contact delete: a contact without memory left an audit row or survived');

  -- ---------- compaction (case k1) ----------
  ids := ARRAY[pg_temp.mi(a_acct, 'case', k1, 'k old 1', 1, 'untrusted', 'fact', interval '40 days'),
               pg_temp.mi(a_acct, 'case', k1, 'k old 2', 2, 'untrusted', 'preference', interval '39 days'),
               pg_temp.mi(a_acct, 'case', k1, 'k old 3', 1, 'untrusted', 'decision', interval '38 days')];
  PERFORM pg_temp.mi(a_acct, 'case', k1, 'k verified', 1, 'verified', 'fact', interval '40 days');
  PERFORM pg_temp.mi(a_acct, 'case', k1, 'k old summary', 1, 'untrusted', 'summary', interval '40 days');
  PERFORM pg_temp.mi(a_acct, 'case', k1, 'k fresh', 1, 'untrusted', 'fact', interval '1 day');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT array_agg(x.id ORDER BY x.created_at) FROM memory_compact_candidates(u_agent, a_acct, 'case', k1, 30, 100) x) = ids,
    'memory_compact_candidates: not exactly the live untrusted non-summary items older than N days, oldest first');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM memory_compact_candidates(u_agent3, a_acct, 'case', k1, 30, 100)) = 0
    AND (SELECT count(*) FROM memory_compact_candidates(u_bown, a_acct, 'case', k1, 30, 100)) = 0,
    'memory_compact_candidates: a non-reader got candidates');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM memory_compact_candidates(u_agent, a_acct, 'case', k1, 30, 2)) = 2,
    'memory_compact_candidates: p_limit is not applied');
  SELECT * INTO rec FROM memory_compact_apply(a_acct, 'case', k1, ids, 'k summary', pg_temp.h('k summary'), u_agent);
  x1 := rec.summary_id;
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT rec.deduped AND rec.superseded = 3
      AND EXISTS (SELECT 1 FROM memory_items WHERE id = x1 AND kind = 'summary' AND trust = 'untrusted' AND importance = 2
                    AND superseded_by IS NULL AND content = 'k summary')
      AND (SELECT count(*) FROM memory_items WHERE id = ANY (ids) AND superseded_by = x1) = 3,
    'memory_compact_apply: did not insert one summary and supersede every source');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM memory_audit WHERE scope_id = k1 AND action = 'compact') = 1
    AND EXISTS (SELECT 1 FROM memory_audit WHERE scope_id = k1 AND action = 'compact' AND item_count = 3
                  AND (detail->>'requested')::int = 3 AND actor = u_agent),
    'memory_compact_apply: not audited once with its counts');
  x2 := pg_temp.mi(a_acct, 'case', k1, 'k old 4', 1, 'untrusted', 'fact', interval '35 days');
  x3 := pg_temp.mi(a_acct, 'case', k1, 'k old 5', 1, 'untrusted', 'fact', interval '34 days');
  PERFORM pg_temp.mp(a_acct, 'case', k1, 'k old 5 corrected', 1, NULL, x3, 100);
  SELECT count(*) INTO j FROM memory_items WHERE scope_id = k1;
  n := n + 1; failed := failed || pg_temp.cs_check('memory_compact_apply: a source no longer live did not raise 40001',
    'service_role', NULL, format('SELECT x.superseded::text FROM memory_compact_apply(%L, %L, %L, ARRAY[%L, %L]::uuid[], %L, %L, %L) x',
      a_acct, 'case', k1, x2, x3, 'k summary 2', pg_temp.h('k summary 2'), u_agent), 'ERROR 40001 %');
  n := n + 1; failed := failed || pg_temp.cs_ok((SELECT count(*) FROM memory_items WHERE scope_id = k1) = j
      AND (SELECT superseded_by FROM memory_items WHERE id = x2) IS NULL
      AND NOT EXISTS (SELECT 1 FROM memory_items WHERE content = 'k summary 2')
      AND (SELECT count(*) FROM memory_audit WHERE scope_id = k1 AND action = 'compact') = 1,
    'memory_compact_apply: a refused compaction changed something');

  -- ---------- locks ----------
  n := n + 1; failed := failed || pg_temp.cs_check('memory_items: a direct DELETE was accepted as the owner',
    NULL, NULL, format('DELETE FROM memory_items WHERE id = %L', x2), 'ERROR 42501 %DELETE refused%');
  n := n + 1; failed := failed || pg_temp.cs_check('memory_items: TRUNCATE was accepted as the owner',
    NULL, NULL, 'TRUNCATE memory_items', 'ERROR 42501 %append-only%');
  n := n + 1; failed := failed || pg_temp.cs_check('memory_items: an INSERT with recall counters was accepted',
    NULL, NULL, format($q$INSERT INTO memory_items (account_id, scope_type, scope_id, kind, content, content_hash,
      importance, source_type, recall_count) VALUES (%L, 'contact', %L, 'fact', 'pre', %L, 1, 'chat', 3)$q$,
      a_acct, c1, pg_temp.h('pre')), 'ERROR 42501 %inserted fresh%');
  FOREACH r IN ARRAY ARRAY['UPDATE memory_audit SET item_count = item_count + 1', 'DELETE FROM memory_audit',
                           'TRUNCATE memory_audit'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('memory_audit: %s accepted as the owner', r),
      NULL, NULL, r, 'ERROR 42501 %append-only%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_check('memory_acl: DELETE accepted as the owner',
    NULL, NULL, 'DELETE FROM memory_acl', 'ERROR 42501 %never removed%');
  n := n + 1; failed := failed || pg_temp.cs_check('memory_acl: TRUNCATE accepted as the owner',
    NULL, NULL, 'TRUNCATE memory_acl', 'ERROR 42501 %append-only%');
  n := n + 1; failed := failed || pg_temp.cs_check('memory_acl: a revoked row was reopened as the owner',
    NULL, NULL, 'UPDATE memory_acl SET revoked_at = NULL WHERE revoked_at IS NOT NULL', 'ERROR 42501 %only change%');
  n := n + 1; failed := failed || pg_temp.cs_check('memory_acl: a role was changed as the owner',
    NULL, NULL, 'UPDATE memory_acl SET role = ''super_admin'' WHERE revoked_at IS NULL', 'ERROR 42501 %only change%');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM memory_acl) = 3 AND (SELECT count(*) FROM memory_audit) > 0,
    'a lock probe removed rows');

  -- ---------- grants ----------
  FOREACH r IN ARRAY ARRAY['service_role', 'authenticated', 'anon'] LOOP
    SELECT string_agg(t || ':' || p, ',' ORDER BY t, p) INTO p1
      FROM unnest(tbls) t, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
     WHERE has_table_privilege(r, 'public.' || t, p);
    SELECT string_agg(s || ':' || p, ',' ORDER BY s, p) INTO p2
      FROM unnest(ARRAY['memory_acl_id_seq', 'memory_audit_id_seq']) s, unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) p
     WHERE has_sequence_privilege(r, 'public.' || s, p);
    n := n + 1; failed := failed || pg_temp.cs_ok(p1 IS NULL AND p2 IS NULL,
      format('%s holds a privilege on a memory table or sequence (%s %s)', r, p1, p2));
    SELECT string_agg(p.proname, ',' ORDER BY p.proname) INTO p3 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'memory\_%'
       AND has_function_privilege(r, p.oid, 'EXECUTE');
    n := n + 1; failed := failed || pg_temp.cs_ok(
      p3 IS NOT DISTINCT FROM CASE r WHEN 'service_role' THEN array_to_string(api_fns, ',') END,
      format('%s executes the wrong memory functions (%s)', r, p3));
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname = ANY (api_fns || priv_fns)) = 15
    AND NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (priv_fns)
        AND (has_function_privilege('service_role', p.oid, 'EXECUTE')
             OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
             OR has_function_privilege('anon', p.oid, 'EXECUTE'))),
    'a private memory function is executable by an API role (or a function is missing)');
  n := n + 1; failed := failed || pg_temp.cs_ok(EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'public.contacts'::regclass AND tgenabled <> 'D'
        AND tgfoid = 'public.memory_forget_deleted_contact()'::regprocedure),
    'contacts has no enabled memory erasure trigger');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT129', MESSAGE = 'verify-crm-memory rollback';
  EXCEPTION WHEN SQLSTATE 'ZT129' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'CRM memory verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'CRM memory verification passed (% checks)', n;
END
$verify$;
