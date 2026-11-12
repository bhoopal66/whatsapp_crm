-- Behavioural regression suite for the second brain store (migration 194).
--
-- brain_items holds redacted staff knowledge, one chunk per row, written
-- only through brain_item_upsert while the account's switch
-- (case_account_settings.brain_enabled, default off) is on. This asserts,
-- through the real functions and triggers: the switch and its writer;
-- the upsert's idempotency and refusals; the role ladder; the read rule
-- with and without a case; opted-out, do-not-contact and marked contacts;
-- forgetting and its scopes; search (keyword, cosine ranking, strangers)
-- and its audit row; the contact-delete trigger; and the privileges.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000194001';
  u_admin  UUID := '00000000-0000-4000-8000-000000194002';
  u_lead   UUID := '00000000-0000-4000-8000-000000194003';
  u_agent  UUID := '00000000-0000-4000-8000-000000194004';
  u_agent2 UUID := '00000000-0000-4000-8000-000000194005';
  u_coord  UUID := '00000000-0000-4000-8000-000000194006';
  u_viewer UUID := '00000000-0000-4000-8000-000000194007';
  u_gone   UUID := '00000000-0000-4000-8000-000000194008';  -- deactivated
  u_guest  UUID := '00000000-0000-4000-8000-000000194009';  -- bank guest
  u_out    UUID := '00000000-0000-4000-8000-000000194010';  -- another workspace
  a_acct   UUID;
  a_out    UUID;
  c1 UUID; c_opt UUID; c_dnc UUID; c_mark UUID; c_del UUID; c_out UUID;
  k1       UUID;  -- a lead case of a_acct, agent u_agent
  k_out    UUID;  -- a lead case of a_out
  i1 UUID; i1b UUID; i_opt UUID; i_dnc UUID; i_mark UUID; i_f UUID;
  i_v1 UUID; i_v2 UUID; i_del UUID; i_case UUID;
  v_id     UUID;
  v_t      TEXT;
  v_n      INT;
  v_b      BOOLEAN;
  v_hash   TEXT := encode(sha256(convert_to('brain verify query', 'UTF8')), 'hex');
  fn       TEXT;
  tb       TEXT;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as the table owner: 'ok' / the value, or
  -- 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.bs_try(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; st text; h text; m text;
    BEGIN
      IF p_sql ILIKE 'select%' THEN
        EXECUTE p_sql INTO v;
      ELSE
        EXECUTE p_sql;
      END IF;
      RETURN coalesce(nullif(v, ''), 'ok');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, h = PG_EXCEPTION_HINT,
                              m = MESSAGE_TEXT;
      RETURN format('ERROR %s %s: %s', st, coalesce(h, ''), m);
    END $body$
  $fn$;

  -- An upsert call as SQL text (for refusals).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.bs_up(p_acct uuid, p_kind text, p_src text, p_case uuid,
      p_text text, p_label text, p_by uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT format('SELECT public.brain_item_upsert(%L, %L, %L, %L, NULL, NULL, %L, false, NULL, %L, %L)::text',
                    p_acct, p_kind, p_src, p_case, p_text, p_by, p_label)
    $body$
  $fn$;

  -- Item ids a search returns, as an array (rank order).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.bs_find(p_actor uuid, p_acct uuid, p_q text, p_vec real[], p_model text)
    RETURNS uuid[] LANGUAGE sql AS $body$
      SELECT coalesce(array_agg(s.item_id), '{}')
        FROM public.brain_search_candidates(p_actor, p_acct, p_q, p_vec, p_model, NULL, NULL, NULL, 50) s
    $body$
  $fn$;

  -- ---------- fixture ----------
  -- The auth.users trigger provisions each person an account of their
  -- own; everyone but the owner and u_out moves into the owner's.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'bs-owner@example.invalid'),
    (u_admin,  'bs-admin@example.invalid'),
    (u_lead,   'bs-lead@example.invalid'),
    (u_agent,  'bs-agent@example.invalid'),
    (u_agent2, 'bs-agent2@example.invalid'),
    (u_coord,  'bs-coord@example.invalid'),
    (u_viewer, 'bs-viewer@example.invalid'),
    (u_gone,   'bs-gone@example.invalid'),
    (u_guest,  'bs-guest@example.invalid'),
    (u_out,    'bs-out@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO a_out FROM accounts WHERE owner_user_id = u_out;
  IF a_acct IS NULL OR a_out IS NULL OR a_acct = a_out THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  INSERT INTO case_banks (account_id, code, name)
  VALUES (a_acct, 'ADCB', 'ADCB'), (a_out, 'ADCB', 'ADCB') ON CONFLICT DO NOTHING;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'
   WHERE user_id IN (u_agent, u_agent2, u_coord, u_gone);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;
  INSERT INTO coordinator_banks (account_id, user_id, bank_code) VALUES (a_acct, u_coord, 'ADCB');

  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500194001', 'BS 1') RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500194002', 'BS 2') RETURNING id INTO c_opt;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500194003', 'BS 3') RETURNING id INTO c_dnc;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500194004', 'BS 4') RETURNING id INTO c_mark;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500194005', 'BS 5') RETURNING id INTO c_del;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_out, u_out, '971500194006', 'BS 6') RETURNING id INTO c_out;
  k1 := case_open_lead(u_agent, a_acct, c1, 'ADCB', 'Loan', u_agent, 1000);
  k_out := case_open_lead(u_out, a_out, c_out, 'ADCB', 'Loan', u_out, 1000);
  IF k1 IS NULL OR k_out IS NULL THEN
    RAISE EXCEPTION 'fixture: case_open_lead returned NULL';
  END IF;

  -- ---------- 1. the switch ----------
  n := n + 1;
  SELECT column_default INTO v_t FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'case_account_settings' AND column_name = 'brain_enabled';
  IF v_t IS DISTINCT FROM 'false' THEN failed := failed || format('brain_enabled default is %s, not false', v_t); END IF;

  n := n + 1;
  v_id := brain_item_upsert(a_acct, 'note', 'bs-1', NULL, NULL, NULL, 'prefers morning calls', false, NULL, u_agent, NULL);
  SELECT count(*) INTO v_n FROM brain_items WHERE account_id = a_acct;
  IF v_id IS NOT NULL OR v_n <> 0 THEN failed := failed || 'switch off (no settings row): upsert stored a chunk'::text; END IF;

  n := n + 1;
  r := pg_temp.bs_try(format('SELECT public.case_settings_set_brain(%L, %L, true)::text', u_agent, a_acct));
  IF r NOT LIKE 'ERROR % NOT_ALLOWED:%' THEN failed := failed || format('an agent turned the brain on: %s', r); END IF;

  n := n + 1;
  v_b := case_settings_set_brain(u_owner, a_acct, false);
  v_id := brain_item_upsert(a_acct, 'note', 'bs-1', NULL, NULL, NULL, 'prefers morning calls', false, NULL, u_agent, NULL);
  SELECT count(*) INTO v_n FROM brain_items WHERE account_id = a_acct;
  IF v_id IS NOT NULL OR v_n <> 0 THEN failed := failed || 'switch off (row false): upsert stored a chunk'::text; END IF;

  n := n + 1;
  v_b := case_settings_set_brain(u_owner, a_acct, true);
  SELECT brain_enabled INTO v_b FROM case_account_settings WHERE account_id = a_acct;
  IF v_b IS NOT TRUE THEN failed := failed || 'the owner could not turn the brain on'::text; END IF;

  -- ---------- 2. upsert ----------
  n := n + 1;
  i1 := brain_item_upsert(a_acct, 'note', 'bs-1', NULL, NULL, NULL, 'prefers morning calls', false, NULL, u_agent, NULL);
  i1b := brain_item_upsert(a_acct, 'note', 'bs-1', NULL, NULL, NULL, 'prefers morning calls', false, NULL, u_agent, NULL);
  SELECT count(*) INTO v_n FROM brain_items WHERE account_id = a_acct AND source_id = 'bs-1';
  IF i1 IS NULL OR i1 IS DISTINCT FROM i1b OR v_n <> 1 THEN
    failed := failed || format('upsert not idempotent (%s, %s, %s rows)', i1, i1b, v_n);
  END IF;

  n := n + 1;
  FOREACH v_t IN ARRAY ARRAY['call 0501234567', 'call 050 123 4567', 'call 050-123-4567'] LOOP
    r := pg_temp.bs_try(pg_temp.bs_up(a_acct, 'note', 'bs-num', NULL, v_t, NULL, u_agent));
    IF r NOT LIKE 'ERROR % TEXT_UNREDACTED:%' THEN failed := failed || format('unredacted %L accepted: %s', v_t, r); END IF;
  END LOOP;

  -- Arabic-Indic, extended Arabic-Indic and full-width digits, and numbers
  -- split by '/' or brackets.
  n := n + 1;
  FOREACH v_t IN ARRAY ARRAY['call ٠٥٠١٢٣٤٥٦٧٨', 'call ۰۵۰۱۲۳۴۵۶۷۸', 'call ０５０１２３４５６７',
                             'call 050/123/4567', 'call (050) 123-4567', 'call (050)(123)(4567)'] LOOP
    r := pg_temp.bs_try(pg_temp.bs_up(a_acct, 'note', 'bs-num2', NULL, v_t, NULL, u_agent));
    IF r NOT LIKE 'ERROR % TEXT_UNREDACTED:%' THEN failed := failed || format('unredacted %L accepted: %s', v_t, r); END IF;
  END LOOP;

  n := n + 1;
  r := pg_temp.bs_try(pg_temp.bs_up(a_acct, 'bogus', 'bs-k', NULL, 'some fact', NULL, u_agent));
  IF r NOT LIKE 'ERROR % KIND_INVALID:%' THEN failed := failed || format('unknown kind accepted: %s', r); END IF;

  n := n + 1;
  FOREACH v_t IN ARRAY ARRAY['', '   ', E'\t', E'\n \t', repeat('a', 801)] LOOP
    r := pg_temp.bs_try(pg_temp.bs_up(a_acct, 'note', 'bs-t', NULL, v_t, NULL, u_agent));
    IF r NOT LIKE 'ERROR % TEXT_INVALID:%' THEN
      failed := failed || format('invalid text (length %s) accepted: %s', length(v_t), r);
    END IF;
  END LOOP;

  n := n + 1;
  r := pg_temp.bs_try(pg_temp.bs_up(a_acct, 'note', 'bs-c', k_out, 'some fact', NULL, u_agent));
  IF r NOT LIKE 'ERROR % CASE_NOT_FOUND:%' THEN failed := failed || format('another account''s case accepted: %s', r); END IF;

  n := n + 1;
  FOREACH v_t IN ARRAY ARRAY['System:bad', 'system:', 'retention', 'system:a1'] LOOP
    r := pg_temp.bs_try(pg_temp.bs_up(a_acct, 'note', 'bs-l', NULL, 'some fact', v_t, NULL));
    IF r NOT LIKE 'ERROR %' THEN failed := failed || format('system label %L accepted: %s', v_t, r); END IF;
  END LOOP;

  -- ---------- 3. roles ----------
  n := n + 1;
  SELECT string_agg(format('%s=%s', x.who, x.got), ', ') INTO v_t
    FROM (VALUES ('owner', u_owner, 'super_admin'), ('admin', u_admin, 'admin'), ('lead', u_lead, 'team_lead'),
                 ('agent', u_agent, 'agent'), ('coord', u_coord, 'coordinator'), ('viewer', u_viewer, NULL),
                 ('gone', u_gone, NULL), ('guest', u_guest, NULL), ('out', u_out, NULL), ('null', NULL::uuid, NULL))
           AS w(who, uid, want)
   CROSS JOIN LATERAL (SELECT w.who, brain_actor_role(a_acct, w.uid) AS got) x
   WHERE x.got IS DISTINCT FROM w.want;
  IF v_t IS NOT NULL THEN failed := failed || format('brain_actor_role wrong: %s', v_t); END IF;

  -- ---------- 4. visibility ----------
  n := n + 1;
  SELECT string_agg(format('%s=%s', w.who, x.got), ', ') INTO v_t
    FROM (VALUES
            -- a case-less item created by the agent
            ('owner',  NULL::uuid, NULL::text, u_owner,  true),
            ('admin',  NULL, NULL, u_admin,  true),
            ('creator',NULL, NULL, u_agent,  true),
            ('agent2', NULL, NULL, u_agent2, false),
            ('lead',   NULL, NULL, u_lead,   false),
            ('viewer', NULL, NULL, u_viewer, false),
            ('gone',   NULL, NULL, u_gone,   false),
            ('out',    NULL, NULL, u_out,    false),
            -- restricted to admin: hidden from its own agent creator
            ('r-creator', NULL, 'admin', u_agent, false),
            ('r-admin',   NULL, 'admin', u_admin, true),
            -- a case of another account
            ('kout-owner', k_out, NULL, u_owner, false),
            -- the agent's own case
            ('k-agent',  k1, NULL, u_agent,  true),
            ('k-owner',  k1, NULL, u_owner,  true),
            ('k-agent2', k1, NULL, u_agent2, false),
            ('k-viewer', k1, NULL, u_viewer, false),
            ('k-r-agent', k1, 'admin', u_agent, false),
            ('k-r-admin', k1, 'admin', u_admin, true),
            ('k-null',   k1, NULL, NULL::uuid, false))
           AS w(who, kase, rr, uid, want)
   CROSS JOIN LATERAL (SELECT brain_item_visible(a_acct, w.kase, u_agent, w.rr, w.uid) AS got) x
   WHERE x.got IS DISTINCT FROM w.want;
  IF v_t IS NOT NULL THEN failed := failed || format('brain_item_visible wrong: %s', v_t); END IF;

  n := n + 1;
  i_case := brain_item_upsert(a_acct, 'note', 'bs-case', k1, c1, 'ADCB', 'salary transfer pending', false, NULL, u_owner, NULL);
  IF i_case IS NULL
     OR NOT (i1 = ANY (pg_temp.bs_find(u_agent, a_acct, 'morning', NULL, NULL)))
     OR i1 = ANY (pg_temp.bs_find(u_agent2, a_acct, 'morning', NULL, NULL))
     OR NOT (i_case = ANY (pg_temp.bs_find(u_agent, a_acct, 'salary', NULL, NULL)))
     OR i_case = ANY (pg_temp.bs_find(u_agent2, a_acct, 'salary', NULL, NULL)) THEN
    failed := failed || 'search does not follow the read rule (creator / case agent vs another agent)'::text;
  END IF;

  -- ---------- 5. marked contacts ----------
  i_opt := brain_item_upsert(a_acct, 'note', 'bs-opt', NULL, c_opt, NULL, 'likes zebra prints', false, NULL, u_owner, NULL);
  i_dnc := brain_item_upsert(a_acct, 'note', 'bs-dnc', NULL, c_dnc, NULL, 'asked about walrus loans', false, NULL, u_owner, NULL);
  i_mark := brain_item_upsert(a_acct, 'note', 'bs-mark', NULL, c_mark, NULL, 'owns a pelican cafe', false, NULL, u_owner, NULL);
  n := n + 1;
  IF i_opt IS NULL OR i_dnc IS NULL OR i_mark IS NULL
     OR NOT (i_opt = ANY (pg_temp.bs_find(u_owner, a_acct, 'zebra', NULL, NULL)))
     OR NOT (i_dnc = ANY (pg_temp.bs_find(u_owner, a_acct, 'walrus', NULL, NULL)))
     OR NOT (i_mark = ANY (pg_temp.bs_find(u_owner, a_acct, 'pelican', NULL, NULL))) THEN
    failed := failed || 'fixture: unmarked contact items not stored or not found'::text;
  END IF;

  UPDATE contacts SET opted_out_at = now() WHERE id = c_opt;
  UPDATE contacts SET do_not_contact_at = now(), do_not_contact_reason = 'verify' WHERE id = c_dnc;
  PERFORM brain_contact_mark(u_agent, a_acct, c_mark, 'opt_out');

  n := n + 1;
  IF i_opt = ANY (pg_temp.bs_find(u_owner, a_acct, 'zebra', NULL, NULL)) THEN
    failed := failed || 'search returned an opted-out contact''s item'::text;
  END IF;
  n := n + 1;
  IF i_dnc = ANY (pg_temp.bs_find(u_owner, a_acct, 'walrus', NULL, NULL)) THEN
    failed := failed || 'search returned a do-not-contact contact''s item'::text;
  END IF;
  n := n + 1;
  IF i_mark = ANY (pg_temp.bs_find(u_owner, a_acct, 'pelican', NULL, NULL)) THEN
    failed := failed || 'search returned a brain-marked contact''s item'::text;
  END IF;
  n := n + 1;
  SELECT count(*) INTO v_n FROM brain_contact_marks
   WHERE account_id = a_acct AND contact_id = c_mark AND kind = 'opt_out' AND marked_by = u_agent;
  IF v_n <> 1 THEN failed := failed || 'brain_contact_mark wrote no row'::text; END IF;

  n := n + 1;
  v_id := brain_item_upsert(a_acct, 'note', 'bs-opt2', NULL, c_opt, NULL, 'another fact', false, NULL, u_owner, NULL);
  IF v_id IS NOT NULL THEN failed := failed || 'upsert stored a chunk for an opted-out contact'::text; END IF;
  v_id := brain_item_upsert(a_acct, 'note', 'bs-dnc2', NULL, c_dnc, NULL, 'another fact', false, NULL, u_owner, NULL);
  IF v_id IS NOT NULL THEN failed := failed || 'upsert stored a chunk for a do-not-contact contact'::text; END IF;
  v_id := brain_item_upsert(a_acct, 'note', 'bs-mark2', NULL, c_mark, NULL, 'another fact', false, NULL, u_owner, NULL);
  IF v_id IS NOT NULL THEN failed := failed || 'upsert stored a chunk for a brain-marked contact'::text; END IF;

  -- A contact that does not exist in the account (deleted, or another
  -- account's) stores nothing.
  n := n + 1;
  v_id := brain_item_upsert(a_acct, 'note', 'bs-nocontact', NULL, gen_random_uuid(), NULL, 'a gone fact', false, NULL, u_owner, NULL);
  IF v_id IS NOT NULL THEN failed := failed || 'upsert stored a chunk for a contact that does not exist'::text; END IF;
  v_id := brain_item_upsert(a_acct, 'note', 'bs-outcontact', NULL, c_out, NULL, 'a foreign fact', false, NULL, u_owner, NULL);
  IF v_id IS NOT NULL THEN failed := failed || 'upsert stored a chunk for another account''s contact'::text; END IF;
  SELECT count(*) INTO v_n FROM brain_items WHERE account_id = a_acct AND source_id IN ('bs-nocontact', 'bs-outcontact');
  IF v_n <> 0 THEN failed := failed || format('%s chunks stored for contacts not in the account', v_n); END IF;

  n := n + 1;
  r := pg_temp.bs_try(format('SELECT public.brain_contact_mark(%L, %L, %L, %L)::text', u_out, a_acct, c1, 'opt_out'));
  IF r NOT LIKE 'ERROR % NOT_ALLOWED:%' THEN failed := failed || format('a stranger marked a contact: %s', r); END IF;
  r := pg_temp.bs_try(format('SELECT public.brain_contact_mark(%L, %L, %L, %L)::text', u_agent, a_acct, c1, 'bogus'));
  IF r NOT LIKE 'ERROR % KIND_INVALID:%' THEN failed := failed || format('unknown mark kind accepted: %s', r); END IF;

  -- ---------- 6. forget ----------
  i_f := brain_item_upsert(a_acct, 'note', 'bs-f', NULL, NULL, NULL, 'remembers the heron logo', false, NULL, u_owner, NULL);
  PERFORM brain_embedding_put(a_acct, i_f, 'm-verify', ARRAY[0.5, 0.5, 0.5]::real[]);

  n := n + 1;
  r := pg_temp.bs_try(format('SELECT public.brain_item_forget(%L, NULL, %L, %L, NULL, NULL, %L)::text', u_agent, a_acct, i_f, 'verify'));
  IF r NOT LIKE 'ERROR % NOT_ALLOWED:%' THEN failed := failed || format('an agent forgot an item: %s', r); END IF;
  r := pg_temp.bs_try(format('SELECT public.brain_item_forget(NULL, %L, %L, %L, NULL, NULL, %L)::text', 'system:other', a_acct, i_f, 'verify'));
  IF r NOT LIKE 'ERROR % NOT_ALLOWED:%' THEN failed := failed || format('an unknown system label forgot an item: %s', r); END IF;

  n := n + 1;
  r := pg_temp.bs_try(format('SELECT public.brain_item_forget(%L, NULL, %L, %L, %L, NULL, %L)::text', u_owner, a_acct, i_f, c1, 'verify'));
  IF r NOT LIKE 'ERROR % SCOPE_INVALID:%' THEN failed := failed || format('two forget scopes accepted: %s', r); END IF;
  r := pg_temp.bs_try(format('SELECT public.brain_item_forget(%L, NULL, %L, NULL, NULL, NULL, %L)::text', u_owner, a_acct, 'verify'));
  IF r NOT LIKE 'ERROR % SCOPE_INVALID:%' THEN failed := failed || format('no forget scope accepted: %s', r); END IF;
  FOREACH v_t IN ARRAY ARRAY['', '  ', E'\t'] LOOP
    r := pg_temp.bs_try(format('SELECT public.brain_item_forget(%L, NULL, %L, %L, NULL, NULL, %L)::text', u_owner, a_acct, i_f, v_t));
    IF r NOT LIKE 'ERROR % SCOPE_INVALID:%' THEN failed := failed || format('blank forget reason accepted: %s', r); END IF;
  END LOOP;

  n := n + 1;
  v_n := brain_item_forget(NULL, 'system:erasure', a_acct, i_f, NULL, NULL, 'verify');
  IF v_n <> 1 THEN failed := failed || format('system:erasure forgot %s items, not 1', v_n); END IF;

  n := n + 1;
  SELECT count(*) INTO v_n FROM brain_items WHERE item_id = i_f AND text = '' AND deleted_at IS NOT NULL;
  IF v_n <> 1 THEN failed := failed || 'a forgotten item kept its text or has no deleted_at'::text; END IF;
  SELECT count(*) INTO v_n FROM brain_embeddings WHERE item_id = i_f;
  IF v_n <> 0 THEN failed := failed || 'a forgotten item kept its embeddings'::text; END IF;

  n := n + 1;
  v_id := brain_item_upsert(a_acct, 'note', 'bs-f', NULL, NULL, NULL, 'remembers the heron logo', false, NULL, u_owner, NULL);
  IF v_id IS NOT NULL THEN failed := failed || 're-upserting a forgotten chunk brought it back'::text; END IF;
  SELECT count(*) INTO v_n FROM brain_items WHERE account_id = a_acct AND source_id = 'bs-f' AND deleted_at IS NULL;
  IF v_n <> 0 THEN failed := failed || 're-upserting a forgotten chunk stored a live row'::text; END IF;

  n := n + 1;
  v_n := brain_item_forget(u_admin, NULL, a_acct, i_f, NULL, NULL, 'verify again');
  IF v_n <> 0 THEN failed := failed || format('forgetting a forgotten item counted %s', v_n); END IF;
  IF i_f = ANY (pg_temp.bs_find(u_owner, a_acct, 'heron', NULL, NULL)) THEN
    failed := failed || 'search returned a forgotten item'::text;
  END IF;

  n := n + 1;
  r := pg_temp.bs_try(format('SELECT public.brain_embedding_put(%L, %L, %L, %L::real[])::text', a_acct, i_f, 'm-verify', '{1,0}'));
  IF r NOT LIKE 'ERROR % ITEM_NOT_FOUND:%' THEN failed := failed || format('an embedding was put on a forgotten item: %s', r); END IF;

  -- ---------- 7. search ----------
  n := n + 1;
  IF NOT (i1 = ANY (pg_temp.bs_find(u_owner, a_acct, 'morning', NULL, NULL))) THEN
    failed := failed || 'the owner''s keyword search missed an item'::text;
  END IF;

  i_v1 := brain_item_upsert(a_acct, 'note', 'bs-v1', NULL, NULL, NULL, 'alpha topic', false, NULL, u_owner, NULL);
  i_v2 := brain_item_upsert(a_acct, 'note', 'bs-v2', NULL, NULL, NULL, 'beta topic', false, NULL, u_owner, NULL);
  PERFORM brain_embedding_put(a_acct, i_v1, 'm-verify', ARRAY[1, 0, 0]::real[]);
  PERFORM brain_embedding_put(a_acct, i_v2, 'm-verify', ARRAY[0, 1, 0]::real[]);
  n := n + 1;
  IF (pg_temp.bs_find(u_owner, a_acct, NULL, ARRAY[0.1, 1, 0]::real[], 'm-verify'))[1] IS DISTINCT FROM i_v2
     OR (pg_temp.bs_find(u_owner, a_acct, NULL, ARRAY[1, 0.1, 0]::real[], 'm-verify'))[1] IS DISTINCT FROM i_v1 THEN
    failed := failed || 'cosine ranking did not put the matching vector first'::text;
  END IF;
  n := n + 1;
  IF (SELECT s.cosine FROM brain_search_candidates(u_owner, a_acct, NULL, ARRAY[1, 0, 0]::real[], 'm-other',
        NULL, NULL, NULL, 50) s WHERE s.item_id = i_v1) IS DISTINCT FROM 0 THEN
    failed := failed || 'cosine used another model''s embedding'::text;
  END IF;

  n := n + 1;
  IF cardinality(pg_temp.bs_find(gen_random_uuid(), a_acct, 'morning', ARRAY[1, 0, 0]::real[], 'm-verify')) <> 0
     OR cardinality(pg_temp.bs_find(u_out, a_acct, 'morning', ARRAY[1, 0, 0]::real[], 'm-verify')) <> 0
     OR cardinality(pg_temp.bs_find(u_viewer, a_acct, 'morning', ARRAY[1, 0, 0]::real[], 'm-verify')) <> 0
     OR cardinality(pg_temp.bs_find(u_guest, a_acct, 'morning', ARRAY[1, 0, 0]::real[], 'm-verify')) <> 0
     OR cardinality(pg_temp.bs_find(NULL, a_acct, 'morning', ARRAY[1, 0, 0]::real[], 'm-verify')) <> 0 THEN
    failed := failed || 'a stranger, viewer, guest or NULL actor got search rows'::text;
  END IF;

  n := n + 1;
  PERFORM brain_audit_record(a_acct, u_owner, v_hash, 3);
  SELECT count(*) INTO v_n FROM brain_audit
   WHERE account_id = a_acct AND actor = u_owner AND query_sha256 = v_hash AND result_count = 3;
  IF v_n <> 1 THEN failed := failed || 'brain_audit_record wrote no row'::text; END IF;
  SELECT string_agg(column_name::text, ',' ORDER BY column_name) INTO v_t FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'brain_audit';
  IF v_t IS DISTINCT FROM 'account_id,actor,at,audit_id,query_sha256,result_count' THEN
    failed := failed || format('brain_audit columns changed (a query text column?): %s', v_t);
  END IF;
  FOREACH v_t IN ARRAY ARRAY['brain verify query', upper(v_hash), left(v_hash, 63), ''] LOOP
    r := pg_temp.bs_try(format('SELECT public.brain_audit_record(%L, %L, %L, 1)::text', a_acct, u_owner, v_t));
    IF r NOT LIKE 'ERROR % HASH_INVALID:%' THEN failed := failed || format('audit hash %L accepted: %s', v_t, r); END IF;
  END LOOP;

  -- ---------- 8. deleting a contact ----------
  i_del := brain_item_upsert(a_acct, 'note', 'bs-del', NULL, c_del, NULL, 'watches osprey nests', false, NULL, u_owner, NULL);
  PERFORM brain_embedding_put(a_acct, i_del, 'm-verify', ARRAY[0, 0, 1]::real[]);
  DELETE FROM contacts WHERE id = c_del;
  n := n + 1;
  SELECT count(*) INTO v_n FROM brain_items WHERE item_id = i_del AND text = '' AND deleted_at IS NOT NULL;
  IF i_del IS NULL OR v_n <> 1 THEN failed := failed || 'deleting a contact did not wipe its items'::text; END IF;
  SELECT count(*) INTO v_n FROM brain_embeddings WHERE item_id = i_del;
  IF v_n <> 0 THEN failed := failed || 'deleting a contact kept its items'' embeddings'::text; END IF;

  -- ---------- 9. privileges ----------
  n := n + 1;
  FOREACH fn IN ARRAY ARRAY[
      'public.brain_actor_role(uuid, uuid)',
      'public.brain_contact_marked(uuid, uuid)',
      'public.brain_item_visible(uuid, uuid, uuid, text, uuid)',
      'public.brain_item_upsert(uuid, text, text, uuid, uuid, text, text, boolean, text, uuid, text)',
      'public.brain_embedding_put(uuid, uuid, text, real[])',
      'public.brain_contact_mark(uuid, uuid, uuid, text)',
      'public.brain_item_forget(uuid, text, uuid, uuid, uuid, timestamptz, text)',
      'public.brain_audit_record(uuid, uuid, text, integer)',
      'public.brain_search_candidates(uuid, uuid, text, real[], text, uuid, uuid, text, integer)',
      'public.case_settings_set_brain(uuid, uuid, boolean)'] LOOP
    IF has_function_privilege('authenticated', fn, 'EXECUTE') OR has_function_privilege('anon', fn, 'EXECUTE') THEN
      failed := failed || format('authenticated or anon may execute %s', fn);
    END IF;
    IF fn NOT LIKE 'public.brain_actor_role%' AND fn NOT LIKE 'public.brain_item_visible%'
       AND NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
      failed := failed || format('service_role may not execute %s', fn);
    END IF;
  END LOOP;

  n := n + 1;
  FOREACH tb IN ARRAY ARRAY['brain_items', 'brain_embeddings', 'brain_contact_marks', 'brain_audit'] LOOP
    IF has_table_privilege('service_role', 'public.' || tb, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || tb, 'SELECT')
       OR has_table_privilege('anon', 'public.' || tb, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || tb, 'INSERT') THEN
      failed := failed || format('a client role can read or write %s directly', tb);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
                    WHERE s.nspname = 'public' AND c.relname = tb
                      AND c.relrowsecurity AND c.relforcerowsecurity) THEN
      failed := failed || format('RLS not enabled and forced on %s', tb);
    END IF;
  END LOOP;

  RAISE EXCEPTION USING ERRCODE = 'ZT194', MESSAGE = 'verify-second-brain rollback';
  EXCEPTION WHEN SQLSTATE 'ZT194' THEN
    NULL;  -- fixtures undone; results kept
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'second brain verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'second brain verification: % checks passed', n;
END
$verify$;
