-- Behavioural regression suite for migration 178: customer documents.
-- Reference formatting; customer_documents_record (folders, refs,
-- idempotency, refusals, truncation); the NAS worker's claim / existing
-- / settle; who may execute and write; who sees what under RLS; and a
-- person's customer_documents_retry.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back by a sentinel exception; the results survive in plpgsql
-- variables. now() is fixed for the whole transaction, so a claim made
-- here is never older than 15 minutes and next_attempt_at defaults to
-- the same now() the checks compare with.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000178001';
  u_agent  UUID := '00000000-0000-4000-8000-000000178002'; -- owns c1
  u_other  UUID := '00000000-0000-4000-8000-000000178003'; -- agent who cannot see c1 or c2
  u_admin  UUID := '00000000-0000-4000-8000-000000178004';
  u_gone   UUID := '00000000-0000-4000-8000-000000178005'; -- deactivated admin
  u_far    UUID := '00000000-0000-4000-8000-000000178006'; -- owner of another account
  sha_a    TEXT := repeat('a', 64);
  sha_b    TEXT := repeat('b', 64);
  sig_rec  TEXT := 'public.customer_documents_record(uuid,uuid,text,text,text,timestamptz,uuid,uuid,bigint,text,text,text)';
  sig_clm  TEXT := 'public.customer_documents_claim(integer)';
  sig_ext  TEXT := 'public.customer_documents_existing(uuid,text)';
  sig_stl  TEXT := 'public.customer_documents_settle(uuid,text,text,bigint,text,text)';
  sig_rty  TEXT := 'public.customer_documents_retry(uuid)';
  a_acct   UUID;
  b_acct   UUID;
  w1       UUID;
  c1       UUID;
  c2       UUID;
  cfar     UUID;
  cv1      UUID;
  cv2      UUID;
  m1       UUID;
  m2       UUID;
  m3       UUID;
  ma       UUID;
  m4       UUID;
  m5       UUID;
  g1       UUID;
  gm1      BIGINT;
  d1       UUID;
  d2       UUID;
  d4       UUID;
  d5       UUID;
  dg       UUID;
  f1       UUID;
  f2       UUID;
  docs     UUID[];
  folders  UUID[];
  ref1     TEXT;
  ref2     TEXT;
  r        TEXT;
  b        BOOLEAN;
  x        TIMESTAMPTZ;
  i        INT;
  ids      UUID[];
  acc      JSONB;
  doc      RECORD;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a SELECT as p_role (NULL: as the current user) signed in as
  -- p_uid: its value, or 'ERROR <sqlstate> [<hint>]: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cd_try(p_role text, p_uid uuid, p_sql text)
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
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'NULL');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ' [' || coalesce(h, '') || ']: ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cd_ok(p_ok boolean, p_msg text)
    RETURNS text[] LANGUAGE sql AS $body$
      SELECT CASE WHEN coalesce(p_ok, false) THEN '{}'::text[] ELSE ARRAY[p_msg] END
    $body$
  $fn$;
  -- A chat record call, as the current user, for the refusal cases.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cd_rec(p_acct uuid, p_contact uuid, p_url text, p_conv uuid,
                                   p_msg uuid, p_gm bigint)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.cd_try(NULL, NULL, format(
        'SELECT public.customer_documents_record(%L, %L, ''chat'', ''document'', %L, now(), %L, %L, %L)',
        p_acct, p_contact, p_url, p_conv, p_msg, p_gm))
    $body$
  $fn$;
  -- How many of p_ids the signed-in person's RLS shows in p_table.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cd_sees(p_uid uuid, p_table text, p_ids uuid[])
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.cd_try('authenticated', p_uid, format(
        'SELECT count(*)::text FROM public.%I WHERE id = ANY (%L::uuid[])', p_table, p_ids))
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'cd-owner@example.invalid'), (u_agent, 'cd-agent@example.invalid'),
    (u_other, 'cd-other@example.invalid'), (u_admin, 'cd-admin@example.invalid'),
    (u_gone,  'cd-gone@example.invalid'),  (u_far,   'cd-far@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_far;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_other);
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id IN (u_admin, u_gone);
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CD-178-A1', 'x', 'connected', true) RETURNING id INTO w1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500178001', 'CD one')
    RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500178002', 'CD two')
    RETURNING id INTO c2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b_acct, u_far, '971500178003', 'CD far')
    RETURNING id INTO cfar;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, c1) RETURNING id INTO cv1;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_owner, c2) RETURNING id INTO cv2;
  INSERT INTO messages (conversation_id, sender_type, content_type, media_url)
    VALUES (cv1, 'customer', 'document', 'https://x.invalid/1.pdf') RETURNING id INTO m1;
  INSERT INTO messages (conversation_id, sender_type, content_type, media_url)
    VALUES (cv1, 'customer', 'image', 'https://x.invalid/2.jpg') RETURNING id INTO m2;
  INSERT INTO messages (conversation_id, sender_type, content_type, media_url)
    VALUES (cv1, 'customer', 'document', 'https://x.invalid/3.pdf') RETURNING id INTO m3;
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_type, media_url)
    VALUES (cv1, 'agent', u_agent, 'document', 'https://x.invalid/a.pdf') RETURNING id INTO ma;
  INSERT INTO messages (conversation_id, sender_type, content_type, media_url)
    VALUES (cv2, 'customer', 'document', 'https://x.invalid/4.pdf') RETURNING id INTO m4;
  INSERT INTO messages (conversation_id, sender_type, content_type, media_url)
    VALUES (cv2, 'customer', 'document', 'https://x.invalid/5.pdf') RETURNING id INTO m5;

  acc := jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent'));
  g1 := (SELECT o.group_id FROM sg_open(a_acct, 'CD-178-G', c1, w1, 'g', NULL, acc, NULL, 'group') o);
  IF g1 IS NULL THEN
    RAISE EXCEPTION 'fixture: sg_open returned no group';
  END IF;
  b := sg_record_inbound(g1, 'cd-178-1', '971500178001', 'customer', 'document', NULL,
                         '{"url": "https://x.invalid/g.pdf"}'::jsonb, now());
  SELECT id INTO gm1 FROM submission_group_messages WHERE group_id = g1 AND wa_message_id = 'cd-178-1';
  IF gm1 IS NULL THEN
    RAISE EXCEPTION 'fixture: sg_record_inbound stored no message';
  END IF;

  -- ---------- (a) reference formatting ----------
  n := n + 1; failed := failed || pg_temp.cd_ok(customer_doc_format_ref(1) = 'TC-000001',
    format('format_ref(1) is %s', customer_doc_format_ref(1)));
  n := n + 1; failed := failed || pg_temp.cd_ok(customer_doc_format_ref(999999) = 'TC-999999',
    format('format_ref(999999) is %s', customer_doc_format_ref(999999)));
  n := n + 1; failed := failed || pg_temp.cd_ok(customer_doc_format_ref(1000000) = 'TC-1000000',
    format('format_ref(1000000) is %s', customer_doc_format_ref(1000000)));

  -- ---------- (b) record ----------
  ref1 := customer_documents_record(a_acct, c1, 'chat', 'document', 'https://x.invalid/1.pdf', now(),
                                    cv1, m1, NULL, 'application/pdf', '1.pdf', 'first');
  SELECT id INTO f1 FROM customer_doc_folders WHERE contact_id = c1;
  n := n + 1; failed := failed || pg_temp.cd_ok(ref1 ~ '^TC-[0-9]{6,}$' AND f1 IS NOT NULL
    AND (SELECT ref FROM customer_doc_folders WHERE id = f1) = ref1,
    format('the first document did not create a TC- folder (ref %s)', ref1));
  r := customer_documents_record(a_acct, c1, 'chat', 'image', 'https://x.invalid/2.jpg', now(), cv1, m2);
  n := n + 1; failed := failed || pg_temp.cd_ok(r = ref1
    AND (SELECT count(*) FROM customer_doc_folders WHERE contact_id = c1) = 1,
    format('a second document of the contact did not reuse its folder (%s vs %s)', r, ref1));
  ref2 := customer_documents_record(a_acct, c2, 'chat', 'document', 'https://x.invalid/4.pdf', now(), cv2, m4);
  SELECT id INTO f2 FROM customer_doc_folders WHERE contact_id = c2;
  n := n + 1; failed := failed || pg_temp.cd_ok(ref2 ~ '^TC-[0-9]{6,}$' AND ref2 <> ref1 AND f2 <> f1,
    format('another contact did not get its own folder (%s vs %s)', ref2, ref1));
  r := customer_documents_record(a_acct, c1, 'chat', 'document', 'https://x.invalid/1.pdf', now(), cv1, m1);
  n := n + 1; failed := failed || pg_temp.cd_ok(r = ref1
    AND (SELECT count(*) FROM customer_documents WHERE message_id = m1) = 1,
    format('recording a message twice did not return the same ref and keep one row (%s)', r));
  r := customer_documents_record(a_acct, c2, 'chat', 'document', 'https://x.invalid/5.pdf', now(), cv2, m5,
                                 NULL, repeat('m', 200), repeat('n', 300), repeat('c', 1200));
  SELECT * INTO doc FROM customer_documents WHERE message_id = m5;
  n := n + 1; failed := failed || pg_temp.cd_ok(char_length(doc.mime) = 127
    AND char_length(doc.original_name) = 255 AND char_length(doc.caption) = 1000,
    'record did not truncate mime / original_name / caption to 127 / 255 / 1000');
  r := customer_documents_record(a_acct, c1, 'submission_group', 'document', 'https://x.invalid/g.pdf', now(),
                                 NULL, NULL, gm1);
  n := n + 1; failed := failed || pg_temp.cd_ok(r = ref1
    AND (SELECT source FROM customer_documents WHERE group_message_id = gm1) = 'submission_group',
    format('a submission group document did not land in the contact''s folder (%s)', r));

  -- Refusals.
  r := pg_temp.cd_rec(a_acct, c1, 'https://x.invalid/a.pdf', cv1, ma, NULL);
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [NOT_FOUND]%',
    format('record accepted an agent-sent message (%s)', r));
  r := pg_temp.cd_rec(a_acct, c1, 'https://x.invalid/4.pdf', cv1, m4, NULL);
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [NOT_FOUND]%',
    format('record accepted a message of another conversation (%s)', r));
  r := pg_temp.cd_rec(a_acct, c2, 'https://x.invalid/3.pdf', cv1, m3, NULL);
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [NOT_FOUND]%',
    format('record accepted a message of another contact''s chat (%s)', r));
  r := pg_temp.cd_rec(a_acct, cfar, 'https://x.invalid/3.pdf', cv1, m3, NULL);
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [NOT_FOUND]%',
    format('record accepted a contact of another account (%s)', r));
  r := pg_temp.cd_rec(a_acct, c1, '  ', cv1, m3, NULL);
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [INVALID]%',
    format('record accepted a blank media_url (%s)', r));
  r := pg_temp.cd_rec(a_acct, c1, 'https://x.invalid/3.pdf', cv1, m3, gm1);
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [INVALID]%',
    format('record accepted both a message and a group message (%s)', r));
  r := pg_temp.cd_rec(a_acct, c1, 'https://x.invalid/3.pdf', cv1, NULL, NULL);
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [INVALID]%',
    format('record accepted a chat document with no message id (%s)', r));
  r := pg_temp.cd_try(NULL, NULL, format(
    'SELECT public.customer_documents_record(%L, %L, ''email'', ''document'', ''https://x.invalid/3.pdf'', now(), %L, %L)',
    a_acct, c1, cv1, m3));
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [INVALID]%',
    format('record accepted an unknown source (%s)', r));
  n := n + 1; failed := failed || pg_temp.cd_ok(NOT EXISTS (SELECT 1 FROM customer_documents WHERE message_id IN (ma, m3)),
    'a refused record call wrote a row');

  SELECT id INTO d1 FROM customer_documents WHERE message_id = m1;
  SELECT id INTO d2 FROM customer_documents WHERE message_id = m2;
  SELECT id INTO d4 FROM customer_documents WHERE message_id = m4;
  SELECT id INTO d5 FROM customer_documents WHERE message_id = m5;
  SELECT id INTO dg FROM customer_documents WHERE group_message_id = gm1;
  docs := ARRAY[d1, d2, d4, d5, dg];
  folders := ARRAY[f1, f2];

  -- ---------- (c) claim ----------
  r := pg_temp.cd_try(NULL, NULL, 'SELECT count(*)::text FROM public.customer_documents_claim(0)');
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [INVALID]%', format('claim(0) was accepted (%s)', r));
  r := pg_temp.cd_try(NULL, NULL, 'SELECT count(*)::text FROM public.customer_documents_claim(51)');
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [INVALID]%', format('claim(51) was accepted (%s)', r));
  SELECT array_agg(c.id) INTO ids FROM customer_documents_claim(50) c
   WHERE c.id = ANY (docs) AND c.attempts = 1
     AND c.ref = CASE WHEN c.folder_id = f1 THEN ref1 ELSE ref2 END;
  n := n + 1; failed := failed || pg_temp.cd_ok(coalesce(cardinality(ids), 0) = 5,
    format('claim returned %s of the 5 pending rows with attempts 1 and their ref', coalesce(cardinality(ids), 0)));
  n := n + 1; failed := failed || pg_temp.cd_ok(
    (SELECT count(*) FROM customer_documents WHERE id = ANY (docs) AND attempts = 1 AND claimed_at = now()) = 5,
    'claim did not stamp claimed_at and bump attempts');
  SELECT count(*) INTO i FROM customer_documents_claim(50) c WHERE c.id = ANY (docs);
  n := n + 1; failed := failed || pg_temp.cd_ok(i = 0, format('a second claim returned %s just-claimed rows', i));

  -- ---------- (d) settle, existing ----------
  r := customer_documents_settle(d1, 'stored', sha_a, 100, '1.pdf');
  SELECT * INTO doc FROM customer_documents WHERE id = d1;
  n := n + 1; failed := failed || pg_temp.cd_ok(r = 'stored' AND doc.status = 'stored' AND doc.sha256 = sha_a
    AND doc.size_bytes = 100 AND doc.nas_name = '1.pdf' AND doc.stored_at = now() AND doc.claimed_at IS NULL,
    format('settle stored did not set the fields (%s)', r));
  n := n + 1; failed := failed || pg_temp.cd_ok(
    (SELECT nas_created_at FROM customer_doc_folders WHERE id = f1) = now(),
    'settle stored did not stamp the folder''s nas_created_at');
  n := n + 1; failed := failed || pg_temp.cd_ok(customer_documents_existing(f1, sha_a) = '1.pdf'
    AND customer_documents_existing(f1, sha_b) IS NULL AND customer_documents_existing(f2, sha_a) IS NULL,
    'existing() did not find the stored file by folder and sha only');
  r := pg_temp.cd_try(NULL, NULL, format('SELECT public.customer_documents_existing(%L, ''ABC'')', f1));
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [INVALID]%', format('existing() accepted a bad sha (%s)', r));

  r := customer_documents_settle(d2, 'duplicate', sha_a, 100);
  SELECT * INTO doc FROM customer_documents WHERE id = d2;
  n := n + 1; failed := failed || pg_temp.cd_ok(r = 'duplicate' AND doc.status = 'duplicate'
    AND doc.duplicate_of = d1 AND doc.nas_name = '1.pdf' AND doc.sha256 = sha_a AND doc.claimed_at IS NULL,
    format('settle duplicate did not link duplicate_of and copy nas_name (%s)', r));
  r := pg_temp.cd_try(NULL, NULL, format('SELECT public.customer_documents_settle(%L, ''duplicate'', %L, 5)', d4, sha_b));
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [NOT_FOUND]%',
    format('settle duplicate with no stored original was accepted (%s)', r));

  r := customer_documents_settle(dg, 'retry', p_error => 'boom');
  SELECT * INTO doc FROM customer_documents WHERE id = dg;
  n := n + 1; failed := failed || pg_temp.cd_ok(r = 'pending' AND doc.status = 'pending'
    AND doc.next_attempt_at = now() + interval '2 minutes' AND doc.claimed_at IS NULL AND doc.last_error = 'boom',
    format('settle retry did not move next_attempt_at forward and stay pending (%s, %s)', r, doc.next_attempt_at - now()));

  UPDATE customer_documents SET attempts = 10 WHERE id = d5;
  r := customer_documents_settle(d5, 'retry', p_error => 'still down');
  n := n + 1; failed := failed || pg_temp.cd_ok(r = 'failed'
    AND (SELECT status FROM customer_documents WHERE id = d5) = 'failed',
    format('a retry at attempts 10 did not fail the row (%s)', r));

  r := customer_documents_settle(d4, 'failed', p_error => repeat('e', 600));
  n := n + 1; failed := failed || pg_temp.cd_ok(r = 'failed'
    AND (SELECT status = 'failed' AND char_length(last_error) = 500 FROM customer_documents WHERE id = d4),
    format('settle failed did not fail the row with a 500-character error (%s)', r));

  r := pg_temp.cd_try(NULL, NULL, format('SELECT public.customer_documents_settle(%L, ''stored'', %L, 1, ''x'')', d1, sha_b));
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [STATE]%',
    format('settling a stored row was not refused STATE (%s)', r));
  r := pg_temp.cd_try(NULL, NULL, format('SELECT public.customer_documents_settle(%L, ''stored'', %L, 1, ''a/b'')', dg, sha_b));
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [INVALID]%',
    format('settle accepted nas_name a/b (%s)', r));
  r := pg_temp.cd_try(NULL, NULL, format('SELECT public.customer_documents_settle(%L, ''stored'', %L, 1, ''..'')', dg, sha_b));
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [INVALID]%',
    format('settle accepted nas_name .. (%s)', r));
  r := pg_temp.cd_try(NULL, NULL, format('SELECT public.customer_documents_settle(%L, ''stored'', %L, 1, ''a\b'')', dg, sha_b));
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [INVALID]%',
    format('settle accepted a nas_name with a backslash (%s)', r));
  r := pg_temp.cd_try(NULL, NULL, format('SELECT public.customer_documents_settle(%L, ''lost'')', dg));
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [INVALID]%',
    format('settle accepted an unknown outcome (%s)', r));
  r := pg_temp.cd_try(NULL, NULL, format('SELECT public.customer_documents_settle(%L, ''failed'')', gen_random_uuid()));
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [NOT_FOUND]%',
    format('settle of an unknown id was not NOT_FOUND (%s)', r));
  n := n + 1; failed := failed || pg_temp.cd_ok((SELECT status FROM customer_documents WHERE id = dg) = 'pending',
    'a refused settle changed the row');

  -- ---------- (e) privileges ----------
  n := n + 1; failed := failed || pg_temp.cd_ok(
    NOT has_function_privilege('anon', sig_rec, 'EXECUTE') AND NOT has_function_privilege('authenticated', sig_rec, 'EXECUTE')
    AND NOT has_function_privilege('anon', sig_clm, 'EXECUTE') AND NOT has_function_privilege('authenticated', sig_clm, 'EXECUTE')
    AND NOT has_function_privilege('anon', sig_ext, 'EXECUTE') AND NOT has_function_privilege('authenticated', sig_ext, 'EXECUTE')
    AND NOT has_function_privilege('anon', sig_stl, 'EXECUTE') AND NOT has_function_privilege('authenticated', sig_stl, 'EXECUTE'),
    'anon or authenticated may execute a worker function');
  n := n + 1; failed := failed || pg_temp.cd_ok(
    has_function_privilege('service_role', sig_rec, 'EXECUTE') AND has_function_privilege('service_role', sig_clm, 'EXECUTE')
    AND has_function_privilege('service_role', sig_ext, 'EXECUTE') AND has_function_privilege('service_role', sig_stl, 'EXECUTE'),
    'service_role may not execute a worker function');
  n := n + 1; failed := failed || pg_temp.cd_ok(
    has_function_privilege('authenticated', sig_rty, 'EXECUTE') AND NOT has_function_privilege('anon', sig_rty, 'EXECUTE'),
    'retry() is not executable by authenticated only');
  n := n + 1; failed := failed || pg_temp.cd_ok(
    NOT has_table_privilege('authenticated', 'public.customer_documents', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.customer_documents', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'public.customer_documents', 'DELETE')
    AND NOT has_table_privilege('authenticated', 'public.customer_doc_folders', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.customer_doc_folders', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'public.customer_doc_folders', 'DELETE')
    AND NOT has_table_privilege('anon', 'public.customer_documents', 'SELECT')
    AND has_table_privilege('authenticated', 'public.customer_documents', 'SELECT'),
    'authenticated may write a documents table, or anon may read one');
  r := pg_temp.cd_try('authenticated', u_owner, 'SELECT count(*)::text FROM public.customer_documents_claim(1)');
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR 42501%', format('an owner could call claim (%s)', r));
  r := pg_temp.cd_try('authenticated', u_owner, format(
    'WITH u AS (UPDATE public.customer_documents SET status = ''stored'' WHERE id = %L RETURNING 1) SELECT count(*)::text FROM u', dg));
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR 42501%', format('an owner could UPDATE a document (%s)', r));

  -- ---------- (f) RLS ----------
  r := pg_temp.cd_sees(u_other, 'customer_documents', docs) || '/' || pg_temp.cd_sees(u_other, 'customer_doc_folders', folders);
  n := n + 1; failed := failed || pg_temp.cd_ok(r = '0/0', format('an agent who cannot see the contacts sees documents/folders (%s)', r));
  r := pg_temp.cd_sees(u_agent, 'customer_documents', docs) || '/' || pg_temp.cd_sees(u_agent, 'customer_doc_folders', folders);
  n := n + 1; failed := failed || pg_temp.cd_ok(r = '3/1', format('the contact''s owner agent does not see exactly its 3 documents and 1 folder (%s)', r));
  r := pg_temp.cd_sees(u_admin, 'customer_documents', docs) || '/' || pg_temp.cd_sees(u_admin, 'customer_doc_folders', folders);
  n := n + 1; failed := failed || pg_temp.cd_ok(r = '5/2', format('an admin does not see every document and folder of the account (%s)', r));
  r := pg_temp.cd_sees(u_far, 'customer_documents', docs) || '/' || pg_temp.cd_sees(u_far, 'customer_doc_folders', folders);
  n := n + 1; failed := failed || pg_temp.cd_ok(r = '0/0', format('an admin of another account sees documents/folders (%s)', r));
  r := pg_temp.cd_sees(u_gone, 'customer_documents', docs);
  n := n + 1; failed := failed || pg_temp.cd_ok(r = '0', format('a deactivated admin sees documents (%s)', r));

  -- ---------- (g) retry() by a person ----------
  r := pg_temp.cd_try('authenticated', u_agent, format('SELECT public.customer_documents_retry(%L)', d5));
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [NOT_ALLOWED]%', format('an agent could retry (%s)', r));
  r := pg_temp.cd_try('authenticated', u_gone, format('SELECT public.customer_documents_retry(%L)', d5));
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [NOT_ALLOWED]%', format('a deactivated admin could retry (%s)', r));
  r := pg_temp.cd_try('authenticated', u_far, format('SELECT public.customer_documents_retry(%L)', d5));
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [NOT_FOUND]%', format('another account''s admin did not get NOT_FOUND (%s)', r));
  r := pg_temp.cd_try('authenticated', u_admin, format('SELECT public.customer_documents_retry(%L)', d1));
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR % [STATE]%', format('retry of a stored row was not refused STATE (%s)', r));
  r := pg_temp.cd_try('anon', NULL, format('SELECT public.customer_documents_retry(%L)', d5));
  n := n + 1; failed := failed || pg_temp.cd_ok(r LIKE 'ERROR 42501%', format('anon could call retry (%s)', r));
  n := n + 1; failed := failed || pg_temp.cd_ok((SELECT status FROM customer_documents WHERE id = d5) = 'failed',
    'a refused retry changed the row');
  r := pg_temp.cd_try('authenticated', u_admin, format('SELECT public.customer_documents_retry(%L)', d5));
  SELECT * INTO doc FROM customer_documents WHERE id = d5;
  n := n + 1; failed := failed || pg_temp.cd_ok(r = 'pending' AND doc.status = 'pending' AND doc.attempts = 0
    AND doc.next_attempt_at = now() AND doc.claimed_at IS NULL AND doc.last_error IS NULL,
    format('an admin''s retry did not put the failed row back to pending (%s)', r));

  -- ---------- (h) a deleted contact leaves its records, admin-only ----------
  DELETE FROM contacts WHERE id = c2;
  n := n + 1; failed := failed || pg_temp.cd_ok(
    (SELECT count(*) FROM customer_documents WHERE id IN (d4, d5) AND contact_id IS NULL
        AND conversation_id IS NULL AND message_id IS NULL) = 2
    AND (SELECT contact_id IS NULL FROM customer_doc_folders WHERE id = f2),
    'deleting a contact did not detach its documents and folder');
  r := pg_temp.cd_sees(u_admin, 'customer_documents', ARRAY[d4, d5]) || '/' || pg_temp.cd_sees(u_owner, 'customer_doc_folders', ARRAY[f2]);
  n := n + 1; failed := failed || pg_temp.cd_ok(r = '2/1', format('admins do not see a deleted contact''s records (%s)', r));

  RAISE EXCEPTION USING ERRCODE = 'ZT178', MESSAGE = 'verify-customer-documents rollback';
  EXCEPTION WHEN SQLSTATE 'ZT178' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'customer documents verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'customer documents verification passed (% checks)', n;
END
$verify$;
