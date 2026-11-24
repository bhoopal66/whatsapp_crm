-- ============================================================
-- 311_erase_own_calls.sql — erasing one customer takes only their calls.
--
-- A call whose number matched several contacts keeps them in
-- meta.contact_candidates. The erases (093's pbx_erase_contact_calls, and
-- 222/262's privacy_subject_erase, which inlines its match) took a call for
-- its candidates or its number without looking at whom it is linked to: a
-- call staff had linked to B was erased with A, its recording and notes
-- gone for good; and a legal hold on B's recording refused A's erase.
--
--  1. An indirect match (a candidate, the number, its last 8 digits) counts
--     only for a call linked to nobody. The retention sweep's held calls
--     (282) follow the same match. privacy_subject_erase locks the calls it
--     takes, as pbx_erase_contact_calls does.
--  2. Both erases delete the erased calls' references on deals
--     (deal_files, ref_type 'call'), which carry the customer's name or
--     number, on whoever's deal.
--  3. A call is filed on a deal once (deal_files_call_ref_idx). Exact
--     duplicates of a reference go first, the oldest stays; a row with a
--     stored file of its own is never deleted.
--  4. pbx_link_call_contact drops the candidates, and never points the call
--     at a personal WhatsApp chat (190).
--
-- RESTATES 294's pbx_link_call_contact, 093's pbx_erase_contact_calls,
-- 262's privacy_subject_erase and 282's privacy_retention_sweep: apply in
-- order (re-running one of those files afterwards reverts it). Safe to run
-- twice. Before the build: the attach route answers a repeat from 3.
-- supabase/ci/verify-erase-own-calls.sql asserts it.
-- ============================================================

SET lock_timeout = '5s';

-- ---------- 3. one reference per call and deal ----------

DO $$
BEGIN
  LOCK TABLE public.deal_files IN SHARE ROW EXCLUSIVE MODE;
  DELETE FROM public.deal_files d
   USING (SELECT f.id, row_number() OVER (PARTITION BY f.deal_id, f.ref_id
                                          ORDER BY (f.storage_path IS NULL), f.created_at, f.id) AS rn
            FROM public.deal_files f
           WHERE f.ref_type = 'call' AND f.deal_id IS NOT NULL AND f.ref_id IS NOT NULL) x
   WHERE d.id = x.id AND x.rn > 1 AND d.storage_path IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS deal_files_call_ref_idx
    ON public.deal_files (deal_id, ref_type, ref_id) WHERE ref_type = 'call';
END;
$$;

-- ---------- 4. linking a call ----------

CREATE OR REPLACE FUNCTION public.pbx_link_call_contact(p_call_id uuid, p_contact_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_call    calls;
  v_contact contacts;
BEGIN
  IF auth.uid() IS NULL OR current_role_rank() < 2 THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_call FROM calls WHERE id = p_call_id FOR UPDATE;
  IF NOT FOUND OR NOT pbx_can_view_call(v_call) THEN
    RAISE EXCEPTION 'Call not found' USING ERRCODE = 'P0002';
  END IF;
  -- The disposition's rule: seeing a call through its customer is not
  -- enough to move another person's call. Someone else who answered a leg
  -- of it only fills an empty contact (the same one again: a retry).
  IF current_role_rank() < 3
     AND NOT COALESCE(v_call.user_id = auth.uid(), false)
     AND NOT (pbx_answered_call(v_call)
              AND COALESCE(v_call.contact_id = p_contact_id, true)) THEN
    RAISE EXCEPTION 'Only the person on the call or a team leader can re-link it'
      USING ERRCODE = '42501';
  END IF;
  IF v_call.direction = 'internal' THEN
    RAISE EXCEPTION 'An internal call has no customer' USING ERRCODE = '22023';
  END IF;
  IF v_call.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'This call was erased' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_contact FROM contacts WHERE id = p_contact_id;
  IF NOT FOUND OR v_contact.account_id IS DISTINCT FROM v_call.account_id
     OR NOT can_view_contact(v_contact.account_id, v_contact.id, v_contact.user_id) THEN
    RAISE EXCEPTION 'Contact not found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE calls
     SET contact_id = p_contact_id,
         conversation_id = (SELECT cv.id FROM conversations cv
                             WHERE cv.contact_id = p_contact_id AND cv.account_id = v_call.account_id
                               AND cv.personal_owner_id IS NULL
                             ORDER BY cv.created_at DESC, cv.id LIMIT 1),
         deal_id = CASE WHEN EXISTS (SELECT 1 FROM deals d
                                      WHERE d.id = v_call.deal_id AND d.contact_id = p_contact_id)
                        THEN v_call.deal_id END,
         meta = meta - 'contact_candidates'
   WHERE id = p_call_id;
END;
$function$
;
REVOKE ALL ON FUNCTION public.pbx_link_call_contact(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pbx_link_call_contact(uuid, uuid) TO authenticated, service_role;

-- ---------- 1 and 2. the two erases ----------

CREATE OR REPLACE FUNCTION public.pbx_erase_contact_calls(p_contact_id uuid, p_reason text)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_account uuid := current_account_id();
  v_reason  text := NULLIF(btrim(p_reason), '');
  v_phone   text;
  v_calls   uuid[];
  v_paths   text[];
BEGIN
  IF auth.uid() IS NULL OR v_account IS NULL OR current_role_rank() < 5 THEN
    RAISE EXCEPTION 'Only the workspace owner can erase call records' USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'A reason is required' USING ERRCODE = '22023';
  END IF;
  SELECT NULLIF(phone_normalized, '') INTO v_phone
    FROM contacts WHERE id = p_contact_id AND account_id = v_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contact not found' USING ERRCODE = 'P0002';
  END IF;
  WITH locked AS (
    SELECT c.id, c.started_at FROM calls c
     WHERE c.account_id = v_account
       AND (c.contact_id = p_contact_id
            -- Linked to nobody: anything else is a guess against a person's link.
            OR (c.contact_id IS NULL
                AND (c.meta -> 'contact_candidates' ? p_contact_id::text
                     OR v_phone = ANY (pbx_phone_variants(c.remote_number))
                     OR (length(v_phone) >= 8 AND length(c.remote_number) >= 8
                         AND right(c.remote_number, 8) = right(v_phone, 8)
                         AND NOT EXISTS (SELECT 1 FROM contacts o
                                          WHERE o.account_id = v_account
                                            AND o.phone_normalized = ANY (pbx_phone_variants(c.remote_number)))))))
     FOR UPDATE)
  SELECT COALESCE(array_agg(id ORDER BY started_at, id), '{}') INTO v_calls FROM locked;
  IF EXISTS (SELECT 1 FROM call_recordings WHERE call_id = ANY (v_calls) AND legal_hold) THEN
    RAISE EXCEPTION 'A recording of this contact is under legal hold' USING ERRCODE = '55000';
  END IF;
  WITH gone AS (DELETE FROM call_recordings WHERE call_id = ANY (v_calls) RETURNING storage_path)
  SELECT COALESCE(array_agg(storage_path ORDER BY storage_path), '{}') INTO v_paths FROM gone;
  -- Their references on deals, named after the customer (the audio is the
  -- recording's own object: a reference has none).
  DELETE FROM deal_files f
   WHERE f.account_id = v_account AND f.ref_type = 'call' AND f.ref_id = ANY (v_calls::text[]);
  UPDATE calls
     SET notes = NULL, disposition = NULL, notes_updated_by = NULL, notes_updated_at = NULL,
         recording_state = 'erased', erased_at = COALESCE(erased_at, now())
   WHERE id = ANY (v_calls);
  INSERT INTO pbx_audit (account_id, actor_id, action, contact_id, call_ids, reason, detail)
  VALUES (v_account, auth.uid(), 'erase_contact_calls', p_contact_id, v_calls, v_reason,
          jsonb_build_object('recordings', COALESCE(array_length(v_paths, 1), 0)));
  RETURN v_paths;
END;
$function$
;
REVOKE ALL ON FUNCTION public.pbx_erase_contact_calls(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pbx_erase_contact_calls(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.privacy_subject_erase(p_actor uuid, p_account uuid, p_contact uuid, p_dry_run boolean DEFAULT true, p_confirm text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  -- Calls: 093's match (pbx_erase_contact_calls), inlined. Locked, so a
  -- call being linked to someone else at this moment is re-checked.
  WITH locked AS (
    SELECT x.id FROM public.calls x
     WHERE x.account_id = p_account
       AND (x.contact_id = p_contact
            OR (x.contact_id IS NULL
                AND (x.meta -> 'contact_candidates' ? p_contact::text
                     OR v_phone = ANY (public.pbx_phone_variants(x.remote_number))
                     OR (length(v_phone) >= 8 AND length(x.remote_number) >= 8
                         AND right(x.remote_number, 8) = right(v_phone, 8)
                         AND NOT EXISTS (SELECT 1 FROM public.contacts o
                                          WHERE o.account_id = p_account
                                            AND o.phone_normalized = ANY (public.pbx_phone_variants(x.remote_number)))))))
     FOR UPDATE)
  SELECT coalesce(array_agg(l.id), '{}') INTO v_calls FROM locked l;

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
                         FROM public.deal_files f
                        WHERE f.account_id = p_account AND f.storage_path IS NOT NULL
                          AND (f.deal_id = ANY (v_deals)
                               OR (f.ref_type = 'call' AND f.ref_id = ANY (v_calls::text[]))));
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
        ('contact_custom_values'), ('contact_notes'), ('contact_tags'), ('automation_logs'),
        ('automation_pending_executions'), ('flow_runs'), ('journey_files'), ('tasks'), ('callback_requests'),
        ('call_live')) t(tbl) LOOP
      EXECUTE format('DELETE FROM public.%I WHERE contact_id = $1', r.tbl) USING p_contact;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_counts := v_counts || jsonb_build_object(r.tbl, v_n);
    END LOOP;
    -- The safety-check log is append-only (063): a DELETE is refused, so 222
    -- could not erase anyone the checks had ever read. Its own erase rule
    -- takes the person out and keeps the decision for the aggregates.
    PERFORM set_config('ts.erase', 'on', true);
    UPDATE public.ts_decision_log x
       SET contact_id = NULL, conversation_id = NULL, message_id = NULL, state_hash = NULL, answers = NULL,
           answers_purged_at = coalesce(x.answers_purged_at, now())
     WHERE x.account_id = p_account AND x.contact_id = p_contact;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('ts_decision_log', v_n);
    PERFORM set_config('ts.erase', 'off', true);
    UPDATE public.broadcast_recipients x SET template_params = NULL, error_message = NULL WHERE x.contact_id = p_contact;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('broadcast_recipients', v_n);

    -- Deals: the row stays, its customer text goes.
    -- And the erased calls' references on anyone's deal, named after them.
    DELETE FROM public.deal_files f
     WHERE f.account_id = p_account
       AND (f.deal_id = ANY (v_deals) OR (f.ref_type = 'call' AND f.ref_id = ANY (v_calls::text[])));
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
       -- Digits only (114's wa_id check refused 222's 'erased-…', so nobody
       -- in a WhatsApp group could be erased); 000 starts no real number.
       SET wa_id = '000' || lpad((hashtextextended(x.group_id::text || x.wa_id, 262) & 9223372036854775807)::text, 19, '0'),
           contact_id = NULL
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
    -- Grants are revoked, never removed (129's guard refuses a DELETE).
    UPDATE public.memory_acl x SET revoked_at = greatest(now(), x.granted_at)
     WHERE x.account_id = p_account AND x.scope_type = 'contact' AND x.scope_id = p_contact AND x.revoked_at IS NULL;
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
$function$
;
REVOKE ALL ON FUNCTION public.privacy_subject_erase(uuid, uuid, uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.privacy_subject_erase(uuid, uuid, uuid, boolean, text) TO service_role;

-- ---------- 1. the retention sweep's held calls ----------

CREATE OR REPLACE FUNCTION public.privacy_retention_sweep(p_account uuid, p_dry_run boolean DEFAULT NULL::boolean, p_limit integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_lim   integer;
  v_more  boolean := false;
  v_got   jsonb;
  v_obj   jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO s FROM public.privacy_retention_settings x WHERE x.account_id = p_account;
  IF NOT FOUND OR s.policy -> 'tables' = '{}'::jsonb THEN
    RETURN NULL;
  END IF;
  IF public.privacy_retention_problem(s.policy) IS NOT NULL THEN
    RAISE EXCEPTION 'privacy_retention_sweep: the stored policy is invalid' USING ERRCODE = 'check_violation', HINT = 'INVALID';
  END IF;
  v_dry := coalesce(p_dry_run, NOT s.apply);
  -- LIMIT NULL is no limit. A dry run counts everything.
  v_lim := CASE WHEN v_dry OR p_limit IS NULL THEN NULL ELSE greatest(1, least(p_limit, 5000)) END;

  -- Contacts under a legal hold, and their phone digits.
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.privacy_held (contact_id uuid, digits text, phone text) ON COMMIT DROP;
  TRUNCATE pg_temp.privacy_held;
  INSERT INTO pg_temp.privacy_held
  SELECT c.id, public.privacy_digits(coalesce(c.phone_normalized, c.phone)), nullif(c.phone_normalized, '')
    FROM public.privacy_legal_holds h JOIN public.contacts c ON c.id = h.contact_id
   WHERE h.account_id = p_account AND h.released_at IS NULL;

  -- 262: what else belongs to a held customer. Calls: 222's match (093, 311),
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
            OR (x.contact_id IS NULL
                AND (x.meta -> 'contact_candidates' ?| v_ids
                     OR public.pbx_phone_variants(x.remote_number)::text[] && v_phones
                     OR (length(x.remote_number) >= 8
                         AND right(x.remote_number, 8) IN (SELECT right(h.phone, 8) FROM pg_temp.privacy_held h WHERE length(h.phone) >= 8)
                         AND NOT EXISTS (SELECT 1 FROM public.contacts o
                                          WHERE o.account_id = p_account
                                            AND o.phone_normalized = ANY (public.pbx_phone_variants(x.remote_number)))))));
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
      v_n := 0; v_got := '[]'::jsonb;
      -- Each kind: lock the slice (its media as it is now), remove exactly
      -- those rows, keep what their media pointed at.
      IF r.k = 'deal_room_messages' THEN
        SELECT count(*) INTO v_held FROM public.group_messages m
         WHERE m.account_id = p_account AND m.created_at < v_cut AND m.room_id IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'room');
        IF r.action = 'delete' THEN
          WITH pick AS MATERIALIZED (
            SELECT m.id, m.media FROM public.group_messages m WHERE m.account_id = p_account AND m.created_at < v_cut
               AND m.room_id NOT IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'room')
             LIMIT v_lim FOR UPDATE),
          gone AS (DELETE FROM public.group_messages m USING pick WHERE m.id = pick.id RETURNING pick.media)
          SELECT count(*), coalesce(jsonb_agg(o.o) FILTER (WHERE o.o IS NOT NULL), '[]')
            INTO v_n, v_got FROM gone LEFT JOIN LATERAL (
              SELECT public.privacy_media_objects(p_account, gone.media) AS o WHERE gone.media IS NOT NULL) o ON true;
        ELSE
          WITH pick AS MATERIALIZED (
            SELECT m.id, m.media FROM public.group_messages m
             WHERE m.account_id = p_account AND m.created_at < v_cut AND (m.body IS NOT NULL OR m.media IS NOT NULL)
               AND m.room_id NOT IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'room')
             LIMIT v_lim FOR UPDATE),
          gone AS (UPDATE public.group_messages m SET body = NULL, media = NULL, sender_wa_id = NULL
                     FROM pick WHERE m.id = pick.id RETURNING pick.media)
          SELECT count(*), coalesce(jsonb_agg(o.o) FILTER (WHERE o.o IS NOT NULL), '[]')
            INTO v_n, v_got FROM gone LEFT JOIN LATERAL (
              SELECT public.privacy_media_objects(p_account, gone.media) AS o WHERE gone.media IS NOT NULL) o ON true;
        END IF;
      ELSIF r.k = 'whatsapp_group_messages' THEN
        SELECT count(*) INTO v_held FROM public.whatsapp_group_messages m
         WHERE m.account_id = p_account AND m.created_at < v_cut
           AND (m.group_id IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'group')
                OR public.privacy_digits(m.sender_wa_id) IN (SELECT digits FROM pg_temp.privacy_held WHERE digits IS NOT NULL));
        IF r.action = 'delete' THEN
          WITH pick AS MATERIALIZED (
            SELECT m.id, m.media FROM public.whatsapp_group_messages m WHERE m.account_id = p_account AND m.created_at < v_cut
               AND m.group_id NOT IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'group')
               AND coalesce(public.privacy_digits(m.sender_wa_id), '') NOT IN (SELECT digits FROM pg_temp.privacy_held WHERE digits IS NOT NULL)
             LIMIT v_lim FOR UPDATE),
          gone AS (DELETE FROM public.whatsapp_group_messages m USING pick WHERE m.id = pick.id RETURNING pick.media)
          SELECT count(*), coalesce(jsonb_agg(o.o) FILTER (WHERE o.o IS NOT NULL), '[]')
            INTO v_n, v_got FROM gone LEFT JOIN LATERAL (
              SELECT public.privacy_media_objects(p_account, gone.media) AS o WHERE gone.media IS NOT NULL) o ON true;
        ELSE
          WITH pick AS MATERIALIZED (
            SELECT m.id, m.media FROM public.whatsapp_group_messages m
             WHERE m.account_id = p_account AND m.created_at < v_cut
               AND (m.body IS NOT NULL OR m.media IS NOT NULL OR m.sender_name IS NOT NULL)
               AND m.group_id NOT IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'group')
               AND coalesce(public.privacy_digits(m.sender_wa_id), '') NOT IN (SELECT digits FROM pg_temp.privacy_held WHERE digits IS NOT NULL)
             LIMIT v_lim FOR UPDATE),
          gone AS (UPDATE public.whatsapp_group_messages m SET body = NULL, media = NULL, sender_name = NULL
                     FROM pick WHERE m.id = pick.id RETURNING pick.media)
          SELECT count(*), coalesce(jsonb_agg(o.o) FILTER (WHERE o.o IS NOT NULL), '[]')
            INTO v_n, v_got FROM gone LEFT JOIN LATERAL (
              SELECT public.privacy_media_objects(p_account, gone.media) AS o WHERE gone.media IS NOT NULL) o ON true;
        END IF;
      ELSIF r.k = 'hr_outbox_bodies' THEN
        SELECT count(*) INTO v_held FROM public.hr_automsg_outbox o
         WHERE o.account_id = p_account AND o.created_at < v_cut AND o.status IN ('sent', 'failed', 'cancelled')
           AND o.contact_id IN (SELECT contact_id FROM pg_temp.privacy_held);
        WITH pick AS MATERIALIZED (
          SELECT o.id FROM public.hr_automsg_outbox o
           WHERE o.account_id = p_account AND o.created_at < v_cut AND o.status IN ('sent', 'failed', 'cancelled')
             AND o.body_rendered <> '' AND o.contact_id NOT IN (SELECT contact_id FROM pg_temp.privacy_held)
           LIMIT v_lim FOR UPDATE)
        UPDATE public.hr_automsg_outbox o SET body_rendered = '', params = '[]'::jsonb FROM pick WHERE o.id = pick.id;
        GET DIAGNOSTICS v_n = ROW_COUNT;
      ELSIF r.k = 'hr_agent_drafts' THEN
        SELECT count(*) INTO v_held FROM public.hr_agent_drafts d JOIN public.conversations v ON v.id = d.conversation_id
         WHERE d.account_id = p_account AND d.created_at < v_cut AND d.status <> 'pending'
           AND v.contact_id IN (SELECT contact_id FROM pg_temp.privacy_held);
        WITH pick AS MATERIALIZED (
          SELECT d.id FROM public.hr_agent_drafts d JOIN public.conversations v ON v.id = d.conversation_id
           WHERE d.account_id = p_account AND d.created_at < v_cut AND d.status <> 'pending'
             AND v.contact_id NOT IN (SELECT contact_id FROM pg_temp.privacy_held)
           LIMIT v_lim FOR UPDATE OF d)
        DELETE FROM public.hr_agent_drafts d USING pick WHERE d.id = pick.id;
        GET DIAGNOSTICS v_n = ROW_COUNT;
      ELSIF r.k = 'call_records' THEN
        SELECT count(*) INTO v_held FROM public.calls c
         WHERE c.account_id = p_account AND c.started_at < v_cut AND c.erased_at IS NULL
           AND c.id IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'call');
        WITH pick AS MATERIALIZED (
          SELECT c.id FROM public.calls c
           WHERE c.account_id = p_account AND c.started_at < v_cut AND c.erased_at IS NULL
             AND c.id NOT IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'call')
             AND NOT EXISTS (SELECT 1 FROM public.call_recordings rr WHERE rr.call_id = c.id AND rr.erased_at IS NULL)
           LIMIT v_lim FOR UPDATE)
        UPDATE public.calls c SET notes = NULL, disposition = NULL, notes_updated_by = NULL, notes_updated_at = NULL,
               recording_state = 'erased', erased_at = now()
          FROM pick WHERE c.id = pick.id;
        GET DIAGNOSTICS v_n = ROW_COUNT;
      END IF;
      v_more := v_more OR coalesce(v_n >= v_lim, false);
      v_obj := v_obj || coalesce((SELECT jsonb_agg(o) FROM jsonb_array_elements(v_got) AS g(l),
                                         LATERAL jsonb_array_elements(g.l) AS e(o)), '[]'::jsonb);
      v_out := v_out || jsonb_build_object(r.k, jsonb_build_object('action', r.action, 'days', r.days,
                                                                   'rows', v_n, 'held_skipped', v_held));
    END LOOP;
    -- Every row of this slice is gone or blank now: what still points at a
    -- file is what stays.
    v_obj := public.privacy_objects_unreferenced(p_account, v_obj);
    IF v_dry THEN
      RAISE EXCEPTION USING ERRCODE = 'ZP223', MESSAGE = 'privacy_retention_sweep dry run';
    END IF;
  EXCEPTION WHEN SQLSTATE 'ZP223' THEN
    NULL;
  END;

  INSERT INTO public.privacy_requests (account_id, kind, actor_label, detail)
  VALUES (p_account, CASE WHEN v_dry THEN 'retention_dry_run' ELSE 'retention' END, 'system:retention',
          jsonb_build_object('tables', v_out, 'objects', jsonb_array_length(v_obj), 'more', v_more)
          || CASE WHEN v_dry OR jsonb_array_length(v_obj) = 0 THEN '{}'::jsonb
                  ELSE jsonb_build_object('objects_list', jsonb_path_query_array(v_obj, '$[0 to 999]')) END)
  RETURNING id INTO v_id;
  IF NOT v_dry THEN
    INSERT INTO public.privacy_requests (account_id, kind, actor_label, detail)
    SELECT p_account, 'retention', 'system:retention', jsonb_build_object('part_of', v_id, 'objects_list', jsonb_agg(e.o ORDER BY e.n))
      FROM jsonb_array_elements(v_obj) WITH ORDINALITY AS e(o, n)
     WHERE e.n > 1000 GROUP BY (e.n - 1) / 1000 ORDER BY (e.n - 1) / 1000;
  END IF;
  RETURN jsonb_build_object('mode', CASE WHEN v_dry THEN 'dry_run' ELSE 'apply' END, 'request_id', v_id, 'tables', v_out,
                            'objects', jsonb_array_length(v_obj), 'more', v_more);
END;
$function$
;
REVOKE ALL ON FUNCTION public.privacy_retention_sweep(uuid, boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.privacy_retention_sweep(uuid, boolean, integer) TO service_role;

RESET lock_timeout;

NOTIFY pgrst, 'reload schema';
