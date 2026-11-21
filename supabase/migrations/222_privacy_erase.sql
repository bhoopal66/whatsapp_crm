-- ============================================================
-- 222_privacy_erase.sql — PDPL erasure and the customer legal hold.
-- Port of package 033i fitted to this schema.
--
--  * privacy_legal_hold_set(actor, account, contact, place, reason) —
--    owners / admins; a reason is required to place one. One active hold
--    per contact. Logged in privacy_requests (221).
--  * privacy_subject_erase(actor, account, contact, dry_run, confirm) —
--    owners / admins; NULL for a contact not the account's. One
--    transaction. A dry run (the default) runs every step inside a block
--    that is then rolled back, so its counts are exact and nothing
--    changes; executing needs confirm = 'ERASE <contact id>'
--    (CONFIRM_REQUIRED). A customer hold, or a call recording under its
--    own hold (093), blocks it: { blocked: 'legal_hold' }, nothing
--    changed.
--  * What it does follows src/lib/privacy/data-map.ts (data-map.test.ts
--    checks every delete / anonymise table is named here). Bank cases and
--    everything filed to them, the case's WhatsApp group, consent and
--    opt-out records and audit trails are KEPT (KYC/AML, the owner's
--    decision); the app lists them as retained with the map's reason.
--    The contact row stays, anonymised ("Erased customer"), so those
--    kept records keep their reference and its opt-out still holds.
--  * Calls are erased with 093's rule, inlined because
--    pbx_erase_contact_calls needs a signed-in owner (auth.uid()); the
--    match below mirrors it: change both.
--  * Stored files (call recordings, deal files, unfiled customer
--    documents, chat media) are deleted by the app AFTER the commit:
--    the result lists them in `objects`, and
--    privacy_erase_objects_done records what is left if any failed.
--
-- SECURITY DEFINER, service role only; tables force RLS with no grants.
-- Apply after 221 as a superuser or BYPASSRLS role. Re-runnable.
-- verify-privacy.sql; docs/privacy.md.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '222 must be applied by a superuser or BYPASSRLS role (erase writes RLS-forced tables)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.privacy_legal_holds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL,
  contact_id  uuid NOT NULL,
  reason      text NOT NULL,
  placed_by   uuid NOT NULL,
  placed_at   timestamptz NOT NULL DEFAULT now(),
  released_by uuid NULL,
  released_at timestamptz NULL,
  CONSTRAINT privacy_legal_holds_contact_fkey FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts (id, account_id),
  CONSTRAINT privacy_legal_holds_reason_check
    CHECK (reason !~ '^[[:space:]]*$' AND char_length(reason) <= 500),
  CONSTRAINT privacy_legal_holds_release_check CHECK ((released_at IS NULL) = (released_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS privacy_legal_holds_one_active
  ON public.privacy_legal_holds (account_id, contact_id) WHERE released_at IS NULL;
COMMENT ON TABLE public.privacy_legal_holds IS
  'A customer legal hold: while active, erase and the retention sweep leave the customer alone. Migration 222.';
ALTER TABLE public.privacy_legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.privacy_legal_holds FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.privacy_legal_holds FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.privacy_require_admin(p_fn text, p_actor uuid, p_account uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor), '') NOT IN ('admin', 'super_admin') THEN
    RAISE EXCEPTION '%: owners and admins only', p_fn USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.privacy_on_hold(p_account uuid, p_contact uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.privacy_legal_holds h
                  WHERE h.account_id = p_account AND h.contact_id = p_contact AND h.released_at IS NULL)
$$;

-- ---------- legal hold ----------

CREATE OR REPLACE FUNCTION public.privacy_legal_hold_set(p_actor uuid, p_account uuid, p_contact uuid,
  p_place boolean, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reason text := CASE WHEN p_reason ~ '^[[:space:]]*$' THEN NULL ELSE btrim(p_reason) END;
  v_id     uuid;
BEGIN
  PERFORM public.privacy_require_admin('privacy_legal_hold_set', p_actor, p_account);
  PERFORM 1 FROM public.contacts c WHERE c.id = p_contact AND c.account_id = p_account FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'privacy_legal_hold_set: contact not found' USING ERRCODE = 'no_data_found', HINT = 'NOT_FOUND';
  END IF;
  IF p_place THEN
    IF v_reason IS NULL OR char_length(v_reason) > 500 THEN
      RAISE EXCEPTION 'privacy_legal_hold_set: a reason (up to 500 characters) is required'
        USING ERRCODE = 'check_violation', HINT = 'REASON_REQUIRED';
    END IF;
    SELECT h.id INTO v_id FROM public.privacy_legal_holds h
     WHERE h.account_id = p_account AND h.contact_id = p_contact AND h.released_at IS NULL;
    IF v_id IS NULL THEN
      INSERT INTO public.privacy_legal_holds (account_id, contact_id, reason, placed_by)
      VALUES (p_account, p_contact, v_reason, p_actor) RETURNING id INTO v_id;
      INSERT INTO public.privacy_requests (account_id, kind, contact_hash, actor_id, detail)
      VALUES (p_account, 'legal_hold_placed', public.privacy_contact_hash(p_account, p_contact), p_actor,
              jsonb_build_object('hold_id', v_id));
    END IF;
  ELSE
    UPDATE public.privacy_legal_holds h SET released_at = now(), released_by = p_actor
     WHERE h.account_id = p_account AND h.contact_id = p_contact AND h.released_at IS NULL
    RETURNING h.id INTO v_id;
    IF v_id IS NOT NULL THEN
      INSERT INTO public.privacy_requests (account_id, kind, contact_hash, actor_id, detail)
      VALUES (p_account, 'legal_hold_released', public.privacy_contact_hash(p_account, p_contact), p_actor,
              jsonb_build_object('hold_id', v_id));
    END IF;
  END IF;
  RETURN jsonb_build_object('on_hold', public.privacy_on_hold(p_account, p_contact),
    'hold', (SELECT jsonb_build_object('reason', h.reason, 'placed_at', h.placed_at)
               FROM public.privacy_legal_holds h
              WHERE h.account_id = p_account AND h.contact_id = p_contact AND h.released_at IS NULL));
END;
$$;

-- The customer's current hold, for the screen.
CREATE OR REPLACE FUNCTION public.privacy_legal_hold_get(p_actor uuid, p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.privacy_require_admin('privacy_legal_hold_get', p_actor, p_account);
  IF NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = p_contact AND c.account_id = p_account) THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object('on_hold', public.privacy_on_hold(p_account, p_contact),
    'hold', (SELECT jsonb_build_object('reason', h.reason, 'placed_at', h.placed_at)
               FROM public.privacy_legal_holds h
              WHERE h.account_id = p_account AND h.contact_id = p_contact AND h.released_at IS NULL));
END;
$$;

-- ---------- erase ----------

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
    -- Files to delete after the commit (collected before their rows go).
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
                        WHERE m.conversation_id = ANY (v_convs) AND m.media_url IS NOT NULL
                          AND NOT EXISTS (SELECT 1 FROM public.customer_documents d JOIN public.case_document_files f
                                                    ON f.customer_document_id = d.id
                                           WHERE d.media_url = m.media_url));

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
                                                   THEN 'none' ELSE 'pending' END))
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('mode', CASE WHEN coalesce(p_dry_run, true) THEN 'dry_run' ELSE 'erase' END,
    'request_id', v_id, 'counts', v_counts,
    'objects', CASE WHEN coalesce(p_dry_run, true) THEN '[]'::jsonb ELSE v_obj END,
    'objects_count', jsonb_array_length(v_obj));
END;
$$;

-- After the app deleted the erased files: what (if anything) is left.
CREATE OR REPLACE FUNCTION public.privacy_erase_objects_done(p_actor uuid, p_account uuid, p_request bigint,
  p_remaining jsonb)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.privacy_require_admin('privacy_erase_objects_done', p_actor, p_account);
  IF NOT EXISTS (SELECT 1 FROM public.privacy_requests r
                  WHERE r.id = p_request AND r.account_id = p_account AND r.kind = 'erase') THEN
    RAISE EXCEPTION 'privacy_erase_objects_done: request not found' USING ERRCODE = 'no_data_found', HINT = 'NOT_FOUND';
  END IF;
  IF p_remaining IS NULL OR jsonb_typeof(p_remaining) <> 'array' THEN
    RAISE EXCEPTION 'privacy_erase_objects_done: remaining must be an array' USING ERRCODE = 'check_violation', HINT = 'INVALID';
  END IF;
  INSERT INTO public.privacy_requests (account_id, kind, actor_id, detail)
  VALUES (p_account, 'objects_done', p_actor, jsonb_build_object('request_id', p_request,
          'objects_state', CASE WHEN jsonb_array_length(p_remaining) = 0 THEN 'done' ELSE 'pending' END,
          'remaining', p_remaining));
END;
$$;

REVOKE ALL ON FUNCTION public.privacy_require_admin(text, uuid, uuid), public.privacy_on_hold(uuid, uuid),
  public.privacy_legal_hold_set(uuid, uuid, uuid, boolean, text), public.privacy_legal_hold_get(uuid, uuid, uuid),
  public.privacy_subject_erase(uuid, uuid, uuid, boolean, text),
  public.privacy_erase_objects_done(uuid, uuid, bigint, jsonb)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.privacy_legal_hold_set(uuid, uuid, uuid, boolean, text),
  public.privacy_legal_hold_get(uuid, uuid, uuid),
  public.privacy_subject_erase(uuid, uuid, uuid, boolean, text),
  public.privacy_erase_objects_done(uuid, uuid, bigint, jsonb)
TO service_role;
