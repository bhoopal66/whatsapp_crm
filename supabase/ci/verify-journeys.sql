-- Behavioural regression suite for the journey bot host (migration 086).
--
-- journey_commit() is the engine's JourneyStore.commit: the file at
-- version+1, the processed event id and the actions as pending outbox
-- rows land together or not at all, a replayed event id answers
-- 'duplicate' before the version is compared (a redelivered webhook
-- must not look like a race), and a stale version answers 'conflict'.
-- Around it: the next_timer_at / closed_at projections, one open file
-- per contact, the pending opt-out the delivery-time consent re-check
-- reads, the once-ever opt-in welcome claim, the consent guard and its
-- append-only history on contacts, RLS that follows the contact's
-- visibility, grants that keep every writer but the service role out,
-- and admin-only journey settings. All of it is a SECURITY DEFINER
-- function, a trigger, an index, a CHECK, RLS or a grant, none of
-- which `npm test` can reach.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000086001';
  u_admin  UUID := '00000000-0000-4000-8000-000000086002';
  u_agent  UUID := '00000000-0000-4000-8000-000000086003';
  u_agent2 UUID := '00000000-0000-4000-8000-000000086004';
  u_view   UUID := '00000000-0000-4000-8000-000000086005';
  u_other  UUID := '00000000-0000-4000-8000-000000086006';  -- account B owner
  a_acct   UUID;
  b_acct   UUID;
  c_j      UUID;  -- owner's contact: the commit protocol
  c_po     UUID;  -- owner's contact: pending opt-out across two files
  c_w      UUID;  -- owner's contact: the opt-in welcome claim
  c_none   UUID;  -- owner's contact with no journey and no claim
  c_agent  UUID;  -- the agent's own contact (visible to them)
  c_conv   UUID;  -- owner's contact in a chat assigned to the agent (visible)
  c_agent2 UUID;  -- agent 2's contact, no chat (invisible to the agent)
  c_view   UUID;  -- the viewer's own contact
  c_ins    UUID;  -- inserted by the agent already opted in
  c_del    UUID;  -- deleted to show the history cascades
  c_b      UUID;  -- account B's contact
  c_stop   UUID;  -- owner's contact: STOP committed while journeys are off
  c_rs     UUID;  -- owner's contact: a resubscribe delivered late
  c_ss     UUID;  -- owner's contact: STOP then START, both still pending
  s1       UUID := gen_random_uuid();
  s2       UUID := gen_random_uuid();
  s3       UUID := gen_random_uuid();
  ob4      UUID;  -- SET_OPT_OUT items of s1..s3
  ob5      UUID;
  ob6      UUID;
  ob7      UUID;
  cv       UUID;
  f1       UUID := gen_random_uuid();
  f2       UUID := gen_random_uuid();
  p1       UUID := gen_random_uuid();
  p2       UUID := gen_random_uuid();
  fm       UUID := gen_random_uuid();  -- never inserted
  ob1      UUID;  -- outbox items for the delivery claim and the welcome cap
  ob2      UUID;
  ob3      UUID;
  wf       TEXT := 'taamul_welcome_to_close.v1';
  a_send   JSONB := '{"type":"SEND","template":"t","category":"UTILITY","billable":false,"notBefore":"2026-03-02T05:00:00Z"}';
  a_timer  JSONB := '{"type":"SET_TIMER","kind":"k","fireAt":"2026-03-03T09:00:00Z"}';
  a_send0  JSONB := '{"type":"SEND","template":"t0","category":"UTILITY","billable":false}';
  a_send2  JSONB := '{"type":"SEND","template":"t2","category":"MARKETING","billable":true,"notBefore":"2026-03-04T06:30:00Z"}';
  s0       TEXT;
  r        TEXT;
  x        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
  -- Section 10 (drain fairness): files q1..q4 in account A, qb in B.
  q1 UUID := gen_random_uuid();
  q2 UUID := gen_random_uuid();
  q3 UUID := gen_random_uuid();
  q4 UUID := gen_random_uuid();
  qb UUID := gen_random_uuid();
  cq1 UUID; cq2 UUID; cq3 UUID; cq4 UUID; cqb UUID;
  oq1 UUID; oq4 UUID;
  t_later TIMESTAMPTZ := date_trunc('second', now()) + interval '3 hours';
BEGIN
  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given;
  -- the block's own role, RLS bypassed, when p_role is NULL): the value
  -- of a SELECT, the row count of anything else, or the error as
  -- 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.jv_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; c bigint;
    BEGIN
      BEGIN
        IF p_role IS NOT NULL OR p_uid IS NOT NULL THEN
          PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', coalesce(p_role, 'authenticated'))::text, true);
        END IF;
        IF p_role IS NOT NULL THEN
          EXECUTE format('SET LOCAL ROLE %I', p_role);
        END IF;
        IF p_sql ILIKE 'select%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
          GET DIAGNOSTICS c = ROW_COUNT;
          v := c::text;
        END IF;
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

  -- journey_commit() as the runner calls it: on the service role.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.jv_commit(p_file uuid, p_version integer, p_body jsonb,
                                      p_event text, p_actions jsonb)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      RETURN pg_temp.jv_try('service_role', NULL, format(
        'SELECT public.journey_commit(%L::uuid, %L::integer, %L::jsonb, %L::text, %L::jsonb)',
        p_file, p_version, p_body, p_event, p_actions));
    END $body$
  $fn$;

  -- An engine JourneyFile.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.jv_body(p_id uuid, p_contact uuid, p_acct uuid, p_state text,
      p_product text DEFAULT NULL, p_entry text DEFAULT NULL,
      p_outcome jsonb DEFAULT 'null', p_timers jsonb DEFAULT '[]')
    RETURNS jsonb LANGUAGE sql AS $body$
      SELECT jsonb_build_object(
        'id', p_id, 'contactId', p_contact, 'workspaceId', p_acct,
        'product', p_product, 'entry', p_entry, 'state', p_state,
        'prevOpenState', NULL, 'window', '{}'::jsonb, 'counters', '{}'::jsonb,
        'timers', p_timers, 'validUntil', '{}'::jsonb, 'outcome', p_outcome,
        'optedOut', false, 'history', '[]'::jsonb, 'version', 0)
    $body$
  $fn$;

  -- A file's projections: "version/body.version/state/product/entry/outcome/open|closed".
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.jv_proj(p_file uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT coalesce((
        SELECT version || '/' || coalesce(body ->> 'version', '-') || '/' || state || '/'
               || coalesce(product, '-') || '/' || coalesce(entry, '-') || '/'
               || coalesce(outcome_kind, '-') || '/'
               || CASE WHEN closed_at IS NULL THEN 'open' ELSE 'closed' END
        FROM public.journey_files WHERE id = p_file), 'missing')
    $body$
  $fn$;

  -- Everything a commit writes for a file, to show a refused one wrote nothing.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.jv_snap(p_file uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT coalesce((
        SELECT 'v' || version || '/' || state || '/' || left(md5(body::text), 8)
               || '/' || coalesce(next_timer_at::text, '-') || '/' || coalesce(closed_at::text, '-')
        FROM public.journey_files WHERE id = p_file), 'missing')
        || '/outbox ' || (SELECT count(*) FROM public.journey_outbox WHERE file_id = p_file)
        || '/events ' || (SELECT count(*) FROM public.journey_processed_events WHERE file_id = p_file)
    $body$
  $fn$;

  -- A file's outbox as "seq:type:status:not_before,...".
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.jv_outbox(p_file uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT coalesce(string_agg(seq || ':' || (action ->> 'type') || ':' || status || ':'
               || coalesce(to_char(not_before AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '-'),
               ',' ORDER BY seq), '')
      FROM public.journey_outbox WHERE file_id = p_file
    $body$
  $fn$;

  -- A contact's consent history as a sorted "kind/source/actor;..."
  -- (every event of one transaction shares `at`, so order by content).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.jv_events(p_contact uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT coalesce(string_agg(e.kind || '/' || e.source || '/'
               || coalesce(split_part(u.email, '@', 1), e.actor_user_id::text, '-'), ';'
               ORDER BY e.kind COLLATE "C", e.source COLLATE "C", u.email COLLATE "C"), '')
      FROM public.contact_consent_events e
      LEFT JOIN auth.users u ON u.id = e.actor_user_id
      WHERE e.contact_id = p_contact
    $body$
  $fn$;

  -- Fixture: account A (owner, admin, two agents, viewer), account B.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'jv-owner@example.invalid'),
    (u_admin,  'jv-admin@example.invalid'),
    (u_agent,  'jv-agent@example.invalid'),
    (u_agent2, 'jv-agent2@example.invalid'),
    (u_view,   'jv-view@example.invalid'),
    (u_other,  'jv-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin'  WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'  WHERE user_id = u_agent;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'  WHERE user_id = u_agent2;
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_view;

  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500086001', 'JV journey') RETURNING id INTO c_j;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500086002', 'JV pending opt-out') RETURNING id INTO c_po;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500086003', 'JV welcome') RETURNING id INTO c_w;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500086004', 'JV none') RETURNING id INTO c_none;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500086005', 'JV agent') RETURNING id INTO c_agent;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500086006', 'JV in agent chat') RETURNING id INTO c_conv;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent2, '971500086007', 'JV agent 2') RETURNING id INTO c_agent2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_view, '971500086008', 'JV viewer') RETURNING id INTO c_view;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500086009', 'JV deleted') RETURNING id INTO c_del;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b_acct, u_other, '971500086010', 'JV account B') RETURNING id INTO c_b;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500086201', 'JV stop') RETURNING id INTO c_stop;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500086202', 'JV late resubscribe') RETURNING id INTO c_rs;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500086203', 'JV stop start') RETURNING id INTO c_ss;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, c_conv, u_agent) RETURNING id INTO cv;

  -- ================= 1–3. journey_commit, projections, one open file =================
  INSERT INTO journey_files (id, account_id, contact_id, workflow_key, state, body, version)
  VALUES (f1, a_acct, c_j, wf, 'NEW', pg_temp.jv_body(f1, c_j, a_acct, 'NEW'), 0);

  -- A second open file for the contact is refused.
  r := pg_temp.jv_try(NULL, NULL, format(
    'INSERT INTO journey_files (account_id, contact_id, workflow_key, state, body) VALUES (%L, %L, %L, %L, %L)',
    a_acct, c_j, wf, 'NEW', '{}'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23505:%' THEN
    failed := array_append(failed, ('second open file for a contact: ' || r)::text);
  END IF;

  -- Commit 1: three actions, two timers out of order.
  r := pg_temp.jv_commit(f1, 0,
    pg_temp.jv_body(f1, c_j, a_acct, 'QUALIFY', 'POS', 'INBOUND', 'null',
      '[{"kind":"late","fireAt":"2026-03-05T10:00:00Z"},{"kind":"early","fireAt":"2026-03-03T09:00:00Z"}]'),
    'ev-1', jsonb_build_array(a_send, a_timer, a_send0));
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('first commit: ' || r)::text);
  END IF;
  r := pg_temp.jv_proj(f1);
  n := n + 1;
  IF r <> '1/1/QUALIFY/POS/INBOUND/-/open' THEN
    failed := array_append(failed, ('first commit projections (version/body.version/state/product/entry/outcome/closed): ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT next_timer_at FROM journey_files WHERE id = f1) IS DISTINCT FROM '2026-03-03T09:00:00Z'::timestamptz THEN
    failed := array_append(failed, ('next_timer_at is not the earliest timer: '
      || coalesce((SELECT next_timer_at::text FROM journey_files WHERE id = f1), 'NULL'))::text);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM journey_processed_events WHERE file_id = f1 AND event_id = 'ev-1') <> 1 THEN
    failed := array_append(failed, 'first commit did not record its event id'::text);
  END IF;
  r := pg_temp.jv_outbox(f1);
  n := n + 1;
  IF r <> '1:SEND:pending:2026-03-02T05:00:00Z,2:SET_TIMER:pending:-,3:SEND:pending:-' THEN
    failed := array_append(failed, ('first commit outbox (only a SEND''s notBefore is copied): ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT action FROM journey_outbox WHERE file_id = f1 AND seq = 1) IS DISTINCT FROM a_send
     OR EXISTS (SELECT 1 FROM journey_outbox WHERE file_id = f1 AND account_id <> a_acct) THEN
    failed := array_append(failed, 'outbox rows do not carry the action verbatim and the file''s account'::text);
  END IF;

  -- Commit 2: seq continues, no timers.
  r := pg_temp.jv_commit(f1, 1, pg_temp.jv_body(f1, c_j, a_acct, 'OFFER', 'POS', 'INBOUND'),
    'ev-2', jsonb_build_array(a_timer, a_send2));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.jv_proj(f1) <> '2/2/OFFER/POS/INBOUND/-/open' THEN
    failed := array_append(failed, ('second commit: ' || r || ' ' || pg_temp.jv_proj(f1))::text);
  END IF;
  r := pg_temp.jv_outbox(f1);
  n := n + 1;
  IF r <> '1:SEND:pending:2026-03-02T05:00:00Z,2:SET_TIMER:pending:-,3:SEND:pending:-,4:SET_TIMER:pending:-,5:SEND:pending:2026-03-04T06:30:00Z' THEN
    failed := array_append(failed, ('second commit''s seq does not continue: ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT next_timer_at FROM journey_files WHERE id = f1) IS NOT NULL THEN
    failed := array_append(failed, 'next_timer_at is not NULL with no timers'::text);
  END IF;

  -- A replayed event id at the current version: duplicate, nothing written.
  s0 := pg_temp.jv_snap(f1);
  r := pg_temp.jv_commit(f1, 2, pg_temp.jv_body(f1, c_j, a_acct, 'REPLAYED'), 'ev-2', jsonb_build_array(a_send));
  n := n + 1;
  IF r <> 'duplicate' THEN
    failed := array_append(failed, ('replayed event id: ' || r)::text);
  END IF;
  n := n + 1;
  IF pg_temp.jv_snap(f1) <> s0 THEN
    failed := array_append(failed, ('replayed event id wrote: ' || s0 || ' -> ' || pg_temp.jv_snap(f1))::text);
  END IF;

  -- A stale version with a new event id: conflict, nothing written.
  r := pg_temp.jv_commit(f1, 1, pg_temp.jv_body(f1, c_j, a_acct, 'STALE'), 'ev-3', jsonb_build_array(a_send));
  n := n + 1;
  IF r <> 'conflict' THEN
    failed := array_append(failed, ('stale version: ' || r)::text);
  END IF;
  n := n + 1;
  IF pg_temp.jv_snap(f1) <> s0 THEN
    failed := array_append(failed, ('stale version wrote: ' || s0 || ' -> ' || pg_temp.jv_snap(f1))::text);
  END IF;

  -- A replayed event id with the version it was first committed at: a
  -- redelivery must not look like a race.
  r := pg_temp.jv_commit(f1, 0, pg_temp.jv_body(f1, c_j, a_acct, 'REPLAYED'), 'ev-1', jsonb_build_array(a_send));
  n := n + 1;
  IF r <> 'duplicate' THEN
    failed := array_append(failed, ('duplicate reported even when the version mismatches: got ' || r)::text);
  END IF;
  n := n + 1;
  IF pg_temp.jv_snap(f1) <> s0 THEN
    failed := array_append(failed, ('replay with a mismatched version wrote: ' || s0 || ' -> ' || pg_temp.jv_snap(f1))::text);
  END IF;

  -- A missing file is a conflict.
  r := pg_temp.jv_commit(fm, 0, pg_temp.jv_body(fm, c_j, a_acct, 'NEW'), 'ev-m', '[]');
  n := n + 1;
  IF r <> 'conflict' THEN
    failed := array_append(failed, ('commit of a missing file: ' || r)::text);
  END IF;

  -- Malformed: the body names another file; another contact.
  r := pg_temp.jv_commit(f1, 2, pg_temp.jv_body(fm, c_j, a_acct, 'X'), 'ev-4', '[]');
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023:%' THEN
    failed := array_append(failed, ('commit whose body names another file: ' || r)::text);
  END IF;
  r := pg_temp.jv_commit(f1, 2, pg_temp.jv_body(f1, c_none, a_acct, 'X'), 'ev-5', '[]');
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023:%' THEN
    failed := array_append(failed, ('commit moving a file to another contact: ' || r)::text);
  END IF;
  n := n + 1;
  IF pg_temp.jv_snap(f1) <> s0 THEN
    failed := array_append(failed, ('a malformed commit wrote: ' || s0 || ' -> ' || pg_temp.jv_snap(f1))::text);
  END IF;

  -- PARKED stays open (and an empty action list adds no outbox row).
  r := pg_temp.jv_commit(f1, 2, pg_temp.jv_body(f1, c_j, a_acct, 'PARKED', 'POS', 'INBOUND',
    '{"kind":"PARKED","reason":"x"}'), 'ev-6', '[]');
  n := n + 1;
  IF r <> 'ok' OR pg_temp.jv_proj(f1) <> '3/3/PARKED/POS/INBOUND/PARKED/open'
     OR (SELECT count(*) FROM journey_outbox WHERE file_id = f1) <> 5 THEN
    failed := array_append(failed, ('PARKED commit (must stay open): ' || r || ' ' || pg_temp.jv_proj(f1))::text);
  END IF;

  -- WON closes the file ...
  r := pg_temp.jv_commit(f1, 3, pg_temp.jv_body(f1, c_j, a_acct, 'WON', 'POS', 'INBOUND',
    '{"kind":"WON","reason":"x"}'), 'ev-7', '[]');
  n := n + 1;
  IF r <> 'ok' OR pg_temp.jv_proj(f1) <> '4/4/WON/POS/INBOUND/WON/closed' THEN
    failed := array_append(failed, ('WON commit (must close): ' || r || ' ' || pg_temp.jv_proj(f1))::text);
  END IF;

  -- ... after which the contact may open another, whose seq starts at 1.
  r := pg_temp.jv_try(NULL, NULL, format(
    'INSERT INTO journey_files (id, account_id, contact_id, workflow_key, state, body) VALUES (%L, %L, %L, %L, %L, %L)',
    f2, a_acct, c_j, wf, 'NEW', pg_temp.jv_body(f2, c_j, a_acct, 'NEW')));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('new open file once the first is closed: ' || r)::text);
  END IF;
  r := pg_temp.jv_commit(f2, 0, pg_temp.jv_body(f2, c_j, a_acct, 'LOST', 'LOAN', 'COLD',
    '{"kind":"NOT_WON","reason":"x"}'), 'ev-1', jsonb_build_array(a_send0));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.jv_proj(f2) <> '1/1/LOST/LOAN/COLD/NOT_WON/closed'
     OR pg_temp.jv_outbox(f2) <> '1:SEND:pending:-' THEN
    failed := array_append(failed, ('NOT_WON commit on a second file (must close; seq per file; event ids per file): '
      || r || ' ' || pg_temp.jv_proj(f2) || ' ' || pg_temp.jv_outbox(f2))::text);
  END IF;

  -- ================= 4. journey_pending_opt_out =================
  -- File 1 commits opt-out (at seq 2), then file 2 opts back in (at
  -- seq 1): the latest commit wins, not the highest seq.
  INSERT INTO journey_files (id, account_id, contact_id, workflow_key, state, body)
  VALUES (p1, a_acct, c_po, wf, 'NEW', pg_temp.jv_body(p1, c_po, a_acct, 'NEW'));
  r := pg_temp.jv_commit(p1, 0, pg_temp.jv_body(p1, c_po, a_acct, 'STOPPED', NULL, NULL,
    '{"kind":"NOT_WON","reason":"opted out"}'), 'po-1',
    jsonb_build_array(a_send0, '{"type":"SET_OPT_OUT","optedOut":true}'::jsonb));
  INSERT INTO journey_files (id, account_id, contact_id, workflow_key, state, body)
  VALUES (p2, a_acct, c_po, wf, 'NEW', pg_temp.jv_body(p2, c_po, a_acct, 'NEW'));
  x := pg_temp.jv_commit(p2, 0, pg_temp.jv_body(p2, c_po, a_acct, 'NEW'), 'po-2',
    jsonb_build_array('{"type":"SET_OPT_OUT","optedOut":false}'::jsonb));
  n := n + 1;
  IF r <> 'ok' OR x <> 'ok' THEN
    failed := array_append(failed, ('pending opt-out fixture commits: ' || r || ', ' || x)::text);
  END IF;
  r := pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_pending_opt_out(%L)::text', c_po));
  n := n + 1;
  IF r <> 'false' THEN
    failed := array_append(failed, ('pending opt-out is not the latest commit''s: ' || r)::text);
  END IF;
  r := pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_pending_opt_out(%L)::text', c_none));
  x := pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_pending_opt_out(%L)::text', c_j));
  n := n + 1;
  IF r <> 'null' OR x <> 'null' THEN
    failed := array_append(failed, ('pending opt-out of a contact with none: ' || r || ', ' || x)::text);
  END IF;
  UPDATE journey_outbox SET status = 'delivered', delivered_at = now()
  WHERE file_id = p2 AND action ->> 'type' = 'SET_OPT_OUT';
  r := pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_pending_opt_out(%L)::text', c_po));
  n := n + 1;
  IF r <> 'true' THEN
    failed := array_append(failed, ('pending opt-out once the latest is delivered: ' || r)::text);
  END IF;
  UPDATE journey_outbox SET status = 'delivered', delivered_at = now()
  WHERE file_id = p1 AND action ->> 'type' = 'SET_OPT_OUT';
  r := pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_pending_opt_out(%L)::text', c_po));
  n := n + 1;
  IF r <> 'null' THEN
    failed := array_append(failed, ('pending opt-out once both are delivered: ' || r)::text);
  END IF;

  -- ================= 5. journey_claim_optin_welcome =================
  r := pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_claim_optin_welcome(%L, %L)::text', c_w, 'a'))
    || ',' || pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_claim_optin_welcome(%L, %L)::text', c_w, 'a'))
    || ',' || pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_claim_optin_welcome(%L, %L)::text', c_w, 'b'));
  n := n + 1;
  IF r <> 'true,true,false' THEN
    failed := array_append(failed, ('opt-in welcome claims a, a again, b: ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT string_agg(claim_id || '/' || (account_id = a_acct)::text, ',') FROM journey_optin_claims WHERE contact_id = c_w)
       IS DISTINCT FROM 'a/true'
     OR EXISTS (SELECT 1 FROM journey_optin_claims WHERE contact_id = c_none) THEN
    failed := array_append(failed, 'hasReceived: the claim row is not exactly the first claim, or exists unclaimed'::text);
  END IF;
  r := pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_claim_optin_welcome(%L, %L)::text', fm, 'a'));
  x := pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_claim_optin_welcome(%L, %L)::text', c_none, ''));
  n := n + 1;
  IF r <> 'false' OR EXISTS (SELECT 1 FROM journey_optin_claims WHERE contact_id = fm)
     OR x NOT LIKE 'ERROR 22023:%' THEN
    failed := array_append(failed, ('claim for an unknown contact / with an empty id: ' || r || ', ' || x)::text);
  END IF;

  -- ================= 5b. delivery claims, opt-out writes, the welcome cap =================
  INSERT INTO journey_outbox (file_id, account_id, seq, action) VALUES (f1, a_acct, 9001, a_send0) RETURNING id INTO ob1;
  INSERT INTO journey_outbox (file_id, account_id, seq, action, status, drop_reason)
  VALUES (f1, a_acct, 9002, a_send0, 'dropped', 'OPTED_OUT') RETURNING id INTO ob2;
  r := pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_claim_delivery(%L)', ob1))
    || ',' || pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_claim_delivery(%L)', ob1));
  -- A separate statement: a subquery in the line above reads the snapshot taken before the claims.
  r := r || ',' || (SELECT attempts || '/' || (sending_at IS NOT NULL)::text FROM journey_outbox WHERE id = ob1);
  UPDATE journey_outbox SET sending_at = now() - interval '3 minutes' WHERE id = ob1;
  r := r || ',' || pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_claim_delivery(%L)', ob1));
  UPDATE journey_outbox SET delivery_ref = 'wamid.1' WHERE id = ob1;
  r := r || ',' || pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_claim_delivery(%L)', ob1))
    || ',' || pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_claim_delivery(%L)', ob2));
  n := n + 1;
  IF r <> 'claimed,in_flight,1/true,stale,delivered,dropped' THEN
    failed := array_append(failed, ('delivery claim states (claimed, in_flight, attempts, stale, delivered, dropped): ' || r)::text);
  END IF;
  r := pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_claim_delivery(%L)', fm));
  x := pg_temp.jv_try('authenticated', u_admin, format('SELECT public.journey_claim_delivery(%L)', ob2));
  n := n + 1;
  IF r NOT LIKE 'ERROR P0002:%' OR x NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('delivery claim of an unknown item / by an admin: ' || r || ', ' || x)::text);
  END IF;

  -- F6b: a committed STOP reaches contacts.opted_out_at with the
  -- decision, while journeys are off and nothing drains the file; the
  -- pending item then drains harmlessly (same stamp, no new history).
  INSERT INTO journey_settings (account_id, enabled) VALUES (a_acct, false);
  INSERT INTO journey_files (id, account_id, contact_id, workflow_key, state, body)
  VALUES (s1, a_acct, c_stop, wf, 'NEW', pg_temp.jv_body(s1, c_stop, a_acct, 'NEW'));
  r := pg_temp.jv_commit(s1, 0, pg_temp.jv_body(s1, c_stop, a_acct, 'STOPPED', NULL, NULL,
    '{"kind":"NOT_WON","reason":"opted out"}'), 'stop-1',
    jsonb_build_array(a_send0, '{"type":"SET_OPT_OUT","optedOut":true}'::jsonb));
  SELECT id INTO ob4 FROM journey_outbox WHERE file_id = s1 AND action ->> 'type' = 'SET_OPT_OUT';
  r := r || ',' || coalesce((SELECT (c.opted_out_at = o.committed_at)::text
                             FROM contacts c, journey_outbox o WHERE c.id = c_stop AND o.id = ob4), 'unstamped')
    || ',' || (SELECT count(*) FROM public.journey_drain_candidates(now() + interval '1 day', 50) d WHERE d.file_id = s1)
    || ',' || coalesce((SELECT status FROM journey_outbox WHERE id = ob4), '-')
    || ',' || pg_temp.jv_events(c_stop);
  s0 := (SELECT opted_out_at::text FROM contacts WHERE id = c_stop);
  x := pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_set_opt_out(%L)::text', ob4));
  -- Separate statements: a subquery beside the call reads the snapshot taken before it.
  x := x || ',' || ((SELECT opted_out_at::text FROM contacts WHERE id = c_stop) IS NOT DISTINCT FROM s0)::text
    || ',' || pg_temp.jv_events(c_stop)
    || ',' || coalesce(nullif(current_setting('app.consent_source', true), ''), '-');
  DELETE FROM journey_settings WHERE account_id = a_acct;
  n := n + 1;
  IF r IS DISTINCT FROM 'ok,true,0,pending,opted_out/journey/-'
     OR x IS DISTINCT FROM 'true,true,opted_out/journey/-,-' THEN
    failed := array_append(failed, ('STOP committed with journeys off (commit,stamped at decision,candidates,item,history / redelivery,stamp kept,history,setting): '
      || r || ' / ' || x)::text);
  END IF;

  -- F6b: a resubscribe delivered late does not clear an opt-out taken
  -- since (the bot's, here); one decided after the stamp clears it.
  UPDATE contacts SET opted_out_at = '2026-01-01T00:00:00Z' WHERE id = c_rs;
  INSERT INTO journey_files (id, account_id, contact_id, workflow_key, state, body)
  VALUES (s2, a_acct, c_rs, wf, 'NEW', pg_temp.jv_body(s2, c_rs, a_acct, 'NEW'));
  r := pg_temp.jv_commit(s2, 0, pg_temp.jv_body(s2, c_rs, a_acct, 'NEW'), 'start-1',
    jsonb_build_array('{"type":"SET_OPT_OUT","optedOut":false}'::jsonb));
  SELECT id INTO ob5 FROM journey_outbox WHERE file_id = s2 AND action ->> 'type' = 'SET_OPT_OUT';
  r := r || ',' || (SELECT (opted_out_at IS NULL)::text FROM contacts WHERE id = c_rs);
  -- The decision was an hour ago; the bot opted the customer out since.
  UPDATE journey_outbox SET committed_at = now() - interval '1 hour' WHERE id = ob5;
  PERFORM set_config('app.consent_source', 'ai_bot', true);
  UPDATE contacts SET opted_out_at = now() WHERE id = c_rs;
  PERFORM set_config('app.consent_source', '', true);
  r := r || ',' || pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_set_opt_out(%L)::text', ob5));
  r := r || ',' || coalesce((SELECT (opted_out_at = now())::text FROM contacts WHERE id = c_rs), 'cleared')
    || ',' || pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_pending_opt_out(%L)::text', c_rs));
  -- A stamp older than the decision is cleared by it.
  UPDATE contacts SET opted_out_at = now() - interval '2 hours' WHERE id = c_rs;
  r := r || ',' || pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_pending_opt_out(%L)::text', c_rs))
    || ',' || pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_set_opt_out(%L)::text', ob5));
  r := r || ',' || (SELECT (opted_out_at IS NULL)::text FROM contacts WHERE id = c_rs);
  n := n + 1;
  IF r IS DISTINCT FROM 'ok,true,true,true,null,false,true,true'
     OR pg_temp.jv_events(c_rs) <>'opted_out/ai_bot/-;opted_out/system/-;opted_out/system/-;resubscribed/journey/-;resubscribed/journey/-' THEN
    failed := array_append(failed, ('late resubscribe (commit,cleared at commit,deliver,newer stamp kept,pending ignored / older stamp: pending,deliver,cleared): '
      || r || ' history: ' || pg_temp.jv_events(c_rs))::text);
  END IF;

  -- STOP then START, both still pending: delivering them in order
  -- leaves the customer resubscribed (the STOP does not stamp again).
  INSERT INTO journey_files (id, account_id, contact_id, workflow_key, state, body)
  VALUES (s3, a_acct, c_ss, wf, 'NEW', pg_temp.jv_body(s3, c_ss, a_acct, 'NEW'));
  r := pg_temp.jv_commit(s3, 0, pg_temp.jv_body(s3, c_ss, a_acct, 'NEW'), 'ss-1',
    jsonb_build_array(a_send0, '{"type":"SET_OPT_OUT","optedOut":true}'::jsonb))
    || ',' || pg_temp.jv_commit(s3, 1, pg_temp.jv_body(s3, c_ss, a_acct, 'NEW'), 'ss-2',
    jsonb_build_array('{"type":"SET_OPT_OUT","optedOut":false}'::jsonb));
  SELECT id INTO ob6 FROM journey_outbox WHERE file_id = s3 AND seq = 2;
  SELECT id INTO ob7 FROM journey_outbox WHERE file_id = s3 AND seq = 3;
  r := r || ',' || (SELECT (opted_out_at IS NULL)::text FROM contacts WHERE id = c_ss)
    || ',' || pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_set_opt_out(%L)::text', ob6))
    || ',' || pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_set_opt_out(%L)::text', ob7));
  r := r || ',' || (SELECT (opted_out_at IS NULL)::text FROM contacts WHERE id = c_ss);
  -- An admin's clear after an older pending STOP also stands.
  UPDATE journey_outbox SET committed_at = now() - interval '1 hour' WHERE id = ob4;
  x := pg_temp.jv_try('authenticated', u_admin, format('UPDATE contacts SET opted_out_at = NULL WHERE id = %L', c_stop))
    || ',' || pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_set_opt_out(%L)::text', ob4));
  x := x || ',' || (SELECT (opted_out_at IS NULL)::text FROM contacts WHERE id = c_stop);
  n := n + 1;
  IF r IS DISTINCT FROM 'ok,ok,true,true,true,true'
     OR pg_temp.jv_events(c_ss) <> 'opted_out/journey/-;resubscribed/journey/-'
     OR x IS DISTINCT FROM '1,true,true' THEN
    failed := array_append(failed, ('pending STOP then START (commits,resubscribed,deliver,deliver,still resubscribed) / admin clear then STOP redelivered: '
      || r || ' / ' || x || ' history: ' || pg_temp.jv_events(c_ss))::text);
  END IF;

  -- Delivery checks its item: unknown, not a SET_OPT_OUT, not the service role.
  r := pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_set_opt_out(%L)::text', fm))
    || ' | ' || pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_set_opt_out(%L)::text', ob1))
    || ' | ' || pg_temp.jv_try('authenticated', u_admin, format('SELECT public.journey_set_opt_out(%L)::text', ob5))
    || ' | ' || pg_temp.jv_try('service_role', NULL, format(
         'SELECT public.journey_apply_opt_out(%L, false, now())::text', c_rs))
    || ' | ' || pg_temp.jv_commit(f1, (SELECT version FROM journey_files WHERE id = f1), pg_temp.jv_body(f1, c_j, a_acct, 'NEW'),
         'bad-opt-out', '[{"type":"SET_OPT_OUT","optedOut":"yes"}]');
  n := n + 1;
  IF r NOT LIKE 'ERROR P0002:% | ERROR 22023:% | ERROR 42501:% | ERROR 42501:% | ERROR 22023:%' THEN
    failed := array_append(failed, ('journey_set_opt_out of an unknown item / a SEND / by an admin, journey_apply_opt_out by the service role, a non-boolean commit: ' || r)::text);
  END IF;

  -- journey_has_optin_welcome: a claim, or a committed MARK_OPTIN_WELCOME_SENT that is not dropped.
  r := pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_has_optin_welcome(%L)::text', c_w))
    || ',' || pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_has_optin_welcome(%L)::text', c_po));
  INSERT INTO journey_outbox (file_id, account_id, seq, action)
  VALUES (p1, a_acct, 9001, jsonb_build_object('type', 'MARK_OPTIN_WELCOME_SENT', 'contactId', c_po)) RETURNING id INTO ob3;
  r := r || ',' || pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_has_optin_welcome(%L)::text', c_po));
  UPDATE journey_outbox SET status = 'delivered' WHERE id = ob3;
  r := r || ',' || pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_has_optin_welcome(%L)::text', c_po));
  UPDATE journey_outbox SET status = 'dropped' WHERE id = ob3;
  r := r || ',' || pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_has_optin_welcome(%L)::text', c_po))
    || ',' || pg_temp.jv_try('authenticated', u_admin, format('SELECT public.journey_has_optin_welcome(%L)::text', c_w));
  n := n + 1;
  IF r NOT LIKE 'true,false,true,true,false,ERROR 42501:%' THEN
    failed := array_append(failed, ('opt-in welcome cap (claim, none, pending MARK, delivered MARK, dropped MARK, admin): ' || r)::text);
  END IF;

  -- ================= 6–7. consent guard and its history =================
  -- An opt-in needs a source, from anyone.
  r := pg_temp.jv_try('authenticated', u_agent, format(
    'UPDATE contacts SET marketing_opt_in_at = now() WHERE id = %L', c_agent));
  x := pg_temp.jv_try('authenticated', u_agent, format(
    'UPDATE contacts SET marketing_opt_in_at = now(), marketing_opt_in_source = %L WHERE id = %L', '  ', c_agent));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' OR x NOT LIKE 'ERROR 23514:%'
     OR (SELECT marketing_opt_in_at FROM contacts WHERE id = c_agent) IS NOT NULL THEN
    failed := array_append(failed, ('agent opt-in without a source: ' || r || ' / blank: ' || x)::text);
  END IF;

  r := pg_temp.jv_try('authenticated', u_agent, format(
    'UPDATE contacts SET marketing_opt_in_at = now(), marketing_opt_in_source = %L WHERE id = %L', 'whatsapp_button', c_agent));
  n := n + 1;
  IF r <> '1' OR (SELECT marketing_opt_in_at FROM contacts WHERE id = c_agent) IS NULL THEN
    failed := array_append(failed, ('agent opt-in on a visible contact: ' || r)::text);
  END IF;
  r := pg_temp.jv_events(c_agent);
  n := n + 1;
  IF r <> 'marketing_opt_in/manual/jv-agent' THEN
    failed := array_append(failed, ('history of an agent''s opt-in: ' || r)::text);
  END IF;

  -- A contact the agent cannot see: RLS hides it ...
  r := pg_temp.jv_try('authenticated', u_agent, format(
    'UPDATE contacts SET marketing_opt_in_at = now(), marketing_opt_in_source = %L WHERE id = %L', 'whatsapp_button', c_agent2));
  n := n + 1;
  IF r <> '0' OR (SELECT marketing_opt_in_at FROM contacts WHERE id = c_agent2) IS NOT NULL THEN
    failed := array_append(failed, ('agent opt-in on an invisible contact: ' || r)::text);
  END IF;
  -- ... and the guard refuses on its own: inserting someone else's contact opted in.
  r := pg_temp.jv_try('authenticated', u_agent, format(
    'INSERT INTO contacts (account_id, user_id, phone, name, marketing_opt_in_at, marketing_opt_in_source) VALUES (%L, %L, %L, %L, now(), %L)',
    a_acct, u_agent2, '971500086011', 'JV forged', 'whatsapp_button'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501: Only an agent who can see%'
     OR EXISTS (SELECT 1 FROM contacts WHERE phone = '971500086011') THEN
    failed := array_append(failed, ('agent inserted another agent''s contact opted in: ' || r)::text);
  END IF;
  -- Their own contact, inserted opted in, is allowed and has a history.
  r := pg_temp.jv_try('authenticated', u_agent, format(
    'INSERT INTO contacts (account_id, user_id, phone, name, marketing_opt_in_at, marketing_opt_in_source) VALUES (%L, %L, %L, %L, now(), %L)',
    a_acct, u_agent, '971500086012', 'JV inserted opted in', 'web_form'));
  SELECT id INTO c_ins FROM contacts WHERE phone = '971500086012';
  n := n + 1;
  IF r <> '1' OR pg_temp.jv_events(c_ins) <> 'marketing_opt_in/manual/jv-agent' THEN
    failed := array_append(failed, ('agent inserted own contact opted in: ' || r || ' history: ' || pg_temp.jv_events(c_ins))::text);
  END IF;

  -- A viewer cannot: RLS gives them no row, and the guard refuses them anyway.
  r := pg_temp.jv_try('authenticated', u_view, format(
    'UPDATE contacts SET marketing_opt_in_at = now(), marketing_opt_in_source = %L WHERE id = %L', 'whatsapp_button', c_view));
  x := pg_temp.jv_try(NULL, u_view, format(
    'UPDATE contacts SET marketing_opt_in_at = now(), marketing_opt_in_source = %L WHERE id = %L', 'whatsapp_button', c_view));
  n := n + 1;
  IF r <> '0' OR x NOT LIKE 'ERROR 42501: Only an agent who can see%'
     OR (SELECT marketing_opt_in_at FROM contacts WHERE id = c_view) IS NOT NULL THEN
    failed := array_append(failed, ('viewer set an opt-in: RLS ' || r || ' / guard ' || x)::text);
  END IF;

  -- Do-not-contact: an agent sets it, cannot clear it, an admin can.
  r := pg_temp.jv_try('authenticated', u_agent, format(
    'UPDATE contacts SET do_not_contact_at = now(), do_not_contact_reason = %L WHERE id = %L', 'asked on a call', c_agent));
  n := n + 1;
  IF r <> '1' OR pg_temp.jv_events(c_agent) <> 'do_not_contact_set/manual/jv-agent;marketing_opt_in/manual/jv-agent' THEN
    failed := array_append(failed, ('agent set do-not-contact: ' || r || ' history: ' || pg_temp.jv_events(c_agent))::text);
  END IF;
  r := pg_temp.jv_try('authenticated', u_agent, format(
    'UPDATE contacts SET do_not_contact_at = NULL WHERE id = %L', c_agent));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' OR (SELECT do_not_contact_at FROM contacts WHERE id = c_agent) IS NULL THEN
    failed := array_append(failed, ('agent cleared do-not-contact: ' || r)::text);
  END IF;
  -- F6b: below an admin, an existing do-not-contact is neither moved
  -- nor re-reasoned; an admin may do both.
  r := pg_temp.jv_try('authenticated', u_agent, format(
         'UPDATE contacts SET do_not_contact_at = do_not_contact_at + interval ''1 day'' WHERE id = %L', c_agent))
    || ' | ' || pg_temp.jv_try('authenticated', u_agent, format(
         'UPDATE contacts SET do_not_contact_reason = NULL WHERE id = %L', c_agent))
    || ' | ' || pg_temp.jv_try('authenticated', u_agent, format(
         'UPDATE contacts SET do_not_contact_at = now() - interval ''1 day'', do_not_contact_reason = %L WHERE id = %L', 'other', c_agent));
  x := pg_temp.jv_try('authenticated', u_admin, format(
         'UPDATE contacts SET do_not_contact_reason = %L WHERE id = %L', 'asked twice', c_agent))
    || ',' || pg_temp.jv_try('authenticated', u_admin, format(
         'UPDATE contacts SET do_not_contact_at = now(), do_not_contact_reason = %L WHERE id = %L', 'admin', c_none))
    || ',' || pg_temp.jv_try('authenticated', u_admin, format(
         'UPDATE contacts SET do_not_contact_at = now() - interval ''1 day'', do_not_contact_reason = %L WHERE id = %L', 'moved', c_none));
  -- Its own statement: a read beside the updates sees the snapshot taken before them.
  x := x || ',' || coalesce((SELECT do_not_contact_reason FROM contacts WHERE id = c_agent), '-')
    || ',' || coalesce((SELECT (do_not_contact_at = now() - interval '1 day')::text || '/' || do_not_contact_reason
                        FROM contacts WHERE id = c_none), '-');
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:% | ERROR 42501:% | ERROR 42501:%' OR x IS DISTINCT FROM '1,1,1,asked twice,true/moved' THEN
    failed := array_append(failed, ('agent moved/re-reasoned/both an existing do-not-contact: ' || r
      || ' / admin re-reasoned, set and moved: ' || x)::text);
  END IF;
  -- A screen writing the row back with the stamps unchanged.
  r := pg_temp.jv_try('authenticated', u_agent, format(
    'UPDATE contacts SET name = %L, do_not_contact_at = do_not_contact_at, marketing_opt_in_at = marketing_opt_in_at, marketing_opt_in_source = marketing_opt_in_source WHERE id = %L',
    'JV agent renamed', c_agent));
  n := n + 1;
  IF r <> '1' OR pg_temp.jv_events(c_agent) <> 'do_not_contact_set/manual/jv-agent;marketing_opt_in/manual/jv-agent' THEN
    failed := array_append(failed, ('agent whole-row write-back with unchanged stamps: ' || r)::text);
  END IF;
  r := pg_temp.jv_try('authenticated', u_admin, format(
    'UPDATE contacts SET do_not_contact_at = NULL WHERE id = %L', c_agent));
  n := n + 1;
  IF r <> '1' OR (SELECT do_not_contact_at FROM contacts WHERE id = c_agent) IS NOT NULL
     OR pg_temp.jv_events(c_agent) <> 'do_not_contact_cleared/manual/jv-admin;do_not_contact_set/manual/jv-agent;marketing_opt_in/manual/jv-agent' THEN
    failed := array_append(failed, ('admin cleared do-not-contact: ' || r || ' history: ' || pg_temp.jv_events(c_agent))::text);
  END IF;
  -- An agent's new do-not-contact names its reason; a reason alone is not one.
  r := pg_temp.jv_try('authenticated', u_agent, format(
         'UPDATE contacts SET do_not_contact_at = now(), do_not_contact_reason = %L WHERE id = %L', '  ', c_agent))
    || ' | ' || pg_temp.jv_try('authenticated', u_agent, format(
         'UPDATE contacts SET do_not_contact_reason = %L WHERE id = %L', 'no stamp', c_agent));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:% | ERROR 42501:%' OR (SELECT do_not_contact_at FROM contacts WHERE id = c_agent) IS NOT NULL THEN
    failed := array_append(failed, ('agent do-not-contact with a blank reason / a reason alone: ' || r)::text);
  END IF;
  -- An agent may withdraw an opt-in.
  r := pg_temp.jv_try('authenticated', u_agent, format(
    'UPDATE contacts SET marketing_opt_in_at = NULL WHERE id = %L', c_agent));
  n := n + 1;
  IF r <> '1' OR pg_temp.jv_events(c_agent) <> 'do_not_contact_cleared/manual/jv-admin;do_not_contact_set/manual/jv-agent;marketing_opt_in/manual/jv-agent;marketing_opt_in_withdrawn/manual/jv-agent' THEN
    failed := array_append(failed, ('agent withdrew an opt-in: ' || r || ' history: ' || pg_temp.jv_events(c_agent))::text);
  END IF;

  -- The service role writes anything, even where the agent cannot see;
  -- its source is app.consent_source when set, else 'system'.
  PERFORM set_config('app.consent_source', 'journey', true);
  r := pg_temp.jv_try('service_role', NULL, format('UPDATE contacts SET opted_out_at = now() WHERE id = %L', c_agent));
  PERFORM set_config('app.consent_source', '', true);
  x := pg_temp.jv_try('service_role', NULL, format('UPDATE contacts SET opted_out_at = NULL WHERE id = %L', c_agent));
  n := n + 1;
  IF r <> '1' OR x <> '1'
     OR pg_temp.jv_events(c_agent) <> 'do_not_contact_cleared/manual/jv-admin;do_not_contact_set/manual/jv-agent;marketing_opt_in/manual/jv-agent;marketing_opt_in_withdrawn/manual/jv-agent;opted_out/journey/-;resubscribed/system/-' THEN
    failed := array_append(failed, ('service role opted out (app.consent_source) and resubscribed: ' || r || ', ' || x
      || ' history: ' || pg_temp.jv_events(c_agent))::text);
  END IF;
  r := pg_temp.jv_try('service_role', NULL, format(
         'UPDATE contacts SET marketing_opt_in_at = now(), marketing_opt_in_source = %L, do_not_contact_at = now() WHERE id = %L', 'import', c_agent2))
    || ',' || pg_temp.jv_try('service_role', NULL, format(
         'UPDATE contacts SET marketing_opt_in_at = NULL, do_not_contact_at = NULL WHERE id = %L', c_agent2));
  n := n + 1;
  IF r <> '1,1'
     OR pg_temp.jv_events(c_agent2) <> 'do_not_contact_cleared/system/-;do_not_contact_set/system/-;marketing_opt_in/system/-;marketing_opt_in_withdrawn/system/-' THEN
    failed := array_append(failed, ('service role set and cleared opt-in and do-not-contact: ' || r
      || ' history: ' || pg_temp.jv_events(c_agent2))::text);
  END IF;
  r := pg_temp.jv_try('service_role', NULL, format(
    'UPDATE contacts SET marketing_opt_in_at = now(), marketing_opt_in_source = NULL WHERE id = %L', c_agent2));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' OR (SELECT marketing_opt_in_at FROM contacts WHERE id = c_agent2) IS NOT NULL THEN
    failed := array_append(failed, ('service role opt-in without a source: ' || r)::text);
  END IF;

  -- History is append-only, for the service role and the table owner alike.
  s0 := pg_temp.jv_events(c_agent);
  r := pg_temp.jv_try('service_role', NULL, format(
         'UPDATE contact_consent_events SET source = %L WHERE contact_id = %L', 'forged', c_agent))
    || ' | ' || pg_temp.jv_try('service_role', NULL, format(
         'DELETE FROM contact_consent_events WHERE contact_id = %L', c_agent));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:% | ERROR 42501:%' THEN
    failed := array_append(failed, ('service role rewrote consent history: ' || r)::text);
  END IF;
  r := pg_temp.jv_try(NULL, NULL, format(
         'UPDATE contact_consent_events SET source = %L WHERE contact_id = %L', 'forged', c_agent))
    || ' | ' || pg_temp.jv_try(NULL, NULL, format(
         'DELETE FROM contact_consent_events WHERE contact_id = %L', c_agent));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501: contact_consent_events is append-only | ERROR 42501: contact_consent_events is append-only'
     OR pg_temp.jv_events(c_agent) <> s0 THEN
    failed := array_append(failed, ('table owner rewrote consent history: ' || r)::text);
  END IF;
  r := pg_temp.jv_try('authenticated', u_admin, format(
    'INSERT INTO contact_consent_events (account_id, contact_id, kind, source) VALUES (%L, %L, %L, %L)',
    a_acct, c_agent, 'marketing_opt_in', 'forged'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('a signed-in admin wrote consent history directly: ' || r)::text);
  END IF;
  -- Deleting the contact takes its history with it.
  r := pg_temp.jv_try('service_role', NULL, format(
         'UPDATE contacts SET marketing_opt_in_at = now(), marketing_opt_in_source = %L WHERE id = %L', 'import', c_del))
    || ',' || pg_temp.jv_try('service_role', NULL, format('DELETE FROM contacts WHERE id = %L', c_del));
  n := n + 1;
  IF r <> '1,1' OR EXISTS (SELECT 1 FROM contact_consent_events WHERE contact_id = c_del) THEN
    failed := array_append(failed, ('deleting a contact with history: ' || r)::text);
  END IF;

  -- ================= 8. RLS and grants =================
  INSERT INTO journey_files (account_id, contact_id, workflow_key, state, body) VALUES
    (a_acct, c_agent,  wf, 'NEW', '{}'),
    (a_acct, c_conv,   wf, 'NEW', '{}'),
    (a_acct, c_agent2, wf, 'NEW', '{}'),
    (b_acct, c_b,      wf, 'NEW', '{}');
  INSERT INTO callback_requests (account_id, contact_id, conversation_id) VALUES
    (a_acct, c_agent, NULL), (a_acct, c_conv, cv), (a_acct, c_agent2, NULL),
    (a_acct, c_j, NULL), (b_acct, c_b, NULL);
  UPDATE contacts SET marketing_opt_in_at = now(), marketing_opt_in_source = 'import' WHERE id = c_b;

  -- The agent: their own contact and the one in their chat, nothing else.
  r := pg_temp.jv_try('authenticated', u_agent, format(
    'SELECT count(*) FILTER (WHERE contact_id = %L) || ''/'' || count(*) FILTER (WHERE contact_id = %L) || ''/'' || count(*) FILTER (WHERE contact_id NOT IN (%L, %L)) FROM journey_files',
    c_agent, c_conv, c_agent, c_conv));
  n := n + 1;
  IF r <> '1/1/0' THEN
    failed := array_append(failed, ('agent''s journey files (own/in chat/others): ' || r)::text);
  END IF;
  r := pg_temp.jv_try('authenticated', u_agent, format(
    'SELECT count(*) FILTER (WHERE contact_id = %L) || ''/'' || count(*) FILTER (WHERE contact_id = %L) || ''/'' || count(*) FILTER (WHERE contact_id NOT IN (%L, %L)) FROM callback_requests',
    c_agent, c_conv, c_agent, c_conv));
  n := n + 1;
  IF r <> '1/1/0' THEN
    failed := array_append(failed, ('agent''s callback requests (own/in chat/others): ' || r)::text);
  END IF;
  r := pg_temp.jv_try('authenticated', u_agent, format(
    'SELECT count(*) FILTER (WHERE contact_id IN (%L, %L)) || ''/'' || count(*) FILTER (WHERE contact_id NOT IN (%L, %L)) FROM contact_consent_events',
    c_agent, c_ins, c_agent, c_ins));
  x := (SELECT count(*) FROM contact_consent_events WHERE contact_id IN (c_agent, c_ins)) || '/0';
  n := n + 1;
  IF r <> x OR NOT EXISTS (SELECT 1 FROM contact_consent_events WHERE contact_id = c_agent2) THEN
    failed := array_append(failed, ('agent''s consent events (visible/others): ' || r || ', expected ' || x)::text);
  END IF;

  -- An admin: everything in the account, nothing outside it.
  x := (SELECT count(*) FROM journey_files WHERE account_id = a_acct) || '/0,'
    || (SELECT count(*) FROM contact_consent_events WHERE account_id = a_acct) || '/0,'
    || (SELECT count(*) FROM callback_requests WHERE account_id = a_acct) || '/0';
  r := pg_temp.jv_try('authenticated', u_admin, format(
         'SELECT count(*) FILTER (WHERE account_id = %L) || ''/'' || count(*) FILTER (WHERE account_id <> %L) FROM journey_files', a_acct, a_acct))
    || ',' || pg_temp.jv_try('authenticated', u_admin, format(
         'SELECT count(*) FILTER (WHERE account_id = %L) || ''/'' || count(*) FILTER (WHERE account_id <> %L) FROM contact_consent_events', a_acct, a_acct))
    || ',' || pg_temp.jv_try('authenticated', u_admin, format(
         'SELECT count(*) FILTER (WHERE account_id = %L) || ''/'' || count(*) FILTER (WHERE account_id <> %L) FROM callback_requests', a_acct, a_acct));
  n := n + 1;
  IF r <> x THEN
    failed := array_append(failed, ('admin''s files,events,callbacks (account/other): ' || r || ', expected ' || x)::text);
  END IF;

  -- Another account's owner: none of A's, their own B rows.
  r := pg_temp.jv_try('authenticated', u_other, format(
         'SELECT count(*) FILTER (WHERE account_id = %L) || ''/'' || count(*) FILTER (WHERE account_id = %L) FROM journey_files', a_acct, b_acct))
    || ',' || pg_temp.jv_try('authenticated', u_other, format(
         'SELECT count(*) FILTER (WHERE account_id = %L) || ''/'' || count(*) FILTER (WHERE account_id = %L) FROM contact_consent_events', a_acct, b_acct))
    || ',' || pg_temp.jv_try('authenticated', u_other, format(
         'SELECT count(*) FILTER (WHERE account_id = %L) || ''/'' || count(*) FILTER (WHERE account_id = %L) FROM callback_requests', a_acct, b_acct));
  n := n + 1;
  IF r <> '0/1,0/1,0/1' THEN
    failed := array_append(failed, ('another account''s files,events,callbacks (A/B): ' || r)::text);
  END IF;

  -- anon: no privilege, no rows.
  FOREACH x IN ARRAY ARRAY['journey_files', 'contact_consent_events', 'callback_requests', 'journey_settings',
                           'journey_outbox', 'journey_processed_events', 'journey_optin_claims'] LOOP
    r := pg_temp.jv_try('anon', NULL, format('SELECT count(*)::text FROM public.%I', x));
    n := n + 1;
    IF has_table_privilege('anon', 'public.' || x, 'SELECT') OR (r NOT LIKE 'ERROR 42501:%' AND r <> '0') THEN
      failed := array_append(failed, ('anon reads ' || x || ': ' || r)::text);
    END IF;
  END LOOP;

  -- Signed-in users never call the runner's functions, even the owner.
  r := pg_temp.jv_try('authenticated', u_owner, format(
         'SELECT public.journey_commit(%L::uuid, 4, %L::jsonb, %L, %L::jsonb)', f1, pg_temp.jv_body(f1, c_j, a_acct, 'X'), 'ev-u', '[]'))
    || ' | ' || pg_temp.jv_try('authenticated', u_owner, format('SELECT public.journey_pending_opt_out(%L)::text', c_po))
    || ' | ' || pg_temp.jv_try('authenticated', u_owner, format('SELECT public.journey_claim_optin_welcome(%L, %L)::text', c_none, 'u'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:% | ERROR 42501:% | ERROR 42501:%' THEN
    failed := array_append(failed, ('a signed-in owner called the journey functions: ' || r)::text);
  END IF;
  n := n + 1;
  IF has_function_privilege('authenticated', 'public.journey_commit(uuid, integer, jsonb, text, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.journey_pending_opt_out(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.journey_claim_optin_welcome(uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.journey_commit(uuid, integer, jsonb, text, jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.journey_pending_opt_out(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.journey_claim_optin_welcome(uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.journey_commit(uuid, integer, jsonb, text, jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.journey_pending_opt_out(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.journey_claim_optin_welcome(uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.contacts_consent_guard()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.contacts_consent_log()', 'EXECUTE') THEN
    failed := array_append(failed, 'journey function grants: clients may execute, or the service role may not'::text);
  END IF;

  -- Signed-in users only read files, and never the runner's tables.
  r := pg_temp.jv_try('authenticated', u_admin, format(
         'INSERT INTO journey_files (account_id, contact_id, workflow_key, state, body) VALUES (%L, %L, %L, %L, %L)',
         a_acct, c_none, wf, 'NEW', '{}'))
    || ' | ' || pg_temp.jv_try('authenticated', u_admin, format('UPDATE journey_files SET state = %L WHERE id = %L', 'X', f1))
    || ' | ' || pg_temp.jv_try('authenticated', u_admin, 'SELECT count(*)::text FROM journey_outbox')
    || ' | ' || pg_temp.jv_try('authenticated', u_admin, 'SELECT count(*)::text FROM journey_processed_events')
    || ' | ' || pg_temp.jv_try('authenticated', u_admin, 'SELECT count(*)::text FROM journey_optin_claims');
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:% | ERROR 42501:% | ERROR 42501:% | ERROR 42501:% | ERROR 42501:%'
     OR has_table_privilege('authenticated', 'public.journey_files', 'INSERT')
     OR has_table_privilege('authenticated', 'public.journey_files', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.journey_files', 'DELETE')
     OR has_table_privilege('authenticated', 'public.journey_outbox', 'SELECT')
     OR has_table_privilege('authenticated', 'public.callback_requests', 'INSERT') THEN
    failed := array_append(failed, ('a signed-in admin wrote journey files or read the runner''s tables: ' || r)::text);
  END IF;

  -- ================= 9. journey_settings =================
  r := pg_temp.jv_try('authenticated', u_agent, format(
    'INSERT INTO journey_settings (account_id, enabled) VALUES (%L, true)', a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('agent inserted journey settings: ' || r)::text);
  END IF;
  -- The admin's upsert, naming someone else as the editor.
  r := pg_temp.jv_try('authenticated', u_admin, format(
    'INSERT INTO journey_settings (account_id, enabled, taamul_did, updated_by) VALUES (%L, true, %L, %L) '
    'ON CONFLICT (account_id) DO UPDATE SET enabled = excluded.enabled, taamul_did = excluded.taamul_did',
    a_acct, '+971501234567', u_agent));
  n := n + 1;
  IF r <> '1' OR (SELECT updated_by FROM journey_settings WHERE account_id = a_acct) IS DISTINCT FROM u_admin THEN
    failed := array_append(failed, ('admin upsert of journey settings, updated_by = the admin: ' || r || ' by '
      || coalesce((SELECT updated_by::text FROM journey_settings WHERE account_id = a_acct), 'NULL'))::text);
  END IF;
  r := pg_temp.jv_try('authenticated', u_admin, format(
    'INSERT INTO journey_settings (account_id, enabled, taamul_did) VALUES (%L, true, %L) '
    'ON CONFLICT (account_id) DO UPDATE SET enabled = excluded.enabled, taamul_did = excluded.taamul_did',
    a_acct, '+971509999999'));
  n := n + 1;
  IF r <> '1' OR (SELECT taamul_did FROM journey_settings WHERE account_id = a_acct) <> '+971509999999' THEN
    failed := array_append(failed, ('admin re-upsert of journey settings: ' || r)::text);
  END IF;
  r := pg_temp.jv_try('authenticated', u_admin, format(
    'UPDATE journey_settings SET taamul_did = %L WHERE account_id = %L', '0501234567', a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN
    failed := array_append(failed, ('taamul_did that is not E.164: ' || r)::text);
  END IF;
  r := pg_temp.jv_try('authenticated', u_admin, format(
    'INSERT INTO journey_settings (account_id, enabled) VALUES (%L, true)', b_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('admin inserted another account''s journey settings: ' || r)::text);
  END IF;
  INSERT INTO journey_settings (account_id) VALUES (b_acct);
  r := pg_temp.jv_try('authenticated', u_agent, 'SELECT string_agg(account_id::text, '','') FROM journey_settings');
  n := n + 1;
  IF r IS DISTINCT FROM a_acct::text THEN
    failed := array_append(failed, ('agent reads journey settings (own account only): ' || r)::text);
  END IF;
  r := pg_temp.jv_try('authenticated', u_agent, format(
    'UPDATE journey_settings SET enabled = false WHERE account_id = %L', a_acct));
  n := n + 1;
  IF r <> '0' OR NOT (SELECT enabled FROM journey_settings WHERE account_id = a_acct) THEN
    failed := array_append(failed, ('agent updated journey settings: ' || r)::text);
  END IF;
  r := pg_temp.jv_try('authenticated', u_other, format(
    'SELECT count(*) FILTER (WHERE account_id = %L) || ''/'' || count(*) FILTER (WHERE account_id = %L) FROM journey_settings', a_acct, b_acct));
  n := n + 1;
  IF r <> '0/1' THEN
    failed := array_append(failed, ('another account reads journey settings (A/B): ' || r)::text);
  END IF;

  r := (SELECT copy::text || '/' || (SELECT count(*) FROM pg_constraint WHERE conname = 'journey_settings_copy_object')::text
        FROM journey_settings WHERE account_id = b_acct);
  n := n + 1;
  IF r IS DISTINCT FROM '{}/1' THEN
    failed := array_append(failed, ('journey_settings.copy default and object check: ' || coalesce(r, 'no row'))::text);
  END IF;

  -- ================= 10. drain fairness: failed items, journey_drain_candidates =================
  -- The candidates at p_now as "contact name,..." in the function's order.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.jv_cand(p_now timestamptz, p_limit integer DEFAULT 50, p_accts uuid[] DEFAULT NULL)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE ids text;
    BEGIN
      ids := pg_temp.jv_try('service_role', NULL, format(
        'SELECT string_agg(c.file_id::text, '','' ORDER BY c.ord) '
        'FROM public.journey_drain_candidates(%L::timestamptz, %s, %L::uuid[]) WITH ORDINALITY c(file_id, account_id, ord)',
        p_now, p_limit, p_accts));
      IF ids = 'null' THEN RETURN ''; END IF;
      IF ids LIKE 'ERROR%' THEN RETURN ids; END IF;
      RETURN (SELECT string_agg(ct.name, ',' ORDER BY u.ord)
              FROM unnest(string_to_array(ids, ',')::uuid[]) WITH ORDINALITY u(id, ord)
              JOIN public.journey_files f ON f.id = u.id
              JOIN public.contacts ct ON ct.id = f.contact_id);
    END $body$
  $fn$;

  -- Only this section's items are pending from here on.
  UPDATE journey_outbox SET status = 'delivered', delivered_at = now() WHERE status = 'pending';
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500086101', 'q1') RETURNING id INTO cq1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500086102', 'q2') RETURNING id INTO cq2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500086103', 'q3') RETURNING id INTO cq3;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500086104', 'q4') RETURNING id INTO cq4;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b_acct, u_other, '971500086105', 'qb') RETURNING id INTO cqb;
  INSERT INTO journey_files (id, account_id, contact_id, workflow_key, state, body, version) VALUES
    (q1, a_acct, cq1, wf, 'NEW', pg_temp.jv_body(q1, cq1, a_acct, 'NEW'), 0),
    (q2, a_acct, cq2, wf, 'NEW', pg_temp.jv_body(q2, cq2, a_acct, 'NEW'), 0),
    (q3, a_acct, cq3, wf, 'NEW', pg_temp.jv_body(q3, cq3, a_acct, 'NEW'), 0),
    (q4, a_acct, cq4, wf, 'NEW', pg_temp.jv_body(q4, cq4, a_acct, 'NEW'), 0),
    (qb, b_acct, cqb, wf, 'NEW', pg_temp.jv_body(qb, cqb, b_acct, 'NEW'), 0);
  INSERT INTO journey_outbox (file_id, account_id, seq, action, committed_at)
  VALUES (q1, a_acct, 1, a_send0, now() - interval '3 hours') RETURNING id INTO oq1;
  INSERT INTO journey_outbox (file_id, account_id, seq, action, committed_at)
  VALUES (q4, a_acct, 1, a_send0, now() - interval '2 hours') RETURNING id INTO oq4;
  INSERT INTO journey_outbox (file_id, account_id, seq, action, committed_at) VALUES
    (q3, a_acct, 1, a_send0, now() - interval '1 hour'),
    (qb, b_acct, 1, a_send0, now() - interval '4 hours');

  -- Failed-item bookkeeping: attempts + 1, last_attempt_at, last_error (cut to 500); pending items only; service role only.
  r := pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_outbox_failed(%L, %L)::text', oq1, 'Whapi 500'));
  r := r || ',' || (SELECT attempts || '/' || (last_attempt_at = now())::text || '/' || last_error FROM journey_outbox WHERE id = oq1);
  r := r || ',' || pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_outbox_failed(%L, %L)::text', oq4, repeat('e', 600)));
  r := r || ',' || (SELECT attempts || '/' || length(last_error) FROM journey_outbox WHERE id = oq4);
  r := r || ',' || pg_temp.jv_try('service_role', NULL, format('SELECT public.journey_outbox_failed(%L, %L)::text', ob1, 'late'));
  r := r || ',' || (SELECT attempts || '/' || coalesce(last_error, '-') FROM journey_outbox WHERE id = ob1);
  x := pg_temp.jv_try('authenticated', u_admin, format('SELECT public.journey_outbox_failed(%L, %L)::text', oq1, 'x'))
    || ' | ' || pg_temp.jv_try('authenticated', u_admin, format('SELECT count(*) FROM public.journey_drain_candidates(%L, 5)', now()));
  n := n + 1;
  IF r <> 'true,1/true/Whapi 500,true,1/500,false,1/-' OR x NOT LIKE 'ERROR 42501:% | ERROR 42501:%' THEN
    failed := array_append(failed, ('journey_outbox_failed bookkeeping (pending, truncated, delivered item, admin): ' || r || ' / ' || x)::text);
  END IF;

  -- A LOG_COST takes the not_before of the SEND of its template right before it.
  r := pg_temp.jv_commit(q2, 0, pg_temp.jv_body(q2, cq2, a_acct, 'QUALIFY'), 'q2-1', jsonb_build_array(
    jsonb_build_object('type', 'SEND', 'template', 't', 'category', 'MARKETING', 'billable', true, 'notBefore', t_later),
    '{"type":"LOG_COST","template":"t","category":"MARKETING"}'::jsonb,
    a_send0, '{"type":"LOG_COST","template":"t0","category":"UTILITY"}'::jsonb, a_timer));
  x := to_char(t_later AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  n := n + 1;
  IF r <> 'ok' OR pg_temp.jv_outbox(q2) <> format('1:SEND:pending:%s,2:LOG_COST:pending:%s,3:SEND:pending:-,'
       '4:LOG_COST:pending:-,5:SET_TIMER:pending:-', x, x) THEN
    failed := array_append(failed, ('LOG_COST inherits its SEND''s not_before: ' || r || ' ' || pg_temp.jv_outbox(q2))::text);
  END IF;

  -- A recently failed head is skipped (q1: one failure, 2 minutes), and back once its backoff is over; never-tried
  -- heads come first, oldest commit first (q4 has failed too, but its failure is checked below).
  UPDATE journey_outbox SET attempts = 0, last_attempt_at = NULL, last_error = NULL WHERE id = oq4;
  r := pg_temp.jv_cand(now() + interval '1 minute') || ' | ' || pg_temp.jv_cand(now() + interval '2 minutes');
  n := n + 1;
  IF r <> 'q4,q3,q2 | q4,q3,q2,q1' THEN
    failed := array_append(failed, ('recently failed head skipped, back after its backoff (+1 min | +2 min): ' || r)::text);
  END IF;

  -- A never-tried file comes before a long-failing one, and the longest-waiting failed head first; the backoff stops
  -- at 60 minutes, and a huge attempts count does not overflow it.
  UPDATE journey_outbox SET attempts = 3, last_attempt_at = now() - interval '1 day' WHERE id = oq1;
  UPDATE journey_outbox SET attempts = 5000, last_attempt_at = now() - interval '59 minutes' WHERE id = oq4;
  r := pg_temp.jv_cand(now()) || ' | ' || pg_temp.jv_cand(now() + interval '1 minute');
  n := n + 1;
  IF r <> 'q3,q2,q1 | q3,q2,q1,q4' THEN
    failed := array_append(failed, ('never-tried before long-failing, 60-minute cap (now | +1 min): ' || r)::text);
  END IF;

  -- A deferred SEND does not hide the due items after it (q2 above); with only the quiet-hours pair left, the file is
  -- not a candidate until its not_before.
  UPDATE journey_outbox SET status = 'delivered', delivered_at = now() WHERE file_id = q2 AND seq >= 3;
  r := pg_temp.jv_cand(now()) || ' | ' || pg_temp.jv_cand(t_later - interval '1 second') || ' | ' || pg_temp.jv_cand(t_later);
  n := n + 1;
  IF r <> 'q3,q1 | q3,q1,q4 | q3,q2,q1,q4' THEN
    failed := array_append(failed, ('quiet-hours-deferred file waits for its not_before (now | before | at): ' || r)::text);
  END IF;

  -- Only accounts with journeys enabled; p_account_ids narrows them; p_limit caps the list.
  UPDATE journey_settings SET enabled = true WHERE account_id = b_acct;
  r := pg_temp.jv_cand(now()) || ' | ' || pg_temp.jv_cand(now(), 50, ARRAY[a_acct]) || ' | ' || pg_temp.jv_cand(now(), 1);
  UPDATE journey_settings SET enabled = false WHERE account_id = a_acct;
  r := r || ' | ' || pg_temp.jv_cand(now());
  n := n + 1;
  IF r <> 'qb,q3,q1 | q3,q1 | qb | qb' THEN
    failed := array_append(failed, ('candidates follow journey_settings.enabled, p_account_ids and p_limit: ' || r)::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT086', MESSAGE = 'verify-journeys rollback';
  EXCEPTION WHEN SQLSTATE 'ZT086' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'journeys verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'journeys verification passed (% checks)', n;
END
$verify$;
