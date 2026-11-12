-- Behavioural regression suite for second brain pages (migration 195)
-- and the digest's message source (migration 196).
--
-- brain_pages holds one AI summary per case / contact / bank, built
-- from brain_items (194) and written only through brain_page_put at an
-- expected version. This asserts, through the real functions and
-- triggers: mark_dirty (version-0 pages, idempotent, never a marked
-- contact's page); the sources (restricted, forgotten and marked items
-- left out, newest first, capped); put (happy path, CONFLICT,
-- TEXT_UNREDACTED, ITEM_NOT_FOUND, still dirty when a newer source was
-- not fed); the fail-closed read (who reads a case page, a source that
-- turns invisible after the build, a non-uuid case key); forgetting an
-- item, a contact and a page, and who may forget a page; the
-- contact-delete trigger; brain_digest_messages; and the privileges.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000195001';
  u_admin  UUID := '00000000-0000-4000-8000-000000195002';
  u_agent  UUID := '00000000-0000-4000-8000-000000195004';
  u_agent2 UUID := '00000000-0000-4000-8000-000000195005';
  u_viewer UUID := '00000000-0000-4000-8000-000000195007';
  u_out    UUID := '00000000-0000-4000-8000-000000195010';  -- another workspace
  a_acct   UUID;
  c1 UUID; c2 UUID; c3 UUID; c4 UUID; c_mark UUID; c_del UUID; c_other UUID;
  k1       UUID;  -- a lead case of c1, agent u_agent
  k4       UUID;  -- a lead case of c4, agent u_agent
  i_k1 UUID; i_k2 UUID; i_r UUID; i_fg UUID; i_m UUID; i_other UUID;
  i_b UUID; i_c2 UUID; i_c2b UUID; i_c3 UUID; i_d UUID;
  i_msg UUID; i_sys UUID; i_old UUID; i_m4 UUID;
  v_ids    UUID[];
  v_t      TEXT;
  v_n      INT;
  v_b      BOOLEAN;
  v_j      JSONB;
  v_ts     TIMESTAMPTZ;
  fn       TEXT;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as the table owner: 'ok' / the value, or
  -- 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.bp_try(p_sql text)
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

  -- A put call as SQL text (for refusals).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.bp_put(p_acct uuid, p_kind text, p_key text, p_ver int,
      p_summary text, p_ids uuid[])
    RETURNS text LANGUAGE sql AS $body$
      SELECT format('SELECT public.brain_page_put(%L, %L, %L, %s, %L, %L::uuid[])::text',
                    p_acct, p_kind, p_key, coalesce(p_ver::text, 'NULL'), p_summary, p_ids)
    $body$
  $fn$;

  -- Rows a read returns for one actor.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.bp_reads(p_actor uuid, p_acct uuid, p_kind text, p_key text)
    RETURNS int LANGUAGE sql AS $body$
      SELECT count(*)::int FROM public.brain_page_read(p_actor, p_acct, p_kind, p_key)
    $body$
  $fn$;

  -- Item ids the digest returns, as an array.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.bp_digest(p_acct uuid, p_actor uuid, p_since timestamptz)
    RETURNS uuid[] LANGUAGE sql AS $body$
      SELECT coalesce(array_agg(d.item_id), '{}')
        FROM public.brain_digest_messages(p_acct, p_actor, p_since) d
    $body$
  $fn$;

  -- ---------- fixture ----------
  -- The auth.users trigger provisions each person an account of their
  -- own; everyone but the owner and u_out moves into the owner's.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'bp-owner@example.invalid'),
    (u_admin,  'bp-admin@example.invalid'),
    (u_agent,  'bp-agent@example.invalid'),
    (u_agent2, 'bp-agent2@example.invalid'),
    (u_viewer, 'bp-viewer@example.invalid'),
    (u_out,    'bp-out@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  IF a_acct IS NULL OR NOT EXISTS (SELECT 1 FROM accounts WHERE owner_user_id = u_out AND id <> a_acct) THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  INSERT INTO case_banks (account_id, code, name) VALUES (a_acct, 'ADCB', 'ADCB') ON CONFLICT DO NOTHING;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_agent2);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;

  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500195001', 'BP 1') RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500195002', 'BP 2') RETURNING id INTO c2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500195003', 'BP 3') RETURNING id INTO c3;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500195004', 'BP 4') RETURNING id INTO c4;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500195005', 'BP 5') RETURNING id INTO c_mark;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500195006', 'BP 6') RETURNING id INTO c_del;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500195007', 'BP 7') RETURNING id INTO c_other;
  k1 := case_open_lead(u_agent, a_acct, c1, 'ADCB', 'Loan', u_agent, 1000);
  k4 := case_open_lead(u_agent, a_acct, c4, 'ADCB', 'Loan', u_agent, 1000);
  IF k1 IS NULL OR k4 IS NULL THEN
    RAISE EXCEPTION 'fixture: case_open_lead returned NULL';
  END IF;
  v_b := case_settings_set_brain(u_owner, a_acct, true);

  -- Case k1: two live sources (i_k2 newer), one restricted, one forgotten.
  i_k1 := brain_item_upsert(a_acct, 'note', 'bp-k1', k1, c1, 'ADCB', 'salary letter pending', false, NULL, u_agent, NULL);
  i_k2 := brain_item_upsert(a_acct, 'note', 'bp-k2', k1, c1, NULL, 'bank asked for payslips', false, NULL, u_owner, NULL);
  i_r  := brain_item_upsert(a_acct, 'note', 'bp-r',  k1, c1, NULL, 'internal pricing remark', false, 'admin', u_owner, NULL);
  i_fg := brain_item_upsert(a_acct, 'note', 'bp-fg', k1, c1, NULL, 'a fact soon forgotten', false, NULL, u_owner, NULL);
  i_m  := brain_item_upsert(a_acct, 'note', 'bp-m',  NULL, c_mark, NULL, 'likes tea', false, NULL, u_owner, NULL);
  i_other := brain_item_upsert(a_acct, 'note', 'bp-o', NULL, c_other, NULL, 'unrelated fact', false, NULL, u_owner, NULL);
  IF i_k1 IS NULL OR i_k2 IS NULL OR i_r IS NULL OR i_fg IS NULL OR i_m IS NULL OR i_other IS NULL THEN
    RAISE EXCEPTION 'fixture: an item was not stored';
  END IF;
  UPDATE brain_items SET created_at = now() - interval '20 minutes' WHERE item_id = i_k1;
  UPDATE brain_items SET created_at = now() - interval '10 minutes' WHERE item_id = i_k2;
  v_n := brain_item_forget(u_owner, NULL, a_acct, i_fg, NULL, NULL, 'verify');
  IF v_n <> 1 THEN RAISE EXCEPTION 'fixture: forgetting i_fg counted %', v_n; END IF;

  -- ---------- 1. mark_dirty ----------
  n := n + 1;
  v_n := brain_page_mark_dirty(a_acct, ARRAY[i_k1]);
  SELECT count(*) INTO v_t FROM brain_pages
   WHERE account_id = a_acct AND version = 0 AND dirty AND built_at IS NULL AND deleted_at IS NULL AND summary = ''
     AND (kind, key) IN (('case', k1::text), ('contact', c1::text), ('bank', 'ADCB'));
  IF v_n <> 3 OR v_t <> '3' THEN
    failed := failed || format('mark_dirty did not create the case / contact / bank pages at version 0 (%s, %s rows)', v_n, v_t);
  END IF;

  n := n + 1;
  v_n := brain_page_mark_dirty(a_acct, ARRAY[i_k1, i_k2]);
  SELECT count(*) INTO v_t FROM brain_pages WHERE account_id = a_acct;
  IF v_n <> 0 OR v_t <> '3' THEN
    failed := failed || format('mark_dirty not idempotent (%s changed, %s pages)', v_n, v_t);
  END IF;
  IF brain_page_version(a_acct, 'case', k1::text) IS DISTINCT FROM 0 THEN
    failed := failed || 'brain_page_version of a new page is not 0'::text;
  END IF;

  n := n + 1;
  SELECT coalesce(array_agg(s.item_id), '{}') INTO v_ids FROM brain_page_sources(a_acct, 'contact', c_mark::text, 50) s;
  IF NOT (i_m = ANY (v_ids)) THEN failed := failed || 'fixture: an unmarked contact''s item is not a source'::text; END IF;
  PERFORM brain_contact_mark(u_agent, a_acct, c_mark, 'opt_out');
  v_n := brain_page_mark_dirty(a_acct, ARRAY[i_m]);
  SELECT count(*) INTO v_t FROM brain_pages WHERE account_id = a_acct AND key = c_mark::text;
  IF v_t <> '0' THEN failed := failed || 'mark_dirty created a marked contact''s page'::text; END IF;

  -- ---------- 2. sources ----------
  n := n + 1;
  SELECT coalesce(array_agg(s.item_id ORDER BY s.ordinality), '{}') INTO v_ids
    FROM brain_page_sources(a_acct, 'case', k1::text, 200) WITH ORDINALITY s;
  IF v_ids IS DISTINCT FROM ARRAY[i_k2, i_k1] THEN
    failed := failed || format('case sources are not [newer, older] without restricted / forgotten items: %s', v_ids);
  END IF;
  n := n + 1;
  SELECT coalesce(array_agg(s.item_id), '{}') INTO v_ids FROM brain_page_sources(a_acct, 'case', k1::text, 1) s;
  IF v_ids IS DISTINCT FROM ARRAY[i_k2] THEN failed := failed || format('sources not capped to the newest: %s', v_ids); END IF;
  n := n + 1;
  SELECT coalesce(array_agg(s.item_id), '{}') INTO v_ids FROM brain_page_sources(a_acct, 'contact', c_mark::text, 50) s;
  IF cardinality(v_ids) <> 0 THEN failed := failed || 'a marked contact''s item is still a source'::text; END IF;

  -- ---------- 3. put ----------
  n := n + 1;
  r := pg_temp.bp_try(pg_temp.bp_put(a_acct, 'case', k1::text, 5, 'case summary', ARRAY[i_k1]));
  IF r NOT LIKE 'ERROR % CONFLICT:%' THEN failed := failed || format('put at a wrong version accepted: %s', r); END IF;
  n := n + 1;
  r := pg_temp.bp_try(pg_temp.bp_put(a_acct, 'case', k1::text, 0, 'call 050 123 4567', ARRAY[i_k1]));
  IF r NOT LIKE 'ERROR % TEXT_UNREDACTED:%' THEN failed := failed || format('put with a phone number accepted: %s', r); END IF;
  n := n + 1;
  FOREACH v_t IN ARRAY ARRAY[i_other::text, i_r::text, i_fg::text, 'NULL'] LOOP
    r := pg_temp.bp_try(format('SELECT public.brain_page_put(%L, %L, %L, 0, %L, ARRAY[%L, %s]::uuid[])::text',
                               a_acct, 'case', k1, 'case summary', i_k1,
                               CASE WHEN v_t = 'NULL' THEN 'NULL' ELSE quote_literal(v_t) END));
    IF r NOT LIKE 'ERROR % ITEM_NOT_FOUND:%' THEN failed := failed || format('put with non-source item %s accepted: %s', v_t, r); END IF;
  END LOOP;
  n := n + 1;
  r := pg_temp.bp_try(pg_temp.bp_put(a_acct, 'case', k1::text, 0, repeat('a', 8001), ARRAY[i_k1]));
  IF r NOT LIKE 'ERROR % TEXT_INVALID:%' THEN failed := failed || format('put of 8001 chars accepted: %s', r); END IF;

  n := n + 1;
  v_n := brain_page_put(a_acct, 'case', k1::text, 0, 'case summary', ARRAY[i_k1]);
  SELECT format('%s/%s/%s/%s', version, dirty, built_at IS NOT NULL, summary) INTO v_t
    FROM brain_pages WHERE account_id = a_acct AND kind = 'case' AND key = k1::text;
  IF v_n <> 1 OR v_t IS DISTINCT FROM '1/t/t/case summary' THEN
    failed := failed || format('put without the newer source: returned %s, page %s (want 1, still dirty)', v_n, v_t);
  END IF;
  n := n + 1;
  v_n := brain_page_put(a_acct, 'case', k1::text, 1, 'case summary two', ARRAY[i_k2, i_k1]);
  SELECT format('%s/%s/%s', version, dirty, cardinality(built_from_item_ids)) INTO v_t
    FROM brain_pages WHERE account_id = a_acct AND kind = 'case' AND key = k1::text;
  IF v_n <> 2 OR v_t IS DISTINCT FROM '2/f/2' THEN
    failed := failed || format('put with every source: returned %s, page %s (want 2, clean)', v_n, v_t);
  END IF;

  -- ---------- 4. read ----------
  n := n + 1;
  SELECT format('%s/%s', p.summary, p.version), p.sources INTO v_t, v_j
    FROM brain_page_read(u_owner, a_acct, 'case', k1::text) p;
  IF v_t IS DISTINCT FROM 'case summary two/2' OR jsonb_array_length(coalesce(v_j, '[]')) <> 2 THEN
    failed := failed || format('the owner''s read of the case page: %s, sources %s', v_t, v_j);
  END IF;
  n := n + 1;
  SELECT string_agg(format('%s=%s', w.who, x.got), ', ') INTO v_t
    FROM (VALUES ('owner', u_owner, 1), ('admin', u_admin, 1), ('agent', u_agent, 1),
                 ('agent2', u_agent2, 0), ('viewer', u_viewer, 0), ('out', u_out, 0),
                 ('stranger', '00000000-0000-4000-8000-000000195099'::uuid, 0), ('null', NULL::uuid, 0))
           AS w(who, uid, want)
   CROSS JOIN LATERAL (SELECT pg_temp.bp_reads(w.uid, a_acct, 'case', k1::text) AS got) x
   WHERE x.got IS DISTINCT FROM w.want;
  IF v_t IS NOT NULL THEN failed := failed || format('case page read rule wrong: %s', v_t); END IF;

  n := n + 1;
  UPDATE brain_items SET restricted_role = 'admin' WHERE item_id = i_k1;
  v_n := pg_temp.bp_reads(u_agent, a_acct, 'case', k1::text);
  IF v_n <> 0 OR pg_temp.bp_reads(u_owner, a_acct, 'case', k1::text) <> 1 THEN
    failed := failed || format('a source restricted after the build: agent read %s rows (want 0, owner 1)', v_n);
  END IF;
  UPDATE brain_items SET restricted_role = NULL WHERE item_id = i_k1;
  IF pg_temp.bp_reads(u_agent, a_acct, 'case', k1::text) <> 1 THEN
    failed := failed || 'fixture: lifting the restriction did not restore the agent''s read'::text;
  END IF;

  n := n + 1;
  r := pg_temp.bp_try(format('SELECT count(*)::text FROM public.brain_page_read(%L, %L, %L, %L)', u_owner, a_acct, 'case', 'not-a-uuid'));
  IF r IS DISTINCT FROM '0' THEN failed := failed || format('a non-uuid case key: %s (want 0 rows)', r); END IF;
  n := n + 1;
  r := pg_temp.bp_try(format('INSERT INTO public.brain_pages (account_id, kind, key) VALUES (%L, %L, %L)',
                             a_acct, 'case', upper(k1::text)));
  IF r NOT LIKE 'ERROR 23514 %brain_pages_key_uuid%' THEN failed := failed || format('a non-canonical case key was stored: %s', r); END IF;

  -- A contact page whose one source's contact is marked after the build.
  i_c3 := brain_item_upsert(a_acct, 'note', 'bp-c3', NULL, c3, NULL, 'prefers email', false, NULL, u_owner, NULL);
  v_n := brain_page_mark_dirty(a_acct, ARRAY[i_c3]);
  v_n := brain_page_put(a_acct, 'contact', c3::text, 0, 'contact summary', ARRAY[i_c3]);
  n := n + 1;
  IF pg_temp.bp_reads(u_owner, a_acct, 'contact', c3::text) <> 1 THEN
    failed := failed || 'the owner cannot read a built contact page'::text;
  END IF;

  -- ---------- 5. page_forget actor rules ----------
  n := n + 1;
  r := pg_temp.bp_try(format('SELECT public.brain_page_forget(%L, NULL, %L, %L, %L)::text', u_agent, a_acct, c3, 'verify'));
  IF r NOT LIKE 'ERROR % NOT_ALLOWED:%' THEN failed := failed || format('an agent forgot an unmarked contact''s page: %s', r); END IF;
  r := pg_temp.bp_try(format('SELECT public.brain_page_forget(%L, NULL, %L, %L, %L)::text', u_viewer, a_acct, c3, 'verify'));
  IF r NOT LIKE 'ERROR % NOT_ALLOWED:%' THEN failed := failed || format('a viewer forgot a contact''s page: %s', r); END IF;
  r := pg_temp.bp_try(format('SELECT public.brain_page_forget(NULL, %L, %L, %L, %L)::text', 'system:other', a_acct, c3, 'verify'));
  IF r NOT LIKE 'ERROR % NOT_ALLOWED:%' THEN failed := failed || format('an unknown system label forgot a page: %s', r); END IF;
  r := pg_temp.bp_try(format('SELECT public.brain_page_forget(%L, NULL, %L, %L, %L)::text', u_owner, a_acct, c3, ' '));
  IF r NOT LIKE 'ERROR % SCOPE_INVALID:%' THEN failed := failed || format('a blank page-forget reason accepted: %s', r); END IF;
  SELECT count(*) INTO v_t FROM brain_pages WHERE account_id = a_acct AND key = c3::text AND deleted_at IS NULL AND summary <> '';
  IF v_t <> '1' THEN failed := failed || 'a refused page forget changed the page'::text; END IF;

  PERFORM brain_contact_mark(u_agent, a_acct, c3, 'opt_out');
  n := n + 1;
  IF pg_temp.bp_reads(u_owner, a_acct, 'contact', c3::text) <> 0 THEN
    failed := failed || 'a contact page was read after its contact was marked'::text;
  END IF;
  n := n + 1;
  r := pg_temp.bp_try(format('SELECT public.brain_page_forget(%L, NULL, %L, %L, %L)::text', u_agent, a_acct, c3, 'verify'));
  SELECT count(*) INTO v_t FROM brain_pages
   WHERE account_id = a_acct AND kind = 'contact' AND key = c3::text AND deleted_at IS NOT NULL AND summary = '';
  IF r LIKE 'ERROR%' OR v_t <> '1' THEN
    failed := failed || format('an agent could not forget a marked contact''s page: %s (%s tombstones)', r, v_t);
  END IF;

  -- ---------- 6. forgetting an item ----------
  i_b := brain_item_upsert(a_acct, 'note', 'bp-b', NULL, NULL, 'FAB', 'FAB wants six payslips', false, NULL, u_owner, NULL);
  v_n := brain_page_mark_dirty(a_acct, ARRAY[i_b]);
  v_n := brain_page_put(a_acct, 'bank', 'FAB', 0, 'FAB summary', ARRAY[i_b]);
  n := n + 1;
  IF v_n <> 1 OR pg_temp.bp_reads(u_owner, a_acct, 'bank', 'FAB') <> 1 THEN
    failed := failed || 'fixture: the FAB bank page was not built or not readable'::text;
  END IF;
  v_n := brain_item_forget(u_owner, NULL, a_acct, i_b, NULL, NULL, 'verify');
  n := n + 1;
  SELECT format('%s/%s/%s/%s/%s', summary = '', built_at IS NULL, dirty, version, deleted_at IS NULL) INTO v_t
    FROM brain_pages WHERE account_id = a_acct AND kind = 'bank' AND key = 'FAB';
  IF v_t IS DISTINCT FROM 't/t/t/2/t' THEN
    failed := failed || format('forgetting the source did not wipe the page: %s', v_t);
  END IF;
  IF pg_temp.bp_reads(u_owner, a_acct, 'bank', 'FAB') <> 0 THEN
    failed := failed || 'a wiped page was read'::text;
  END IF;

  -- ---------- 7. forgetting a contact ----------
  i_c2 := brain_item_upsert(a_acct, 'note', 'bp-c2', NULL, c2, NULL, 'works nights', false, NULL, u_owner, NULL);
  v_n := brain_page_mark_dirty(a_acct, ARRAY[i_c2]);
  v_n := brain_page_put(a_acct, 'contact', c2::text, 0, 'contact two summary', ARRAY[i_c2]);
  v_n := brain_item_forget(u_owner, NULL, a_acct, NULL, c2, NULL, 'verify');
  n := n + 1;
  SELECT count(*) INTO v_t FROM brain_pages
   WHERE account_id = a_acct AND kind = 'contact' AND key = c2::text AND deleted_at IS NOT NULL AND summary = ''
     AND cardinality(built_from_item_ids) = 0 AND NOT dirty;
  IF v_n <> 1 OR v_t <> '1' THEN
    failed := failed || format('a contact forget did not tombstone its page (%s items, %s tombstones)', v_n, v_t);
  END IF;
  i_c2b := brain_item_upsert(a_acct, 'note', 'bp-c2b', NULL, c2, NULL, 'a later fact', false, NULL, u_owner, NULL);
  v_n := brain_page_mark_dirty(a_acct, ARRAY[i_c2b]);
  n := n + 1;
  SELECT count(*) INTO v_t FROM brain_pages
   WHERE account_id = a_acct AND kind = 'contact' AND key = c2::text AND deleted_at IS NOT NULL AND NOT dirty;
  IF i_c2b IS NULL OR v_n <> 0 OR v_t <> '1' THEN
    failed := failed || format('mark_dirty reopened a tombstoned contact page (%s, %s)', v_n, v_t);
  END IF;
  r := pg_temp.bp_try(pg_temp.bp_put(a_acct, 'contact', c2::text, 1, 'back again', ARRAY[i_c2b]));
  IF r NOT LIKE 'ERROR % PAGE_NOT_FOUND:%' THEN failed := failed || format('put wrote a tombstoned page: %s', r); END IF;

  -- ---------- 8. deleting a contact ----------
  i_d := brain_item_upsert(a_acct, 'note', 'bp-d', NULL, c_del, NULL, 'keeps pigeons', false, NULL, u_owner, NULL);
  v_n := brain_page_mark_dirty(a_acct, ARRAY[i_d]);
  v_n := brain_page_put(a_acct, 'contact', c_del::text, 0, 'deleted contact summary', ARRAY[i_d]);
  DELETE FROM contacts WHERE id = c_del;
  n := n + 1;
  SELECT count(*) INTO v_t FROM brain_pages
   WHERE account_id = a_acct AND kind = 'contact' AND key = c_del::text AND deleted_at IS NOT NULL AND summary = '';
  IF v_n <> 1 OR v_t <> '1' THEN failed := failed || 'deleting a contact did not tombstone its page'::text; END IF;

  -- ---------- 9. digest messages ----------
  i_msg := brain_item_upsert(a_acct, 'message', 'bp-msg', k1, c1, NULL, 'sent the salary letter', false, NULL, u_agent, NULL);
  i_sys := brain_item_upsert(a_acct, 'message', 'bp-sys', k1, c1, NULL, 'welcome message sent', false, NULL, NULL, 'system:welcome');
  i_old := brain_item_upsert(a_acct, 'message', 'bp-old', k1, c1, NULL, 'an old update', false, NULL, u_agent, NULL);
  i_m4  := brain_item_upsert(a_acct, 'message', 'bp-m4',  k4, c4, NULL, 'chased the bank', false, NULL, u_agent, NULL);
  IF i_msg IS NULL OR i_sys IS NULL OR i_old IS NULL OR i_m4 IS NULL THEN
    RAISE EXCEPTION 'fixture: a message item was not stored';
  END IF;
  UPDATE brain_items SET created_at = now() - interval '3 days' WHERE item_id = i_old;
  v_ts := now() - interval '1 day';

  n := n + 1;
  v_ids := pg_temp.bp_digest(a_acct, u_agent, v_ts);
  IF NOT (i_msg = ANY (v_ids)) OR NOT (i_m4 = ANY (v_ids)) THEN
    failed := failed || format('the digest missed the case agent''s own messages: %s', v_ids);
  END IF;
  IF i_k1 = ANY (v_ids) THEN failed := failed || 'the digest returned a note'::text; END IF;
  n := n + 1;
  IF i_sys = ANY (v_ids) THEN failed := failed || 'the digest returned a system-label message'::text; END IF;
  n := n + 1;
  IF i_old = ANY (v_ids) OR NOT (i_old = ANY (pg_temp.bp_digest(a_acct, u_agent, now() - interval '4 days'))) THEN
    failed := failed || 'the digest does not follow p_since'::text;
  END IF;
  n := n + 1;
  IF cardinality(pg_temp.bp_digest(a_acct, u_agent2, v_ts)) <> 0
     OR cardinality(pg_temp.bp_digest(a_acct, u_viewer, v_ts)) <> 0
     OR cardinality(pg_temp.bp_digest(a_acct, u_out, v_ts)) <> 0 THEN
    failed := failed || 'the digest returned messages to another agent, a viewer or a stranger'::text;
  END IF;
  n := n + 1;
  PERFORM brain_contact_mark(u_agent, a_acct, c4, 'opt_out');
  IF i_m4 = ANY (pg_temp.bp_digest(a_acct, u_agent, v_ts)) THEN
    failed := failed || 'the digest returned a marked contact''s message'::text;
  END IF;

  -- ---------- 10. privileges ----------
  n := n + 1;
  FOREACH fn IN ARRAY ARRAY[
      'public.brain_page_sources(uuid, text, text, integer)',
      'public.brain_page_mark_dirty(uuid, uuid[])',
      'public.brain_page_dirty_list(uuid, integer)',
      'public.brain_page_dirty_count(uuid)',
      'public.brain_page_version(uuid, text, text)',
      'public.brain_page_put(uuid, text, text, integer, text, uuid[])',
      'public.brain_page_read(uuid, uuid, text, text)',
      'public.brain_page_forget(uuid, text, uuid, uuid, text)',
      'public.brain_item_forget(uuid, text, uuid, uuid, uuid, timestamptz, text)',
      'public.brain_digest_messages(uuid, uuid, timestamptz)'] LOOP
    IF has_function_privilege('authenticated', fn, 'EXECUTE') OR has_function_privilege('anon', fn, 'EXECUTE') THEN
      failed := failed || format('authenticated or anon may execute %s', fn);
    END IF;
    IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
      failed := failed || format('service_role may not execute %s', fn);
    END IF;
  END LOOP;

  n := n + 1;
  SELECT count(*) INTO v_n
    FROM pg_proc p
   WHERE p.oid = 'public.brain_page_wipe(uuid, uuid[], uuid)'::regprocedure
     AND (p.proacl IS NULL
          OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner));
  IF v_n <> 0 THEN failed := failed || 'someone besides its owner may execute brain_page_wipe'::text; END IF;

  n := n + 1;
  IF has_table_privilege('service_role', 'public.brain_pages', 'SELECT')
     OR has_table_privilege('authenticated', 'public.brain_pages', 'SELECT')
     OR has_table_privilege('anon', 'public.brain_pages', 'SELECT')
     OR has_table_privilege('authenticated', 'public.brain_pages', 'INSERT') THEN
    failed := failed || 'a client role can read or write brain_pages directly'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
                  WHERE s.nspname = 'public' AND c.relname = 'brain_pages'
                    AND c.relrowsecurity AND c.relforcerowsecurity) THEN
    failed := failed || 'RLS not enabled and forced on brain_pages'::text;
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT195', MESSAGE = 'verify-brain-pages rollback';
  EXCEPTION WHEN SQLSTATE 'ZT195' THEN
    NULL;  -- fixtures undone; results kept
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'brain pages verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'brain pages verification: % checks passed', n;
END
$verify$;
