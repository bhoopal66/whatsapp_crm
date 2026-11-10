-- Behavioural regression suite for migration 180: internal customer
-- documents (staff uploads and case builds in the private 'case-files'
-- bucket). The bucket; customer_documents_record_internal (folder reuse,
-- refusals, idempotency); the location CHECKs; the claim's storage pair;
-- who may execute.
--
-- ONE statement on purpose (`supabase db query --file`). Fixtures are
-- rolled back by a sentinel exception; results survive in variables.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000180001';
  u_agent  UUID := '00000000-0000-4000-8000-000000180002';
  u_view   UUID := '00000000-0000-4000-8000-000000180003'; -- viewer: not staff
  u_gone   UUID := '00000000-0000-4000-8000-000000180004'; -- deactivated agent
  u_far    UUID := '00000000-0000-4000-8000-000000180005'; -- owner of another account
  sig      TEXT := 'public.customer_documents_record_internal(uuid,uuid,text,text,text,text,timestamptz,text,text,uuid,uuid)';
  sig_fld  TEXT := 'public.customer_documents_folder(uuid,uuid)';
  a_acct   UUID;
  b_acct   UUID;
  wa       UUID;
  c1       UUID;
  c2       UUID;
  cv1      UUID;
  m1       UUID;
  g1       UUID;
  k1       UUID;
  f1       UUID;
  ref1     TEXT;
  d1       UUID;
  d2       UUID;
  r        TEXT;
  rr       RECORD;
  i        INT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ci_try(p_role text, p_uid uuid, p_sql text)
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
    CREATE FUNCTION pg_temp.ci_ok(p_ok boolean, p_msg text)
    RETURNS text[] LANGUAGE sql AS $body$
      SELECT CASE WHEN coalesce(p_ok, false) THEN '{}'::text[] ELSE ARRAY[p_msg] END
    $body$
  $fn$;
  -- A record_internal call as the current user: 'id ref' or the error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ci_rec(p_acct uuid, p_contact uuid, p_source text, p_kind text,
                                   p_bucket text, p_path text, p_case uuid, p_by uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.ci_try(NULL, NULL, format(
        'SELECT r.document_id || '' '' || r.ref FROM public.customer_documents_record_internal(%L, %L, %L, %L, %L, %L, now(), ''application/pdf'', ''f.pdf'', %L, %L) r',
        p_acct, p_contact, p_source, p_kind, p_bucket, p_path, p_case, p_by))
    $body$
  $fn$;
  -- A raw INSERT into customer_documents (as the superuser), for the CHECKs.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ci_raw(p_acct uuid, p_folder uuid, p_source text, p_url text,
                                   p_bucket text, p_path text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.ci_try(NULL, NULL, format(
        'WITH i AS (INSERT INTO public.customer_documents (account_id, folder_id, source, kind, media_url, storage_bucket, storage_path, received_at) VALUES (%L, %L, %L, ''document'', %L, %L, %L, now()) RETURNING 1) SELECT count(*)::text FROM i',
        p_acct, p_folder, p_source, p_url, p_bucket, p_path))
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'ci-owner@example.invalid'), (u_agent, 'ci-agent@example.invalid'),
    (u_view,  'ci-view@example.invalid'),  (u_gone,  'ci-gone@example.invalid'),
    (u_far,   'ci-far@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_far;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_gone);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_view;
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CI-180-A1', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500180001', 'CI one')
    RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500180002', 'CI two')
    RETURNING id INTO c2;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, c1) RETURNING id INTO cv1;
  INSERT INTO messages (conversation_id, sender_type, content_type, media_url)
    VALUES (cv1, 'customer', 'document', 'https://x.invalid/1.pdf') RETURNING id INTO m1;
  g1 := (SELECT x.group_id FROM sg_open(a_acct, 'CI-180-1', c1, wa, 'case files', NULL,
    jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
  k1 := (SELECT x.case_id FROM case_open(g1, 'ADCB', 'ADCB Bank', 'Loan', 1000, NULL) x);
  IF g1 IS NULL OR k1 IS NULL OR (SELECT contact_id FROM cases WHERE id = k1) IS DISTINCT FROM c1 THEN
    RAISE EXCEPTION 'fixture: sg_open / case_open did not give a case of c1';
  END IF;

  -- ---------- (a) the bucket ----------
  SELECT count(*) INTO i FROM storage.buckets
   WHERE id = 'case-files' AND public = false AND file_size_limit = 104857600
     AND allowed_mime_types @> ARRAY['application/pdf', 'image/jpeg', 'image/png']
     AND cardinality(allowed_mime_types) = 3;
  n := n + 1; failed := failed || pg_temp.ci_ok(i = 1,
    'bucket: case-files is missing, public, or has the wrong size limit or types');

  -- ---------- (b) recording ----------
  -- c1's folder exists already (a customer document), so a staff upload reuses it.
  ref1 := customer_documents_record(a_acct, c1, 'chat', 'document', 'https://x.invalid/1.pdf', now(), cv1, m1);
  SELECT id INTO f1 FROM customer_doc_folders WHERE contact_id = c1;
  SELECT * INTO rr FROM customer_documents_record_internal(a_acct, c1, 'staff_upload', 'image',
    'case-files', 'account-x/case-1/a.png', now(), 'image/png', 'a.png', k1, u_agent);
  d1 := rr.document_id;
  n := n + 1; failed := failed || pg_temp.ci_ok(rr.ref = ref1
    AND (SELECT folder_id = f1 AND source = 'staff_upload' AND media_url IS NULL AND case_id = k1
                AND uploaded_by = u_agent AND conversation_id IS NULL AND status = 'pending'
           FROM customer_documents WHERE id = d1),
    format('a staff upload did not land in the contact''s existing folder (%s vs %s)', rr.ref, ref1));
  SELECT * INTO rr FROM customer_documents_record_internal(a_acct, c2, 'staff_upload', 'document',
    'case-files', 'account-x/contact-2/b.pdf', now(), p_uploaded_by => u_owner);
  n := n + 1; failed := failed || pg_temp.ci_ok(rr.ref ~ '^TC-[0-9]{6,}$' AND rr.ref <> ref1
    AND (SELECT ref FROM customer_doc_folders WHERE contact_id = c2) = rr.ref,
    format('a staff upload for a contact with no folder did not create one (%s)', rr.ref));
  SELECT * INTO rr FROM customer_documents_record_internal(a_acct, c1, 'case_build', 'document',
    'case-files', 'account-x/case-1/case-file.pdf', now(), 'application/pdf', 'Case file.pdf', k1);
  d2 := rr.document_id;
  n := n + 1; failed := failed || pg_temp.ci_ok(rr.ref = ref1
    AND (SELECT source = 'case_build' AND uploaded_by IS NULL FROM customer_documents WHERE id = d2),
    format('a case build did not land in the case customer''s folder (%s)', rr.ref));

  -- Idempotent on the Storage object.
  r := pg_temp.ci_rec(a_acct, c1, 'staff_upload', 'image', 'case-files', 'account-x/case-1/a.png', k1, u_agent);
  n := n + 1; failed := failed || pg_temp.ci_ok(r = d1 || ' ' || ref1
    AND (SELECT count(*) FROM customer_documents WHERE storage_path = 'account-x/case-1/a.png') = 1,
    format('recording the same storage path twice did not keep one row (%s)', r));

  -- Refusals.
  r := pg_temp.ci_rec(a_acct, c2, 'case_build', 'document', 'case-files', 'r/1.pdf', k1, NULL);
  n := n + 1; failed := failed || pg_temp.ci_ok(r LIKE 'ERROR % [NOT_FOUND]%',
    format('a case build for a case of another contact was accepted (%s)', r));
  r := pg_temp.ci_rec(a_acct, c1, 'staff_upload', 'document', 'case-files', 'r/2.pdf', NULL, u_view);
  n := n + 1; failed := failed || pg_temp.ci_ok(r LIKE 'ERROR % [NOT_FOUND]%',
    format('a viewer was accepted as uploader (%s)', r));
  r := pg_temp.ci_rec(a_acct, c1, 'staff_upload', 'document', 'case-files', 'r/3.pdf', NULL, u_gone);
  n := n + 1; failed := failed || pg_temp.ci_ok(r LIKE 'ERROR % [NOT_FOUND]%',
    format('a deactivated agent was accepted as uploader (%s)', r));
  r := pg_temp.ci_rec(a_acct, c1, 'staff_upload', 'document', 'case-files', 'r/4.pdf', NULL, u_far);
  n := n + 1; failed := failed || pg_temp.ci_ok(r LIKE 'ERROR % [NOT_FOUND]%',
    format('another account''s owner was accepted as uploader (%s)', r));
  r := pg_temp.ci_rec(a_acct, c1, 'staff_upload', 'document', 'case-files', 'r/5.pdf', NULL, NULL);
  n := n + 1; failed := failed || pg_temp.ci_ok(r LIKE 'ERROR % [INVALID]%',
    format('a staff upload with no uploader was accepted (%s)', r));
  r := pg_temp.ci_rec(a_acct, c1, 'case_build', 'document', 'case-files', 'r/6.pdf', NULL, NULL);
  n := n + 1; failed := failed || pg_temp.ci_ok(r LIKE 'ERROR % [INVALID]%',
    format('a case build with no case was accepted (%s)', r));
  r := pg_temp.ci_rec(a_acct, c1, 'case_build', 'document', 'case-files', 'r/7.pdf', k1, u_agent);
  n := n + 1; failed := failed || pg_temp.ci_ok(r LIKE 'ERROR % [INVALID]%',
    format('a case build with an uploader was accepted (%s)', r));
  r := pg_temp.ci_rec(a_acct, c1, 'case_build', 'image', 'case-files', 'r/8.pdf', k1, NULL);
  n := n + 1; failed := failed || pg_temp.ci_ok(r LIKE 'ERROR % [INVALID]%',
    format('a case build of kind image was accepted (%s)', r));
  r := pg_temp.ci_rec(a_acct, c1, 'chat', 'document', 'case-files', 'r/9.pdf', NULL, u_agent);
  n := n + 1; failed := failed || pg_temp.ci_ok(r LIKE 'ERROR % [INVALID]%',
    format('record_internal accepted a customer source (%s)', r));
  r := pg_temp.ci_rec(a_acct, c1, 'staff_upload', 'document', 'chat-files', 'r/10.pdf', NULL, u_agent);
  n := n + 1; failed := failed || pg_temp.ci_ok(r LIKE 'ERROR % [INVALID]%',
    format('record_internal accepted another bucket (%s)', r));
  r := pg_temp.ci_rec(a_acct, c1, 'staff_upload', 'document', 'case-files', 'a/../b.pdf', NULL, u_agent)
    || ' | ' || pg_temp.ci_rec(a_acct, c1, 'staff_upload', 'document', 'case-files', '/a.pdf', NULL, u_agent)
    || ' | ' || pg_temp.ci_rec(a_acct, c1, 'staff_upload', 'document', 'case-files', ' ', NULL, u_agent);
  n := n + 1; failed := failed || pg_temp.ci_ok(r LIKE 'ERROR % [INVALID]% | ERROR % [INVALID]% | ERROR % [INVALID]%',
    format('record_internal accepted a climbing, absolute or blank path (%s)', r));
  r := pg_temp.ci_rec(b_acct, c1, 'staff_upload', 'document', 'case-files', 'r/11.pdf', NULL, u_far);
  n := n + 1; failed := failed || pg_temp.ci_ok(r LIKE 'ERROR % [NOT_FOUND]%',
    format('record_internal accepted a contact of another account (%s)', r));
  n := n + 1; failed := failed || pg_temp.ci_ok(
    NOT EXISTS (SELECT 1 FROM customer_documents WHERE storage_path LIKE 'r/%' OR storage_path LIKE '%..%'),
    'a refused record_internal call wrote a row');

  -- ---------- (c) the CHECKs ----------
  r := pg_temp.ci_raw(a_acct, f1, 'chat', NULL, NULL, NULL);
  n := n + 1; failed := failed || pg_temp.ci_ok(r LIKE 'ERROR 23514%',
    format('a customer-source row with no media_url was accepted (%s)', r));
  r := pg_temp.ci_raw(a_acct, f1, 'chat', 'https://x.invalid/z.pdf', 'case-files', 'k/z.pdf');
  n := n + 1; failed := failed || pg_temp.ci_ok(r LIKE 'ERROR 23514%customer_documents_one_location%',
    format('exactly one location: a row with a media_url and a storage pair was accepted (%s)', r));
  r := pg_temp.ci_raw(a_acct, f1, 'staff_upload', NULL, 'case-files', NULL);
  n := n + 1; failed := failed || pg_temp.ci_ok(r LIKE 'ERROR 23514%customer_documents_one_location%',
    format('exactly one location: a row with a bucket and no path was accepted (%s)', r));
  r := pg_temp.ci_raw(a_acct, f1, 'staff_upload', 'https://x.invalid/z.pdf', NULL, NULL);
  n := n + 1; failed := failed || pg_temp.ci_ok(r LIKE 'ERROR 23514%customer_documents_source_location%',
    format('a new-source row with a media_url was accepted (%s)', r));
  r := pg_temp.ci_raw(a_acct, f1, 'case_build', NULL, 'case-files', 'k/../z.pdf');
  n := n + 1; failed := failed || pg_temp.ci_ok(r LIKE 'ERROR 23514%customer_documents_storage_path_check%',
    format('a new-source row with a .. path was accepted (%s)', r));
  r := pg_temp.ci_raw(a_acct, f1, 'case_build', NULL, 'chat-files', 'k/z.pdf');
  n := n + 1; failed := failed || pg_temp.ci_ok(r LIKE 'ERROR 23514%customer_documents_storage_bucket_check%',
    format('a new-source row in another bucket was accepted (%s)', r));
  r := pg_temp.ci_try(NULL, NULL, format(
    'WITH i AS (INSERT INTO public.customer_documents (account_id, folder_id, source, kind, storage_bucket, storage_path, conversation_id, received_at) VALUES (%L, %L, ''staff_upload'', ''document'', ''case-files'', ''k/c.pdf'', %L, now()) RETURNING 1) SELECT count(*)::text FROM i',
    a_acct, f1, cv1));
  n := n + 1; failed := failed || pg_temp.ci_ok(r LIKE 'ERROR 23514%customer_documents_source_ids%',
    format('a new-source row with a conversation was accepted (%s)', r));

  -- ---------- (d) the claim returns the storage pair ----------
  SELECT count(*) INTO i FROM customer_documents_claim(50) c
   WHERE (c.id = d1 AND c.storage_bucket = 'case-files' AND c.storage_path = 'account-x/case-1/a.png'
          AND c.media_url IS NULL AND c.ref = ref1 AND c.claimed_at IS NOT NULL)
      OR (c.id = d2 AND c.storage_path = 'account-x/case-1/case-file.pdf')
      OR (c.media_url = 'https://x.invalid/1.pdf' AND c.storage_bucket IS NULL AND c.storage_path IS NULL);
  n := n + 1; failed := failed || pg_temp.ci_ok(i = 3,
    format('claim did not return the storage pair (and NULLs for a customer row): %s of 3', i));

  -- ---------- (e) privileges ----------
  n := n + 1; failed := failed || pg_temp.ci_ok(
    NOT has_function_privilege('anon', sig, 'EXECUTE') AND NOT has_function_privilege('authenticated', sig, 'EXECUTE')
    AND has_function_privilege('service_role', sig, 'EXECUTE')
    AND NOT has_function_privilege('anon', sig_fld, 'EXECUTE') AND NOT has_function_privilege('authenticated', sig_fld, 'EXECUTE')
    AND NOT has_function_privilege('service_role', sig_fld, 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.customer_documents_claim(integer)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.customer_documents_claim(integer)', 'EXECUTE'),
    'privileges: record_internal / folder helper / claim are executable by the wrong roles');
  r := pg_temp.ci_try('authenticated', u_owner, format(
    'SELECT r.ref FROM public.customer_documents_record_internal(%L, %L, ''staff_upload'', ''document'', ''case-files'', ''p/1.pdf'', now(), p_uploaded_by => %L) r',
    a_acct, c1, u_owner));
  n := n + 1; failed := failed || pg_temp.ci_ok(r LIKE 'ERROR 42501%', format('an owner could call record_internal (%s)', r));
  n := n + 1; failed := failed || pg_temp.ci_ok(
    NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                 AND (qual LIKE '%case-files%' OR with_check LIKE '%case-files%')),
    'a storage.objects policy mentions case-files');

  RAISE EXCEPTION USING ERRCODE = 'ZT180', MESSAGE = 'verify-customer-documents-internal rollback';
  EXCEPTION WHEN SQLSTATE 'ZT180' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'customer documents internal verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'customer documents internal verification passed (% checks)', n;
END
$verify$;
