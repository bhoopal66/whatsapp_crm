-- ============================================================
-- 262_privacy_fixes.sql — PDPL erase and retention: do not delete shared
-- files, never leave the workspace, never lose the list, honour holds.
--
-- RESTATES 222's privacy_subject_erase, 223's privacy_retention_problem and
-- privacy_retention_sweep, and 225's case_review_claim: apply in order,
-- once (re-running 222, 223 or 225 afterwards reverts them).
--
--  1. privacy_objects_unreferenced(account, objects): the erase's list of
--     stored files, de-duplicated, as {bucket, path}, without any file a
--     remaining row still points at. Run after the erase's own deletes, so
--     "remaining" is exact, and again before every retry. Chat media is
--     compared on the path after /chat-media/, because the public origin
--     changes. One pass of each table against the candidate set.
--  2. Only paths under account-<this account>/ (or <this account>/ outside
--     chat-media, or a case-files path not of another workspace) are ever
--     listed: messages.media_url is written by callers.
--  3. A real erase stores its list in privacy_requests.detail
--     (objects_list) in the same transaction. privacy_erase_objects_pending
--     lists the unfinished ones for the daily job, which records the result
--     through privacy_erase_objects_settle (system:retention).
--  4. The retention sweep leaves alone: calls 222 would match to a held
--     customer, rooms of or with a held customer, groups with a held
--     participant. It also sets recording_state with erased_at: 089's
--     calls_erased_check needs both, so 223's call sweep always failed.
--  5. A released hold no longer blocks deleting the contact
--     (ON DELETE CASCADE); an active one refuses it (42501, LEGAL_HOLD).
--  6. privacy_retention_problem refuses a missing days or action.
--  7. case_review_claim fails a run after 5 attempts instead of
--     reclaiming it for ever.
--
-- An opt-out survives an erase only on the anonymised row: the number is
-- gone, so a re-imported number starts with no opt-out (docs/privacy.md;
-- 222's header says otherwise).
--
-- Apply after 261 as a superuser or BYPASSRLS role, before the build.
-- Re-runnable. verify-privacy.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '262 must be applied by a superuser or BYPASSRLS role';
  END IF;
  IF to_regprocedure('public.funnel_chat_reached_tag(uuid,uuid)') IS NOT NULL
     OR to_regprocedure('public.profiles_drop_report_access()') IS NULL THEN
    RAISE EXCEPTION '262: apply 261_report_counting.sql first';
  END IF;
END $$;

-- ---------- 1, 2: which files an erase may delete ----------

-- The object path of a chat-media URL (its part after /chat-media/, no
-- query), or NULL. No SET clause on purpose: it must inline.
CREATE OR REPLACE FUNCTION public.privacy_media_path(p_url text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT pg_catalog.substring(pg_catalog.split_part(pg_catalog.split_part(p_url, '?', 1), '#', 1), '/chat-media/(.+)$')
$$;

-- p_objects: [{bucket, path} | {bucket: 'chat-media', url}]. enable_nestloop
-- is off so `messages` is always hashed once against the candidates (a
-- misestimate would otherwise scan it once per file).
CREATE OR REPLACE FUNCTION public.privacy_objects_unreferenced(p_account uuid, p_objects jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
SET enable_nestloop = off
AS $$
DECLARE
  v_token text := 'account-' || p_account::text || '/[^"?#\\[:space:]]+';
  v_like  text := '%account-' || p_account::text || '/%';
  v_out   jsonb;
BEGIN
  IF p_objects IS NULL OR jsonb_typeof(p_objects) <> 'array' OR p_objects = '[]'::jsonb THEN
    RETURN '[]'::jsonb;
  END IF;
  WITH cand AS MATERIALIZED (
    SELECT DISTINCT x.bucket, x.path
      FROM (SELECT e ->> 'bucket' AS bucket, coalesce(e ->> 'path', public.privacy_media_path(e ->> 'url')) AS path
              FROM jsonb_array_elements(p_objects) AS t(e)) x
     WHERE x.bucket IS NOT NULL
       AND (starts_with(x.path, 'account-' || p_account::text || '/')
            OR (x.bucket <> 'chat-media' AND starts_with(x.path, p_account::text || '/'))
            -- case-files paths carry no account (cases/<case id>/…,
            -- intake/<item id>/…). Only service-role RPCs write them; the
            -- owner, if it still exists, must not be another workspace's.
            OR (x.bucket = 'case-files' AND x.path ~ '^(cases|intake)/[0-9a-f-]{36}/[^/]+$'
                AND NOT EXISTS (SELECT 1 FROM public.cases k
                                 WHERE k.id::text = split_part(x.path, '/', 2) AND k.account_id <> p_account)
                AND NOT EXISTS (SELECT 1 FROM public.intake_items i
                                 WHERE i.id::text = split_part(x.path, '/', 2) AND i.account_id <> p_account)))
       AND x.path !~ '(^|/)[.]{0,2}(/|$)'),
  texts AS (  -- free-form columns that may quote a path or a URL
    SELECT g.media::text AS t FROM public.group_messages g WHERE g.media IS NOT NULL
    UNION ALL SELECT g.media::text FROM public.whatsapp_group_messages g WHERE g.media IS NOT NULL
    UNION ALL SELECT g.media::text FROM public.submission_group_messages g WHERE g.media IS NOT NULL
    UNION ALL SELECT n.config::text FROM public.flow_nodes n
    UNION ALL SELECT s.step_config::text FROM public.automation_steps s
    UNION ALL SELECT d.state::text FROM public.broadcast_drafts d),
  urls AS (
    SELECT m.media_url AS u FROM public.messages m WHERE m.media_url IS NOT NULL
    UNION ALL SELECT d.media_url FROM public.customer_documents d WHERE d.media_url IS NOT NULL
    UNION ALL SELECT n.media_url FROM public.voice_note_entries n WHERE n.media_url IS NOT NULL
    UNION ALL SELECT t.header_media_url FROM public.message_templates t WHERE t.header_media_url IS NOT NULL
    UNION ALL SELECT b.header_media_url FROM public.broadcasts b WHERE b.header_media_url IS NOT NULL),
  used AS (
    SELECT 'chat-media'::text AS bucket, public.privacy_media_path(u.u) AS path FROM urls u WHERE u.u LIKE v_like
    UNION ALL SELECT 'chat-media', n.storage_path FROM public.voice_note_entries n
    UNION ALL SELECT 'chat-media', r.m[1] FROM texts x
              CROSS JOIN LATERAL regexp_matches(x.t, '(' || v_token || ')', 'g') AS r(m) WHERE x.t LIKE v_like
    UNION ALL SELECT 'call-recordings', c.storage_path FROM public.call_recordings c
    UNION ALL SELECT 'deal-files', f.storage_path FROM public.deal_files f
    UNION ALL SELECT d.storage_bucket, d.storage_path FROM public.customer_documents d WHERE d.storage_path IS NOT NULL
    UNION ALL SELECT 'case-files', i.storage_path FROM public.intake_items i)
  SELECT jsonb_agg(jsonb_build_object('bucket', c.bucket, 'path', c.path) ORDER BY c.bucket, c.path) INTO v_out
    FROM cand c
   WHERE NOT EXISTS (SELECT 1 FROM used u WHERE u.bucket = c.bucket AND u.path = c.path);
  RETURN coalesce(v_out, '[]'::jsonb);
END;
$$;

-- ---------- 222's erase, restated ----------

CREATE OR REPLACE FUNCTION public.privacy_subject_erase(p_actor uuid, p_account uuid, p_contact uuid,
  p_dry_run boolean DEFAULT true, p_confirm text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c        public.contacts%ROWTYPE;
  v_digits text;
  v_phone  text;
  v_convs  uuid[];
  v_parts  uuid[];
  v_calls  uuid[];
  v_deals  uuid[];
  v_brain  uuid[];
  v_counts jsonb := '{}'::jsonb;
  v_obj    jsonb := '[]'::jsonb;
  v_n      integer;
  v_id     bigint;
  v_ext    jsonb;
  r        record;
BEGIN
  PERFORM public.privacy_require_admin('privacy_subject_erase', p_actor, p_account);
  SELECT * INTO c FROM public.contacts x WHERE x.id = p_contact AND x.account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT coalesce(p_dry_run, true) AND p_confirm IS DISTINCT FROM 'ERASE ' || p_contact::text THEN
    RAISE EXCEPTION 'privacy_subject_erase: confirm with ERASE <contact id>'
      USING ERRCODE = 'check_violation', HINT = 'CONFIRM_REQUIRED';
  END IF;
  v_phone := nullif(c.phone_normalized, '');
  v_digits := public.privacy_digits(coalesce(c.phone_normalized, c.phone));

  -- Calls: 093's match (pbx_erase_contact_calls), inlined.
  SELECT coalesce(array_agg(x.id), '{}') INTO v_calls FROM public.calls x
   WHERE x.account_id = p_account
     AND (x.contact_id = p_contact
          OR x.meta -> 'contact_candidates' ? p_contact::text
          OR v_phone = ANY (public.pbx_phone_variants(x.remote_number))
          OR (length(v_phone) >= 8 AND length(x.remote_number) >= 8
              AND right(x.remote_number, 8) = right(v_phone, 8)
              AND NOT EXISTS (SELECT 1 FROM public.contacts o
                               WHERE o.account_id = p_account
                                 AND o.phone_normalized = ANY (public.pbx_phone_variants(x.remote_number)))));

  IF public.privacy_on_hold(p_account, p_contact)
     OR EXISTS (SELECT 1 FROM public.call_recordings r2 WHERE r2.call_id = ANY (v_calls) AND r2.legal_hold) THEN
    INSERT INTO public.privacy_requests (account_id, kind, contact_hash, actor_id, detail)
    VALUES (p_account, CASE WHEN coalesce(p_dry_run, true) THEN 'erase_dry_run' ELSE 'erase' END,
            public.privacy_contact_hash(p_account, p_contact), p_actor, jsonb_build_object('blocked', 'legal_hold'))
    RETURNING id INTO v_id;
    RETURN jsonb_build_object('mode', CASE WHEN coalesce(p_dry_run, true) THEN 'dry_run' ELSE 'erase' END,
                              'blocked', 'legal_hold', 'request_id', v_id);
  END IF;

  SELECT coalesce(array_agg(x.id), '{}') INTO v_convs FROM public.conversations x
   WHERE x.contact_id = p_contact AND x.account_id = p_account;
  SELECT coalesce(array_agg(x.id), '{}') INTO v_parts FROM public.deal_room_participants x
   WHERE x.contact_id = p_contact AND x.account_id = p_account;
  SELECT coalesce(array_agg(x.id), '{}') INTO v_deals FROM public.deals x
   WHERE x.contact_id = p_contact AND x.account_id = p_account;
  SELECT coalesce(array_agg(x.item_id), '{}') INTO v_brain FROM public.brain_items x
   WHERE x.contact_id = p_contact AND x.account_id = p_account;

  BEGIN
    -- Files to delete after the commit (collected before their rows go;
    -- 262 drops those a remaining row points at once the deletes are done).
    SELECT coalesce(jsonb_agg(jsonb_build_object('bucket', 'call-recordings', 'path', r2.storage_path)), '[]')
      INTO v_obj FROM public.call_recordings r2 WHERE r2.call_id = ANY (v_calls) AND r2.storage_path IS NOT NULL;
    v_obj := v_obj || (SELECT coalesce(jsonb_agg(jsonb_build_object('bucket', 'deal-files', 'path', f.storage_path)), '[]')
                         FROM public.deal_files f WHERE f.deal_id = ANY (v_deals) AND f.storage_path IS NOT NULL);
    v_obj := v_obj || (SELECT coalesce(jsonb_agg(CASE WHEN d.storage_bucket IS NOT NULL
                                                    THEN jsonb_build_object('bucket', d.storage_bucket, 'path', d.storage_path)
                                                    ELSE jsonb_build_object('bucket', 'chat-media', 'url', d.media_url) END), '[]')
                         FROM public.customer_documents d
                        WHERE d.contact_id = p_contact AND d.account_id = p_account AND d.case_id IS NULL
                          AND NOT EXISTS (SELECT 1 FROM public.case_document_files f WHERE f.customer_document_id = d.id)
                          AND (d.storage_path IS NOT NULL OR d.media_url IS NOT NULL));
    v_obj := v_obj || (SELECT coalesce(jsonb_agg(jsonb_build_object('bucket', 'chat-media', 'url', m.media_url)), '[]')
                         FROM public.messages m
                        WHERE m.conversation_id = ANY (v_convs) AND m.media_url IS NOT NULL);

    -- Tables of later migrations (229 onward): each registers its own erase
    -- in privacy_extensions, answering {counts, objects}; it collects its
    -- storage objects before deleting its rows. They run before the
    -- deletes below, so a row referencing a chat, message or document is
    -- removed (and counted) before its parent. Absent before 229.
    IF to_regclass('public.privacy_extensions') IS NOT NULL THEN
      FOR r IN SELECT e.name, e.erase_fn FROM public.privacy_extensions e
                WHERE e.erase_fn IS NOT NULL ORDER BY e.name LOOP
        EXECUTE format('SELECT public.%I($1, $2)', r.erase_fn) INTO v_ext USING p_account, p_contact;
        v_counts := v_counts || coalesce(v_ext->'counts', '{}'::jsonb);
        v_obj := v_obj || coalesce(v_ext->'objects', '[]'::jsonb);
      END LOOP;
    END IF;

    -- Chats and messages.
    FOR r IN SELECT * FROM (VALUES
        ('message_reactions'), ('message_translations'), ('message_reminder_suggestions'), ('conversation_events'),
        ('conversation_insight_events'), ('conversation_coordinator_shares'), ('compose_check_events'),
        ('ai_reply_events'), ('ai_knowledge_gaps'), ('push_outbox'), ('hr_agent_drafts'), ('hr_stage_history'),
        ('hr_rule_fired'), ('hr_conversations')) t(tbl) LOOP
      EXECUTE format('DELETE FROM public.%I WHERE conversation_id = ANY ($1)', r.tbl) USING v_convs;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_counts := v_counts || jsonb_build_object(r.tbl, v_n);
    END LOOP;
    UPDATE public.customer_documents d SET message_id = NULL
     WHERE d.account_id = p_account AND d.message_id IN (SELECT m.id FROM public.messages m WHERE m.conversation_id = ANY (v_convs));
    DELETE FROM public.messages m WHERE m.conversation_id = ANY (v_convs);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('messages', v_n);
    UPDATE public.ai_usage_log x SET conversation_id = NULL WHERE x.conversation_id = ANY (v_convs);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('ai_usage_log', v_n);
    UPDATE public.conversations x
       SET last_message_text = NULL, ai_handoff_summary = NULL, ai_pending_draft = NULL, ai_pending_draft_at = NULL
     WHERE x.id = ANY (v_convs);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('conversations', v_n);
    DELETE FROM public.notifications x
     WHERE x.account_id = p_account AND (x.contact_id = p_contact OR x.conversation_id = ANY (v_convs));
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('notifications', v_n);

    -- Rows keyed by the contact.
    FOR r IN SELECT * FROM (VALUES
        ('contact_custom_values'), ('contact_notes'), ('contact_tags'), ('ts_decision_log'), ('automation_logs'),
        ('automation_pending_executions'), ('flow_runs'), ('journey_files'), ('tasks'), ('callback_requests'),
        ('call_live')) t(tbl) LOOP
      EXECUTE format('DELETE FROM public.%I WHERE contact_id = $1', r.tbl) USING p_contact;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_counts := v_counts || jsonb_build_object(r.tbl, v_n);
    END LOOP;
    UPDATE public.broadcast_recipients x SET template_params = NULL, error_message = NULL WHERE x.contact_id = p_contact;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('broadcast_recipients', v_n);

    -- Deals: the row stays, its customer text goes.
    DELETE FROM public.deal_files f WHERE f.deal_id = ANY (v_deals);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('deal_files', v_n);
    UPDATE public.deals x SET title = 'Erased customer', notes = NULL WHERE x.id = ANY (v_deals);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('deals', v_n);

    -- Calls (093's erase, inlined).
    DELETE FROM public.call_recordings r2 WHERE r2.call_id = ANY (v_calls);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('call_recordings', v_n);
    UPDATE public.calls x
       SET notes = NULL, disposition = NULL, notes_updated_by = NULL, notes_updated_at = NULL,
           recording_state = 'erased', erased_at = coalesce(x.erased_at, now())
     WHERE x.id = ANY (v_calls);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('calls', v_n);
    IF v_n > 0 THEN
      INSERT INTO public.pbx_audit (account_id, actor_id, action, contact_id, call_ids, reason, detail)
      VALUES (p_account, p_actor, 'erase_contact_calls', p_contact, v_calls, 'PDPL erasure request',
              jsonb_build_object('recordings', v_counts -> 'call_recordings'));
    END IF;

    -- Unfiled documents (a document filed to a case stays with it).
    DELETE FROM public.customer_documents d
     WHERE d.contact_id = p_contact AND d.account_id = p_account AND d.case_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.case_document_files f WHERE f.customer_document_id = d.id);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('customer_documents', v_n);

    -- Integrations and groups.
    UPDATE public.compass_contacts x SET name = NULL, phone = NULL, email = NULL,
           company = NULL, attributes = '{}'::jsonb
     WHERE x.contact_id = p_contact AND x.account_id = p_account;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('compass_contacts', v_n);
    UPDATE public.compass_notifications x SET phone = NULL, content_text = NULL
     WHERE x.contact_id = p_contact AND x.account_id = p_account;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('compass_notifications', v_n);
    DELETE FROM public.group_message_receipts x WHERE x.participant_id = ANY (v_parts);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('group_message_receipts', v_n);
    UPDATE public.group_messages x SET body = NULL, media = NULL, sender_wa_id = NULL
     WHERE x.sender_participant_id = ANY (v_parts) AND x.account_id = p_account;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('group_messages', v_n);
    UPDATE public.deal_room_participants x SET display_name = 'Erased customer', phone = NULL, wa_id = NULL
     WHERE x.id = ANY (v_parts);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('deal_room_participants', v_n);
    DELETE FROM public.deal_room_join_requests x
     WHERE v_digits IS NOT NULL AND x.account_id = p_account AND public.privacy_digits(x.wa_id) = v_digits;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('deal_room_join_requests', v_n);
    UPDATE public.whatsapp_group_messages x SET body = NULL, media = NULL, sender_name = NULL, sender_wa_id = 'erased'
     WHERE v_digits IS NOT NULL AND x.account_id = p_account AND public.privacy_digits(x.sender_wa_id) = v_digits;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('whatsapp_group_messages', v_n);
    UPDATE public.whatsapp_group_participants x
       SET wa_id = 'erased-' || left(md5(x.group_id::text || x.wa_id), 12), contact_id = NULL
     WHERE x.account_id = p_account
       AND (x.contact_id = p_contact OR (v_digits IS NOT NULL AND public.privacy_digits(x.wa_id) = v_digits));
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('whatsapp_group_participants', v_n);
    UPDATE public.whatsapp_message_costs x SET recipient_wa_id = 'erased'
     WHERE v_digits IS NOT NULL AND x.account_id = p_account AND public.privacy_digits(x.recipient_wa_id) = v_digits;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('whatsapp_message_costs', v_n);
    UPDATE public.taamul_sales_contacts x
       SET customer_name = NULL, company_name = NULL, phone = NULL, phone_raw = NULL,
           additional_phones = '{}', trade_license_number = NULL, call_notes = NULL
     WHERE v_digits IS NOT NULL AND x.account_id = p_account AND public.privacy_digits(x.phone) = v_digits;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('taamul_sales_contacts', v_n);

    -- HR automated messages: the row stays for the cap and dedupe.
    UPDATE public.hr_automsg_outbox x SET body_rendered = '', params = '[]'::jsonb
     WHERE x.contact_id = p_contact AND x.account_id = p_account;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('hr_automsg_outbox', v_n);

    -- Memory, brain, vault.
    DELETE FROM public.memory_acl x WHERE x.account_id = p_account AND x.scope_type = 'contact' AND x.scope_id = p_contact;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('memory_acl', v_n);
    SELECT count(*)::integer INTO v_n FROM public.memory_items x
     WHERE x.account_id = p_account AND x.scope_type = 'contact' AND x.scope_id = p_contact;
    IF v_n > 0 THEN
      PERFORM public.memory_forget(p_actor, p_account, 'contact', p_contact, 'PDPL erasure request');
    END IF;
    v_counts := v_counts || jsonb_build_object('memory_items', v_n);
    DELETE FROM public.brain_items x WHERE x.item_id = ANY (v_brain);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('brain_items', v_n);
    PERFORM public.brain_page_wipe(p_account, v_brain, p_contact);
    DELETE FROM public.brain_pages x WHERE x.account_id = p_account AND x.kind = 'contact' AND x.key = p_contact::text;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('brain_pages', v_n);
    UPDATE public.vault_items i
       SET deleted_at = clock_timestamp(), deleted_by = p_actor, ciphertext = '\x'::bytea, iv = '\x'::bytea,
           auth_tag = '\x'::bytea, blind_index = NULL
     WHERE i.account_id = p_account AND i.subject_type = 'contact' AND i.subject_id = p_contact AND i.deleted_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('vault_items', v_n);
    IF v_n > 0 THEN
      INSERT INTO public.vault_audit (action, outcome, actor, account_id, subject_type, subject_id, reason)
      VALUES ('delete', 'OK', p_actor, p_account, 'contact', p_contact, 'PDPL erasure request');
    END IF;

    -- The contact itself, last: anonymised, opt-out and consent kept.
    UPDATE public.contacts x
       SET name = 'Erased customer', email = NULL, company = NULL, avatar_url = NULL, avatar_checked_at = NULL,
           phone = 'erased-' || left(replace(x.id::text, '-', ''), 12)
     WHERE x.id = p_contact;
    v_counts := v_counts || jsonb_build_object('contacts', 1);

    -- 262: everything this erase removes is gone now, so what still points
    -- at a file is exactly what survives.
    v_obj := public.privacy_objects_unreferenced(p_account, v_obj);

    IF coalesce(p_dry_run, true) THEN
      RAISE EXCEPTION USING ERRCODE = 'ZP222', MESSAGE = 'privacy_subject_erase dry run';
    END IF;
  EXCEPTION WHEN SQLSTATE 'ZP222' THEN
    NULL;  -- the dry run's changes are rolled back; the counts survive
  END;

  INSERT INTO public.privacy_requests (account_id, kind, contact_hash, actor_id, detail)
  VALUES (p_account, CASE WHEN coalesce(p_dry_run, true) THEN 'erase_dry_run' ELSE 'erase' END,
          public.privacy_contact_hash(p_account, p_contact), p_actor,
          jsonb_build_object('counts', v_counts, 'objects', jsonb_array_length(v_obj),
                             'objects_state', CASE WHEN coalesce(p_dry_run, true) OR jsonb_array_length(v_obj) = 0
                                                   THEN 'none' ELSE 'pending' END)
          -- 262: the only copy of the list if the app dies before deleting.
          || CASE WHEN coalesce(p_dry_run, true) OR jsonb_array_length(v_obj) = 0 THEN '{}'::jsonb
                  ELSE jsonb_build_object('objects_list', v_obj) END)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('mode', CASE WHEN coalesce(p_dry_run, true) THEN 'dry_run' ELSE 'erase' END,
    'request_id', v_id, 'counts', v_counts,
    'objects', CASE WHEN coalesce(p_dry_run, true) THEN '[]'::jsonb ELSE v_obj END,
    'objects_count', jsonb_array_length(v_obj));
END;
$$;

-- ---------- 3: files not recorded as deleted ----------

-- Erasures whose files are not recorded as done: the newest result is
-- 'pending' (its remaining files), or there is none after 10 minutes (the
-- stored list). Re-checked against rule 1, so a file used again since is
-- left out; an empty list still comes back, to be recorded as done.
CREATE OR REPLACE FUNCTION public.privacy_erase_objects_pending(p_limit integer DEFAULT 20)
RETURNS TABLE (account_id uuid, request_id bigint, objects jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT x.account_id, x.id, public.privacy_objects_unreferenced(x.account_id, x.objects)
    FROM (SELECT r.account_id, r.id,
                 CASE WHEN d.id IS NULL THEN r.detail -> 'objects_list' ELSE d.detail -> 'remaining' END AS objects
            FROM public.privacy_requests r
            LEFT JOIN LATERAL (SELECT o.id, o.detail FROM public.privacy_requests o
                                WHERE o.account_id = r.account_id AND o.kind = 'objects_done'
                                  AND o.detail ->> 'request_id' = r.id::text
                                ORDER BY o.id DESC LIMIT 1) d ON true
           WHERE r.kind = 'erase'
             AND (d.detail ->> 'objects_state' = 'pending'
                  OR (d.id IS NULL AND r.detail ? 'objects_list' AND r.at < now() - interval '10 minutes'))
           ORDER BY coalesce(d.id, r.id)
           LIMIT greatest(1, least(coalesce(p_limit, 20), 100))) x
   WHERE jsonb_typeof(x.objects) = 'array'
$$;

-- The daily job's result (no signed-in actor).
CREATE OR REPLACE FUNCTION public.privacy_erase_objects_settle(p_request bigint, p_remaining jsonb)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
BEGIN
  SELECT r.account_id INTO v_account FROM public.privacy_requests r WHERE r.id = p_request AND r.kind = 'erase';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'privacy_erase_objects_settle: request not found' USING ERRCODE = 'no_data_found', HINT = 'NOT_FOUND';
  END IF;
  IF p_remaining IS NULL OR jsonb_typeof(p_remaining) <> 'array' THEN
    RAISE EXCEPTION 'privacy_erase_objects_settle: remaining must be an array' USING ERRCODE = 'check_violation', HINT = 'INVALID';
  END IF;
  INSERT INTO public.privacy_requests (account_id, kind, actor_label, detail)
  VALUES (v_account, 'objects_done', 'system:retention', jsonb_build_object('request_id', p_request,
          'objects_state', CASE WHEN jsonb_array_length(p_remaining) = 0 THEN 'done' ELSE 'pending' END,
          'remaining', p_remaining));
END;
$$;

-- ---------- 6, 4: retention, restated from 223 ----------

CREATE OR REPLACE FUNCTION public.privacy_retention_problem(p_policy jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  r     record;
  v_act text[];
BEGIN
  IF p_policy IS NULL OR jsonb_typeof(p_policy) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_policy) k WHERE k <> 'tables') > 0
     OR jsonb_typeof(p_policy -> 'tables') IS DISTINCT FROM 'object' THEN
    RETURN 'the policy must be {"tables": {…}}';
  END IF;
  FOR r IN SELECT k, v FROM jsonb_each(p_policy -> 'tables') AS e(k, v) LOOP
    SELECT x.actions INTO v_act FROM public.privacy_retention_rules() x WHERE x.key = r.k;
    IF v_act IS NULL THEN
      RETURN format('%s is not a retention key', r.k);
    END IF;
    IF jsonb_typeof(r.v) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(r.v) k WHERE k NOT IN ('days', 'action')) > 0 THEN
      RETURN format('%s: only days and action', r.k);
    END IF;
    IF jsonb_typeof(r.v -> 'days') IS DISTINCT FROM 'number' OR (r.v ->> 'days') !~ '^[0-9]+$'
       OR (r.v ->> 'days')::numeric NOT BETWEEN 30 AND 36500 THEN
      RETURN format('%s: days must be a whole number from 30 to 36500', r.k);
    END IF;
    IF ((r.v ->> 'action') = ANY (v_act)) IS NOT TRUE THEN
      RETURN format('%s: action must be one of %s', r.k, array_to_string(v_act, ', '));
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.privacy_retention_sweep(p_account uuid, p_dry_run boolean DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  s       public.privacy_retention_settings%ROWTYPE;
  v_dry   boolean;
  r       record;
  v_cut   timestamptz;
  v_n     integer;
  v_held  integer;
  v_out   jsonb := '{}'::jsonb;
  v_id    bigint;
  v_ids    text[];
  v_phones text[];
BEGIN
  SELECT * INTO s FROM public.privacy_retention_settings x WHERE x.account_id = p_account;
  IF NOT FOUND OR s.policy -> 'tables' = '{}'::jsonb THEN
    RETURN NULL;
  END IF;
  IF public.privacy_retention_problem(s.policy) IS NOT NULL THEN
    RAISE EXCEPTION 'privacy_retention_sweep: the stored policy is invalid' USING ERRCODE = 'check_violation', HINT = 'INVALID';
  END IF;
  v_dry := coalesce(p_dry_run, NOT s.apply);

  -- Contacts under a legal hold, and their phone digits.
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.privacy_held (contact_id uuid, digits text, phone text) ON COMMIT DROP;
  TRUNCATE pg_temp.privacy_held;
  INSERT INTO pg_temp.privacy_held
  SELECT c.id, public.privacy_digits(coalesce(c.phone_normalized, c.phone)), nullif(c.phone_normalized, '')
    FROM public.privacy_legal_holds h JOIN public.contacts c ON c.id = h.contact_id
   WHERE h.account_id = p_account AND h.released_at IS NULL;

  -- 262: what else belongs to a held customer. Calls: 222's match (093),
  -- set-based; change both. Rooms: theirs, or with them in it. Groups: with
  -- them in it.
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.privacy_held_rows (kind text, id uuid) ON COMMIT DROP;
  TRUNCATE pg_temp.privacy_held_rows;
  IF EXISTS (SELECT 1 FROM pg_temp.privacy_held) THEN
    SELECT array_agg(h.contact_id::text), coalesce(array_agg(h.phone) FILTER (WHERE h.phone IS NOT NULL), '{}')
      INTO v_ids, v_phones FROM pg_temp.privacy_held h;
    INSERT INTO pg_temp.privacy_held_rows
    SELECT 'call', x.id FROM public.calls x
     WHERE x.account_id = p_account AND x.erased_at IS NULL
       AND (x.contact_id::text = ANY (v_ids)
            OR x.meta -> 'contact_candidates' ?| v_ids
            OR public.pbx_phone_variants(x.remote_number)::text[] && v_phones
            OR (length(x.remote_number) >= 8
                AND right(x.remote_number, 8) IN (SELECT right(h.phone, 8) FROM pg_temp.privacy_held h WHERE length(h.phone) >= 8)
                AND NOT EXISTS (SELECT 1 FROM public.contacts o
                                 WHERE o.account_id = p_account
                                   AND o.phone_normalized = ANY (public.pbx_phone_variants(x.remote_number)))));
    INSERT INTO pg_temp.privacy_held_rows
    SELECT 'room', d.id FROM public.deal_rooms d
     WHERE d.account_id = p_account AND d.contact_id IN (SELECT h.contact_id FROM pg_temp.privacy_held h)
    UNION
    SELECT 'room', p.room_id FROM public.deal_room_participants p
     WHERE p.account_id = p_account AND p.contact_id IN (SELECT h.contact_id FROM pg_temp.privacy_held h);
    INSERT INTO pg_temp.privacy_held_rows
    SELECT DISTINCT 'group', p.group_id FROM public.whatsapp_group_participants p
     WHERE p.account_id = p_account
       AND (p.contact_id IN (SELECT h.contact_id FROM pg_temp.privacy_held h)
            OR public.privacy_digits(p.wa_id) IN (SELECT h.digits FROM pg_temp.privacy_held h WHERE h.digits IS NOT NULL));
  END IF;

  BEGIN
    FOR r IN SELECT k, (v ->> 'days')::integer AS days, v ->> 'action' AS action
               FROM jsonb_each(s.policy -> 'tables') AS e(k, v) ORDER BY k LOOP
      v_cut := now() - make_interval(days => r.days);
      IF r.k = 'deal_room_messages' THEN
        SELECT count(*) INTO v_held FROM public.group_messages m
         WHERE m.account_id = p_account AND m.created_at < v_cut AND m.room_id IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'room');
        IF r.action = 'delete' THEN
          DELETE FROM public.group_messages m WHERE m.account_id = p_account AND m.created_at < v_cut
             AND m.room_id NOT IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'room');
        ELSE
          UPDATE public.group_messages m SET body = NULL, media = NULL, sender_wa_id = NULL
           WHERE m.account_id = p_account AND m.created_at < v_cut AND (m.body IS NOT NULL OR m.media IS NOT NULL)
             AND m.room_id NOT IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'room');
        END IF;
      ELSIF r.k = 'whatsapp_group_messages' THEN
        SELECT count(*) INTO v_held FROM public.whatsapp_group_messages m
         WHERE m.account_id = p_account AND m.created_at < v_cut
           AND (m.group_id IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'group')
                OR public.privacy_digits(m.sender_wa_id) IN (SELECT digits FROM pg_temp.privacy_held WHERE digits IS NOT NULL));
        IF r.action = 'delete' THEN
          DELETE FROM public.whatsapp_group_messages m WHERE m.account_id = p_account AND m.created_at < v_cut
             AND m.group_id NOT IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'group')
             AND coalesce(public.privacy_digits(m.sender_wa_id), '') NOT IN (SELECT digits FROM pg_temp.privacy_held WHERE digits IS NOT NULL);
        ELSE
          UPDATE public.whatsapp_group_messages m SET body = NULL, media = NULL, sender_name = NULL
           WHERE m.account_id = p_account AND m.created_at < v_cut
             AND (m.body IS NOT NULL OR m.media IS NOT NULL OR m.sender_name IS NOT NULL)
             AND m.group_id NOT IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'group')
             AND coalesce(public.privacy_digits(m.sender_wa_id), '') NOT IN (SELECT digits FROM pg_temp.privacy_held WHERE digits IS NOT NULL);
        END IF;
      ELSIF r.k = 'hr_outbox_bodies' THEN
        SELECT count(*) INTO v_held FROM public.hr_automsg_outbox o
         WHERE o.account_id = p_account AND o.created_at < v_cut AND o.status IN ('sent', 'failed', 'cancelled')
           AND o.contact_id IN (SELECT contact_id FROM pg_temp.privacy_held);
        UPDATE public.hr_automsg_outbox o SET body_rendered = '', params = '[]'::jsonb
         WHERE o.account_id = p_account AND o.created_at < v_cut AND o.status IN ('sent', 'failed', 'cancelled')
           AND o.body_rendered <> '' AND o.contact_id NOT IN (SELECT contact_id FROM pg_temp.privacy_held);
      ELSIF r.k = 'hr_agent_drafts' THEN
        SELECT count(*) INTO v_held FROM public.hr_agent_drafts d JOIN public.conversations v ON v.id = d.conversation_id
         WHERE d.account_id = p_account AND d.created_at < v_cut AND d.status <> 'pending'
           AND v.contact_id IN (SELECT contact_id FROM pg_temp.privacy_held);
        DELETE FROM public.hr_agent_drafts d USING public.conversations v
         WHERE v.id = d.conversation_id AND d.account_id = p_account AND d.created_at < v_cut AND d.status <> 'pending'
           AND v.contact_id NOT IN (SELECT contact_id FROM pg_temp.privacy_held);
      ELSIF r.k = 'call_records' THEN
        SELECT count(*) INTO v_held FROM public.calls c
         WHERE c.account_id = p_account AND c.started_at < v_cut AND c.erased_at IS NULL
           AND c.id IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'call');
        UPDATE public.calls c SET notes = NULL, disposition = NULL, notes_updated_by = NULL, notes_updated_at = NULL,
               recording_state = 'erased', erased_at = now()
         WHERE c.account_id = p_account AND c.started_at < v_cut AND c.erased_at IS NULL
           AND c.id NOT IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'call')
           AND NOT EXISTS (SELECT 1 FROM public.call_recordings rr WHERE rr.call_id = c.id AND rr.erased_at IS NULL);
      END IF;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_out := v_out || jsonb_build_object(r.k, jsonb_build_object('action', r.action, 'days', r.days,
                                                                   'rows', v_n, 'held_skipped', v_held));
    END LOOP;
    IF v_dry THEN
      RAISE EXCEPTION USING ERRCODE = 'ZP223', MESSAGE = 'privacy_retention_sweep dry run';
    END IF;
  EXCEPTION WHEN SQLSTATE 'ZP223' THEN
    NULL;
  END;

  INSERT INTO public.privacy_requests (account_id, kind, actor_label, detail)
  VALUES (p_account, CASE WHEN v_dry THEN 'retention_dry_run' ELSE 'retention' END, 'system:retention',
          jsonb_build_object('tables', v_out))
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('mode', CASE WHEN v_dry THEN 'dry_run' ELSE 'apply' END, 'request_id', v_id, 'tables', v_out);
END;
$$;

-- ---------- 5: deleting a contact that was once held ----------

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.privacy_legal_holds'::regclass
                  AND c.conname = 'privacy_legal_holds_contact_fkey' AND c.confdeltype = 'c') THEN
    ALTER TABLE public.privacy_legal_holds DROP CONSTRAINT IF EXISTS privacy_legal_holds_contact_fkey,
      ADD CONSTRAINT privacy_legal_holds_contact_fkey FOREIGN KEY (contact_id, account_id)
        REFERENCES public.contacts (id, account_id) ON DELETE CASCADE;
  END IF;
END $$;

-- One index probe (privacy_legal_holds_one_active) per deleted contact.
CREATE OR REPLACE FUNCTION public.contacts_legal_hold_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF public.privacy_on_hold(OLD.account_id, OLD.id) THEN
    RAISE EXCEPTION 'this customer is under a legal hold and cannot be deleted'
      USING ERRCODE = 'insufficient_privilege', HINT = 'LEGAL_HOLD';
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS contacts_legal_hold_guard ON public.contacts;
CREATE TRIGGER contacts_legal_hold_guard BEFORE DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_legal_hold_guard();

-- ---------- 7: 225's claim, restated with an attempt cap ----------

CREATE OR REPLACE FUNCTION public.case_review_claim(p_limit integer DEFAULT 20)
RETURNS TABLE (case_id uuid, account_id uuid, attempts integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  -- 262: a run that died five times (its document kills the process) is
  -- failed, not reclaimed. finish caps a run that answers at 3.
  UPDATE public.case_review_queue q
     SET state = 'failed', claimed_at = NULL, last_error = 'stopped after 5 unfinished attempts', updated_at = now()
   WHERE q.state = 'running' AND q.claimed_at < now() - interval '15 minutes' AND q.attempts >= 5;
  RETURN QUERY
  WITH due AS (
    SELECT q.case_id FROM public.case_review_queue q
     WHERE (q.state = 'queued' AND q.due_at <= now())
        OR (q.state = 'running' AND q.claimed_at < now() - interval '15 minutes')
     ORDER BY q.due_at
     LIMIT greatest(1, least(coalesce(p_limit, 20), 100))
     FOR UPDATE SKIP LOCKED)
  UPDATE public.case_review_queue q
     SET state = 'running', claimed_at = now(), attempts = q.attempts + 1, updated_at = now()
    FROM due WHERE q.case_id = due.case_id
  RETURNING q.case_id, q.account_id, q.attempts;
END;
$$;

REVOKE ALL ON FUNCTION public.privacy_media_path(text), public.privacy_objects_unreferenced(uuid, jsonb),
  public.privacy_subject_erase(uuid, uuid, uuid, boolean, text),
  public.privacy_erase_objects_pending(integer), public.privacy_erase_objects_settle(bigint, jsonb),
  public.privacy_retention_problem(jsonb), public.privacy_retention_sweep(uuid, boolean),
  public.contacts_legal_hold_guard(), public.case_review_claim(integer)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.privacy_subject_erase(uuid, uuid, uuid, boolean, text),
  public.privacy_erase_objects_pending(integer), public.privacy_erase_objects_settle(bigint, jsonb),
  public.privacy_retention_sweep(uuid, boolean), public.case_review_claim(integer)
TO service_role;

RESET lock_timeout;
