-- 316: the rest of the case desk and case file findings.
--
--  1. desk_doc_tasks_due (263): the assignee fell back to the case's agent
--     without asking whether they still work here; tasks_guard refuses that
--     person and the row failed every hour. Now a live coordinator, else a
--     live agent, else desk_lead_for.
--  2. desk_settings_set / desk_digest_settings_set with p_expected, the
--     updated_at the settings card was shown (NULL = nothing stored yet):
--     SETTINGS_CHANGED when the row is newer, so a card opened before a
--     colleague switched reminders or routing off cannot switch them on
--     again. Both overloads have no default, so a call with 230's / 234's
--     arguments still finds only the old function and the old build keeps
--     working. desk_digest_settings_read is 234's reader plus updated_at
--     (a new name: CREATE OR REPLACE cannot add a column, and 234 must stay
--     re-runnable).
--  3. desk_case_doc_cell (233): a passed file with a newer failed version
--     read as passed on the checklist and in the digest, while
--     case_file_ready said the case is not ready.
--  4. case_file_build_record (182) ordered doc_key by the database
--     collation, the builder by code point: two documents on one position
--     (partner_passport, partner2_passport) were BUILD_INVALID every time.
--     COLLATE "C" there, in case_file_spec_rows and in case_file_status_api.
--  5. desk_digest_enqueue: a digest that failed on a read of ours
--     ('read_failed') does not use up gap_days, as number_daily_limit.
--  6. desk_customer_contact_remove asks memory_can_read, as _set does.
--  7. customer_documents_claim fails a copy claimed 10 times;
--     customer_documents_stats() is read by /api/metrics.
--
-- Restates functions of 178, 181, 182, 184, 229, 233, 234 and 263: apply in
-- order. Safe to run twice; refuses nothing on existing data. Apply before
-- the build that calls the new functions.
-- supabase/ci/verify-desk-rest.sql asserts it.

SET lock_timeout = '5s';

-- 1. ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.desk_doc_tasks_due(p_now timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 500)
 RETURNS TABLE(account_id uuid, case_id uuid, case_number text, file_id uuid, doc_key text, kind text, expires_on date, assignee uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH open_cases AS (
    SELECT k.* FROM public.cases k
     WHERE k.desk_customer_id IS NOT NULL AND k.closed_at IS NULL AND k.group_id IS NULL
  ), passed AS (
    SELECT f.*, k.case_number AS cnum, k.desk_customer_id AS company,
           coalesce(CASE WHEN public.case_account_role(k.account_id, k.coordinator_id) IS NOT NULL
                         THEN k.coordinator_id END,
                    -- 316: a live agent, else the duty owner or the owner.
                    CASE WHEN public.case_account_role(k.account_id, k.agent_id) IS NOT NULL
                         THEN k.agent_id END,
                    public.desk_lead_for(k.account_id)) AS who
      FROM public.case_document_files f
      JOIN open_cases k ON k.id = f.case_id
     WHERE f.status = 'passed'
  ), hits AS (
    SELECT p.account_id, p.case_id, p.cnum, p.id, p.doc_key,
           CASE WHEN p.expires_on < public.desk_today(p_now) THEN 'expired' ELSE 'expiring' END AS kind,
           p.expires_on, p.who
      FROM passed p
     WHERE p.expires_on IS NOT NULL AND p.expires_on <= public.desk_today(p_now) + 14
    UNION ALL
    SELECT p.account_id, p.case_id, p.cnum, p.id, p.doc_key, 'replaced', p.expires_on, p.who
      FROM passed p
     WHERE EXISTS (SELECT 1 FROM public.case_document_files g
                     JOIN public.cases o ON o.id = g.case_id
                    WHERE g.customer_document_id = p.customer_document_id
                      AND o.desk_customer_id = p.company AND o.id <> p.case_id
                      AND g.status = 'superseded')
  )
  SELECT h.account_id, h.case_id, h.cnum, h.id, h.doc_key, h.kind, h.expires_on, h.who
    FROM hits h
   -- 263: a file already tasked (src/lib/desk/escalate.ts runDeskDocTasks;
   -- UNIQUE (account_id, source, source_ref)) must not hold a place.
   WHERE NOT EXISTS (SELECT 1 FROM public.tasks t
                      WHERE t.account_id = h.account_id AND t.source = 'automation'
                        AND t.source_ref = 'desk_doc:' || h.id::text || ':' || h.kind)
   ORDER BY h.account_id, h.case_id, h.id
   LIMIT least(greatest(coalesce(p_limit, 500), 1), 2000)
$function$;

-- 2. ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.desk_settings_set(
  p_actor uuid, p_account uuid, p_routing_enabled boolean, p_desk_channel_ids uuid[],
  p_escalate_minutes integer, p_expected timestamptz, p_now timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor) IN ('admin', 'super_admin'), false) IS NOT TRUE THEN
    PERFORM public.desk_refuse('desk_settings_set', 'NOT_ALLOWED', 'owners and admins only');
  END IF;
  -- Two first saves have no row to lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('desk_settings:' || p_account::text, 0));
  PERFORM 1 FROM public.desk_settings s WHERE s.account_id = p_account FOR UPDATE;
  IF (SELECT s.updated_at FROM public.desk_settings s WHERE s.account_id = p_account)
     IS DISTINCT FROM p_expected THEN
    PERFORM public.desk_refuse('desk_settings_set', 'SETTINGS_CHANGED', 'the settings were changed meanwhile');
  END IF;
  PERFORM public.desk_settings_set(p_actor, p_account, p_routing_enabled, p_desk_channel_ids,
                                   p_escalate_minutes, p_now);
END;
$$;
REVOKE ALL ON FUNCTION public.desk_settings_set(uuid, uuid, boolean, uuid[], integer, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.desk_settings_set(uuid, uuid, boolean, uuid[], integer, timestamptz, timestamptz)
  TO service_role;

CREATE OR REPLACE FUNCTION public.desk_digest_settings_set(
  p_actor uuid, p_account uuid, p_enabled boolean, p_template_name text, p_language text,
  p_send_hour integer, p_gap_days integer, p_expected timestamptz, p_now timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor) IN ('admin', 'super_admin'), false) IS NOT TRUE THEN
    PERFORM public.desk_refuse('desk_digest_settings_set', 'NOT_ALLOWED', 'owners and admins only');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('desk_digest_settings:' || p_account::text, 0));
  PERFORM 1 FROM public.desk_digest_settings s WHERE s.account_id = p_account FOR UPDATE;
  IF (SELECT s.updated_at FROM public.desk_digest_settings s WHERE s.account_id = p_account)
     IS DISTINCT FROM p_expected THEN
    PERFORM public.desk_refuse('desk_digest_settings_set', 'SETTINGS_CHANGED', 'the settings were changed meanwhile');
  END IF;
  PERFORM public.desk_digest_settings_set(p_actor, p_account, p_enabled, p_template_name, p_language,
                                          p_send_hour, p_gap_days, p_now);
END;
$$;
REVOKE ALL ON FUNCTION public.desk_digest_settings_set(uuid, uuid, boolean, text, text, integer, integer, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.desk_digest_settings_set(uuid, uuid, boolean, text, text, integer, integer, timestamptz, timestamptz)
  TO service_role;

CREATE OR REPLACE FUNCTION public.desk_digest_settings_read(p_actor uuid, p_account uuid)
RETURNS TABLE (enabled boolean, template_name text, language text, send_hour integer, gap_days integer,
               updated_at timestamptz)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF public.case_account_role(p_account, p_actor) IS NULL THEN
    PERFORM public.desk_refuse('desk_digest_settings_read', 'NOT_ALLOWED', 'staff only');
  END IF;
  RETURN QUERY
  SELECT coalesce(s.enabled, false), s.template_name, coalesce(s.language, 'en'),
         coalesce(s.send_hour, 10), coalesce(s.gap_days, 2), s.updated_at
    FROM (SELECT 1) one LEFT JOIN public.desk_digest_settings s ON s.account_id = p_account;
END;
$$;
REVOKE ALL ON FUNCTION public.desk_digest_settings_read(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.desk_digest_settings_read(uuid, uuid) TO service_role;

-- 3. ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.desk_case_doc_cell(p_case uuid, p_doc_key text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT coalesce(
    (SELECT jsonb_build_object('status', f.status, 'file_id', f.id, 'expires_on', f.expires_on)
       FROM public.case_document_files f
      WHERE f.case_id = p_case AND f.doc_key = p_doc_key
      -- 316: as case_file_ready: a passed file counts unless a newer one failed.
      ORDER BY (f.status = 'passed'
                AND NOT EXISTS (SELECT 1 FROM public.case_document_files g
                                 WHERE g.case_id = f.case_id AND g.doc_key = f.doc_key
                                   AND g.status = 'failed' AND g.version > f.version)) DESC,
               f.version DESC NULLS LAST, f.classified_at DESC NULLS LAST
      LIMIT 1),
    jsonb_build_object('status', 'missing'))
$function$;

-- 4. ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.case_file_spec_rows(p_case uuid)
 RETURNS TABLE(doc_key text, "position" integer, name_pattern text, required boolean, max_mb integer, allowed_mime text[], min_valid_days integer, merged boolean, from_spec boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  c public.cases%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  IF EXISTS (SELECT 1 FROM public.case_file_specs s
              WHERE s.account_id = c.account_id AND s.bank_code = c.bank_code
                AND lower(btrim(s.product)) = lower(btrim(c.product))) THEN
    RETURN QUERY
      SELECT s.doc_key, s.position, s.name_pattern, s.required, s.max_mb, s.allowed_mime, s.min_valid_days,
             s.merged, true
        FROM public.case_file_specs s
       WHERE s.account_id = c.account_id AND s.bank_code = c.bank_code
         AND lower(btrim(s.product)) = lower(btrim(c.product))
       ORDER BY s.position, s.doc_key COLLATE "C";
  ELSE
    RETURN QUERY
      SELECT r.doc_key, r.position, '{{case}}_{{doc}}_{{yyyymmdd}}'::text, true, 10,
             ARRAY['application/pdf', 'image/jpeg', 'image/png']::text[], NULL::integer, true, false
        FROM public.case_doc_requirements r
       WHERE r.account_id = c.account_id AND r.bank_code = c.bank_code
         AND lower(btrim(r.product)) = lower(btrim(c.product))
       ORDER BY r.position, r.doc_key COLLATE "C";
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.case_file_build_record(p_actor uuid, p_case uuid, p_reservation uuid, p_manifest jsonb, p_merged boolean, p_object_path text, p_sha256 text, p_now timestamp with time zone)
 RETURNS TABLE(build_id uuid, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_now timestamptz := coalesce(p_now, now());
  v_account uuid;
  v_spec_merged boolean;
  v_expected jsonb;
  v_given jsonb;
  v_shape_ok boolean;
  v_path text;
  v_id uuid;
  rs public.case_file_build_reservations%ROWTYPE;
BEGIN
  SELECT x.account_id INTO v_account FROM public.cases x WHERE x.id = p_case FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  PERFORM public.case_file_build_gate(p_actor, p_case);

  SELECT * INTO rs FROM public.case_file_build_reservations r WHERE r.reservation_id = p_reservation FOR UPDATE;
  IF NOT FOUND OR rs.case_id IS DISTINCT FROM p_case OR rs.actor IS DISTINCT FROM p_actor
     OR rs.used_at IS NOT NULL OR rs.expires_at <= v_now
     OR EXISTS (SELECT 1 FROM public.case_file_builds b WHERE b.case_id = p_case AND b.version >= rs.version) THEN
    RAISE EXCEPTION 'build reservation % is not a live reservation of case % for this actor', p_reservation, p_case
      USING ERRCODE = 'check_violation', HINT = 'BUILD_INVALID';
  END IF;

  SELECT coalesce(bool_or(r.merged), false) INTO v_spec_merged FROM public.case_file_spec_rows(p_case) r;
  -- The manifest the current passed files give, without the builder's sha256.
  SELECT coalesce(jsonb_agg(jsonb_build_object('position', r.position, 'doc_key', r.doc_key,
                                               'file_id', f.id::text, 'renamed_name', f.renamed_name,
                                               'pages', f.pages)
                            ORDER BY r.position, r.doc_key COLLATE "C"), '[]'::jsonb)
    INTO v_expected
    FROM public.case_file_spec_rows(p_case) r
    JOIN public.case_document_files f ON f.case_id = p_case AND f.doc_key = r.doc_key AND f.status = 'passed'
   WHERE r.required;
  IF jsonb_typeof(p_manifest) = 'array' THEN
    SELECT coalesce(bool_and(jsonb_typeof(t.e) = 'object'
                             AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(t.e) k)
                                 = ARRAY['doc_key', 'file_id', 'pages', 'position', 'renamed_name', 'sha256']
                             AND jsonb_typeof(t.e -> 'sha256') = 'string'
                             AND (t.e ->> 'sha256') ~ '^[0-9a-f]{64}$'), false),
           coalesce(jsonb_agg(t.e - 'sha256' ORDER BY t.ord), '[]'::jsonb)
      INTO v_shape_ok, v_given
      FROM jsonb_array_elements(p_manifest) WITH ORDINALITY AS t(e, ord);
  ELSE
    v_shape_ok := false;
  END IF;

  -- (Computed apart: a CASE ... THEN inside an IF condition ends the condition.)
  v_path := 'cases/' || p_case::text || (CASE WHEN p_merged THEN '/bundle-' ELSE '/index-' END) || p_sha256 || '.pdf';
  IF NOT v_shape_ok OR v_given IS DISTINCT FROM v_expected
     OR p_merged IS NULL OR p_merged IS DISTINCT FROM v_spec_merged
     OR p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$'
     OR p_object_path IS DISTINCT FROM v_path THEN
    RAISE EXCEPTION 'build of case % does not match its current passed files, spec or content-addressed path', p_case
      USING ERRCODE = 'check_violation', HINT = 'BUILD_INVALID';
  END IF;

  UPDATE public.case_file_build_reservations r SET used_at = v_now WHERE r.reservation_id = rs.reservation_id;
  UPDATE public.case_file_builds b SET status = 'superseded' WHERE b.case_id = p_case AND b.status = 'ready';
  INSERT INTO public.case_file_builds (account_id, case_id, version, built_at, built_by, built_system, merged,
                                       manifest, object_path, sha256)
  VALUES (v_account, p_case, rs.version, v_now, p_actor,
          CASE WHEN p_actor IS NULL THEN 'system:files' END,
          p_merged, p_manifest, p_object_path, p_sha256)
  RETURNING case_file_builds.build_id INTO v_id;
  RETURN QUERY SELECT v_id, rs.version;
END;
$function$;

CREATE OR REPLACE FUNCTION public.case_file_status_api(p_account uuid, p_submission_ref text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_case  uuid;
  v_docs  jsonb;
  v_build jsonb;
BEGIN
  v_case := public.case_by_submission_ref(p_account, p_submission_ref);
  IF v_case IS NULL THEN
    RAISE EXCEPTION 'case file % not found', p_submission_ref USING ERRCODE = 'no_data_found', HINT = 'FILE_NOT_FOUND';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'doc_key', r.doc_key,
           'required', r.required,
           'status', CASE
             WHEN EXISTS (SELECT 1 FROM public.case_document_files f
                           WHERE f.case_id = v_case AND f.doc_key = r.doc_key AND f.status = 'passed'
                             AND NOT EXISTS (SELECT 1 FROM public.case_document_files g
                                              WHERE g.case_id = f.case_id AND g.doc_key = f.doc_key
                                                AND g.status = 'failed' AND g.version > f.version))
               THEN 'passed'
             WHEN EXISTS (SELECT 1 FROM public.case_document_files f
                           WHERE f.case_id = v_case AND f.doc_key = r.doc_key AND f.status = 'pending_checks')
               THEN 'checking'
             WHEN EXISTS (SELECT 1 FROM public.case_document_files f
                           WHERE f.case_id = v_case AND f.doc_key = r.doc_key AND f.status = 'failed')
               THEN 'failed'
             ELSE 'missing' END)
         ORDER BY r.position, r.doc_key COLLATE "C"), '[]'::jsonb)
    INTO v_docs
    FROM public.case_file_spec_rows(v_case) r;

  SELECT jsonb_build_object(
           'version', b.version,
           'merged', b.merged,
           'sha256', b.sha256,
           'built_at', b.built_at,
           'manifest', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                                 'doc_key', e ->> 'doc_key',
                                 'renamed_name', e ->> 'renamed_name',
                                 'pages', e -> 'pages',
                                 'sha256', e ->> 'sha256')
                               ORDER BY (e ->> 'position')::int, t.ord), '[]'::jsonb)
                          FROM jsonb_array_elements(b.manifest) WITH ORDINALITY AS t(e, ord)))
    INTO v_build
    FROM public.case_file_builds b
   WHERE b.case_id = v_case AND b.status = 'ready';

  RETURN jsonb_build_object('ready', public.case_file_ready(v_case), 'documents', v_docs,
                            'build', coalesce(v_build, 'null'::jsonb));
END;
$function$;

-- 5. ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.desk_digest_enqueue(p_now timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_now   timestamptz := coalesce(p_now, now());
  v_today date := public.desk_today(p_now);
  v_hour  integer := extract(hour FROM v_now AT TIME ZONE 'Asia/Dubai')::integer;
  s       public.desk_digest_settings%ROWTYPE;
  r       record;
  v_sum   record;
  v_to    record;
  v_n     integer := 0;
  v_id    uuid;
BEGIN
  FOR s IN SELECT * FROM public.desk_digest_settings x WHERE x.enabled AND x.template_name IS NOT NULL LOOP
    CONTINUE WHEN v_hour < s.send_hour OR v_hour >= 21;
    CONTINUE WHEN NOT public.desk_digest_template_ok(s.account_id, s.template_name, s.language);
    FOR r IN
      SELECT d.id AS customer_id, a.app_number
        FROM public.desk_customers d
        JOIN public.desk_applications a ON a.customer_id = d.id AND a.status = 'open'
       WHERE d.account_id = s.account_id AND d.merged_into IS NULL
         AND EXISTS (SELECT 1 FROM public.cases k WHERE k.desk_customer_id = d.id
                       AND k.closed_at IS NULL AND k.group_id IS NULL)
         -- Not again within gap_days of the last digest ...
         AND NOT EXISTS (SELECT 1 FROM public.desk_digest_outbox o
                          WHERE o.customer_id = d.id AND o.status <> 'cancelled'
                            -- Held back by the number's own limit, or (316) a
                            -- read of ours failed before the gateway: nothing
                            -- reached the customer, so the next day may ask.
                            AND NOT (o.status = 'failed'
                                     AND o.status_reason IN ('number_daily_limit', 'read_failed'))
                            AND o.local_day > v_today - s.gap_days)
         -- ... nor of the last document any of its people sent.
         AND NOT EXISTS (SELECT 1 FROM public.customer_documents cd
                          WHERE cd.account_id = s.account_id
                            AND cd.received_at > v_now - make_interval(days => s.gap_days)
                            AND cd.contact_id IN (SELECT l.contact_id FROM public.desk_customer_contacts l
                                                   WHERE l.customer_id = d.id
                                                  UNION
                                                  SELECT k.contact_id FROM public.cases k
                                                   WHERE k.desk_customer_id = d.id))
    LOOP
      SELECT * INTO v_sum FROM public.desk_digest_summary(s.account_id, r.customer_id);
      CONTINUE WHEN coalesce(v_sum.pending, 0) = 0 OR v_sum.summary IS NULL;
      SELECT * INTO v_to FROM public.desk_digest_recipient(s.account_id, r.customer_id);
      CONTINUE WHEN v_to.contact_id IS NULL;
      v_id := NULL;
      INSERT INTO public.desk_digest_outbox AS o (account_id, customer_id, contact_id, conversation_id, local_day,
                                                  app_number, summary, pending, created_at)
      VALUES (s.account_id, r.customer_id, v_to.contact_id, v_to.conversation_id, v_today, r.app_number,
              v_sum.summary, v_sum.pending, v_now)
      ON CONFLICT (customer_id, local_day) DO NOTHING
      RETURNING o.id INTO v_id;
      IF v_id IS NOT NULL THEN
        v_n := v_n + 1;
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_n;
END;
$function$;

-- 6. ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.desk_customer_contact_remove(p_actor uuid, p_account uuid, p_customer uuid, p_contact uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_n integer;
BEGIN
  IF NOT public.desk_customer_can_read(p_actor, p_account, p_customer) THEN
    PERFORM public.desk_refuse('desk_customer_contact_remove', 'CUSTOMER_NOT_FOUND', 'company not found');
  END IF;
  IF NOT public.desk_customer_can_manage(p_actor, p_account, p_customer) THEN
    PERFORM public.desk_refuse('desk_customer_contact_remove', 'NOT_ALLOWED', 'you cannot change this company');
  END IF;
  -- 316: as desk_customer_contact_set.
  IF p_contact IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = p_contact AND c.account_id = p_account)
     OR NOT public.memory_can_read(p_actor, p_account, 'contact', p_contact) THEN
    PERFORM public.desk_refuse('desk_customer_contact_remove', 'CONTACT_INVALID', 'not a contact you can see');
  END IF;
  DELETE FROM public.desk_customer_contacts l
   WHERE l.customer_id = p_customer AND l.contact_id = p_contact AND l.account_id = p_account;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$function$;

-- 7. ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.customer_documents_claim(p_limit integer DEFAULT 10)
 RETURNS TABLE(id uuid, folder_id uuid, ref text, kind text, mime text, original_name text, caption text, media_url text, received_at timestamp with time zone, attempts integer, claimed_at timestamp with time zone, storage_bucket text, storage_path text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_at timestamptz := clock_timestamp();
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'customer_documents_claim: limit % is outside 1..50', p_limit
      USING ERRCODE = 'invalid_parameter_value', HINT = 'INVALID';
  END IF;
  -- 316: settle fails a copy whose tries are spent, but a file that kills
  -- the worker never reaches settle and was claimed again every 15 minutes.
  UPDATE public.customer_documents d
     SET status = 'failed', claimed_at = NULL,
         last_error = coalesce(d.last_error, 'The copy stopped without an answer 10 times')
   WHERE d.id IN (SELECT x.id FROM public.customer_documents x
                   WHERE x.status = 'pending' AND x.attempts >= 10
                     AND x.next_attempt_at <= v_at
                     AND (x.claimed_at IS NULL OR x.claimed_at < v_at - interval '15 minutes')
                   ORDER BY x.received_at, x.id
                   LIMIT 200
                     FOR UPDATE SKIP LOCKED);
  RETURN QUERY
  WITH picked AS (
    SELECT d.id
      FROM public.customer_documents d
     WHERE d.status = 'pending' AND d.attempts < 10
       AND d.next_attempt_at <= v_at
       AND (d.claimed_at IS NULL OR d.claimed_at < v_at - interval '15 minutes')
     ORDER BY d.received_at, d.id
     LIMIT p_limit
       FOR UPDATE SKIP LOCKED
  ), upd AS (
    UPDATE public.customer_documents d
       SET claimed_at = v_at, attempts = d.attempts + 1
      FROM picked
     WHERE d.id = picked.id
    RETURNING d.id, d.folder_id, d.kind, d.mime, d.original_name, d.caption,
              d.media_url, d.received_at, d.attempts, d.claimed_at,
              d.storage_bucket, d.storage_path
  )
  SELECT upd.id, upd.folder_id, f.ref, upd.kind, upd.mime, upd.original_name,
         upd.caption, upd.media_url, upd.received_at, upd.attempts, upd.claimed_at,
         upd.storage_bucket, upd.storage_path
    FROM upd
    JOIN public.customer_doc_folders f ON f.id = upd.folder_id
   ORDER BY upd.received_at, upd.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.customer_documents_stats()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'failed', (SELECT count(*) FROM public.customer_documents d WHERE d.status = 'failed'),
    'oldest_pending_age_seconds',
      (SELECT floor(extract(epoch FROM now() - min(d.created_at)))::bigint
         FROM public.customer_documents d WHERE d.status = 'pending'))
$$;
REVOKE ALL ON FUNCTION public.customer_documents_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_documents_stats() TO service_role;

RESET lock_timeout;
NOTIFY pgrst, 'reload schema';
