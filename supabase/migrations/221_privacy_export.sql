-- ============================================================
-- 221_privacy_export.sql — PDPL subject access / portability: one
-- customer's data as one JSON document. Port of package 033h fitted to
-- this schema. Read only: nothing here deletes or changes data.
--
--  * privacy_subject_export(actor, account, contact) — owner / admin
--    only (NOT_ALLOWED otherwise); NULL when the contact is not one of
--    the account's. Every section is confined to the account. Follows
--    src/lib/privacy/data-map.ts: the tables marked `exported` there are
--    the sections here (data-map.test.ts checks this file names each).
--  * Staff identifiers, storage paths, media URLs, hashes and the
--    vault's ciphertext are stripped (privacy_strip): the export is the
--    customer's data, not who on the staff touched it or where bytes
--    live. Vault items are listed by token and kind only (no bulk
--    decrypt path exists, by design). File bytes are not included.
--  * privacy_requests: one append-only row per export (and, from 222,
--    per erase), with contact_hash = sha256(account || contact), never
--    the raw id, the actor, and section counts.
--
-- Tables force RLS with no policy and no grants; the function is
-- SECURITY DEFINER, service role only. Apply as a superuser or BYPASSRLS
-- role. Re-runnable. verify-privacy.sql; docs/privacy.md.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '221 must be applied by a superuser or BYPASSRLS role (the export reads RLS-forced tables)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.privacy_requests (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   uuid NOT NULL REFERENCES public.accounts(id),
  kind         text NOT NULL,
  contact_hash text NULL,
  actor_id     uuid NULL,
  actor_label  text NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT privacy_requests_kind_check CHECK (kind IN ('export', 'erase_dry_run', 'erase', 'legal_hold_placed',
    'legal_hold_released', 'retention_dry_run', 'retention', 'objects_done')),
  CONSTRAINT privacy_requests_hash_check CHECK (contact_hash IS NULL OR contact_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT privacy_requests_actor_check CHECK (actor_id IS NOT NULL OR actor_label ~ '^system:[a-z_]+$')
);
CREATE INDEX IF NOT EXISTS privacy_requests_account_idx ON public.privacy_requests (account_id, at DESC);
COMMENT ON TABLE public.privacy_requests IS
  'Append-only log of PDPL requests (export, erase, legal hold, retention): who, when, counts; never the contact id or any content. Migration 221.';

DROP TRIGGER IF EXISTS privacy_requests_no_update ON public.privacy_requests;
CREATE TRIGGER privacy_requests_no_update BEFORE UPDATE ON public.privacy_requests
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS privacy_requests_no_delete ON public.privacy_requests;
CREATE TRIGGER privacy_requests_no_delete BEFORE DELETE ON public.privacy_requests
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS privacy_requests_no_truncate ON public.privacy_requests;
CREATE TRIGGER privacy_requests_no_truncate BEFORE TRUNCATE ON public.privacy_requests
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

ALTER TABLE public.privacy_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.privacy_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.privacy_requests FROM PUBLIC, anon, authenticated, service_role;

-- ---------- helpers ----------

CREATE OR REPLACE FUNCTION public.privacy_contact_hash(p_account uuid, p_contact uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT encode(extensions.digest(p_account::text || ':' || p_contact::text, 'sha256'), 'hex') $$;

-- The digits of a phone or WhatsApp id ('9715…@c.us' -> '9715…').
CREATE OR REPLACE FUNCTION public.privacy_digits(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT nullif(regexp_replace(split_part(coalesce(p, ''), '@', 1), '[^0-9]', '', 'g'), '') $$;

-- A row as JSON without staff identifiers, storage locations or hashes.
CREATE OR REPLACE FUNCTION public.privacy_strip(p jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
    FROM jsonb_each(p) AS e(k, v)
   WHERE k NOT IN ('account_id', 'user_id', 'created_by', 'updated_by', 'assigned_to', 'agent_id',
                   'coordinator_id', 'sender_id', 'sender_user_id', 'actor_id', 'author_id', 'registered_by',
                   'uploaded_by', 'decided_by', 'recorded_by', 'noted_by', 'owner_user_id', 'classified_by',
                   'notes_updated_by', 'personal_owner_id', 'assigned_agent_id', 'storage_path', 'storage_bucket',
                   'media_url', 'nas_name', 'ciphertext', 'blind_index', 'avatar_url', 'header_media_url',
                   'channel_id', 'send_channel_id', 'folder_id', 'claimed_at', 'agent_username', 'agent_name',
                   'agent_email', 'agent_team')
     AND k !~ '(_hash|_sha256|sha256)$'
     -- any other staff identifier: *_by, and user / actor / author /
     -- agent / coordinator / reviewer ids
     AND k !~ '_by$'
     AND k !~ '(user|actor|author|agent|coordinator|reviewer)_id$'
$$;

-- ---------- the export ----------

CREATE OR REPLACE FUNCTION public.privacy_subject_export(p_actor uuid, p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c        public.contacts%ROWTYPE;
  v_digits text;
  v_convs  uuid[];
  v_cases  uuid[];
  v_groups uuid[];
  v_parts  uuid[];
  v_calls  uuid[];
  v_deals  uuid[];
  v_out    jsonb;
  v_counts jsonb;
  v_ext    jsonb;
  v_reg    record;  -- not r: the body aliases tables as r
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor), '') NOT IN ('admin', 'super_admin') THEN
    RAISE EXCEPTION 'privacy_subject_export: owners and admins only'
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  SELECT * INTO c FROM public.contacts x WHERE x.id = p_contact AND x.account_id = p_account;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_digits := public.privacy_digits(coalesce(c.phone_normalized, c.phone));
  SELECT coalesce(array_agg(x.id), '{}') INTO v_convs FROM public.conversations x
   WHERE x.contact_id = p_contact AND x.account_id = p_account;
  SELECT coalesce(array_agg(x.id), '{}') INTO v_cases FROM public.cases x
   WHERE x.contact_id = p_contact AND x.account_id = p_account;
  SELECT coalesce(array_agg(x.id), '{}') INTO v_groups FROM public.submission_groups x
   WHERE x.contact_id = p_contact AND x.account_id = p_account;
  SELECT coalesce(array_agg(x.id), '{}') INTO v_parts FROM public.deal_room_participants x
   WHERE x.contact_id = p_contact AND x.account_id = p_account;
  SELECT coalesce(array_agg(x.id), '{}') INTO v_calls FROM public.calls x
   WHERE x.contact_id = p_contact AND x.account_id = p_account;
  SELECT coalesce(array_agg(x.id), '{}') INTO v_deals FROM public.deals x
   WHERE x.contact_id = p_contact AND x.account_id = p_account;

  v_out := jsonb_build_object(
    'contact', public.privacy_strip(to_jsonb(c)),
    'custom_values', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x))), '[]') FROM public.contact_custom_values x WHERE x.contact_id = p_contact),
    'notes', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x)) ORDER BY x.created_at), '[]') FROM public.contact_notes x WHERE x.contact_id = p_contact),
    'tags', (SELECT coalesce(jsonb_agg(t.name ORDER BY t.name), '[]') FROM public.contact_tags x JOIN public.tags t ON t.id = x.tag_id WHERE x.contact_id = p_contact),
    'consent_events', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x)) ORDER BY x.at), '[]') FROM public.contact_consent_events x WHERE x.contact_id = p_contact AND x.account_id = p_account),
    'conversations', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(v)) || jsonb_build_object(
        'messages', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(m)) ORDER BY m.created_at), '[]') FROM public.messages m WHERE m.conversation_id = v.id),
        'translations', (SELECT coalesce(jsonb_agg(jsonb_build_object('message_id', t.message_id, 'translated_text', t.translated_text)), '[]') FROM public.message_translations t WHERE t.conversation_id = v.id),
        'events', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(e)) ORDER BY e.created_at), '[]') FROM public.conversation_events e WHERE e.conversation_id = v.id),
        'hr', (SELECT public.privacy_strip(to_jsonb(h)) FROM public.hr_conversations h WHERE h.conversation_id = v.id),
        'hr_stage_history', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(h))), '[]') FROM public.hr_stage_history h WHERE h.conversation_id = v.id),
        'hr_agent_drafts', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(h))), '[]') FROM public.hr_agent_drafts h WHERE h.conversation_id = v.id)
      ) ORDER BY v.created_at), '[]') FROM public.conversations v WHERE v.id = ANY (v_convs)),
    'questions_the_bot_could_not_answer', (SELECT coalesce(jsonb_agg(jsonb_build_object('question', g.question, 'created_at', g.created_at)), '[]') FROM public.ai_knowledge_gaps g WHERE g.conversation_id = ANY (v_convs)),
    'broadcasts_received', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x))), '[]') FROM public.broadcast_recipients x WHERE x.contact_id = p_contact),
    'flow_runs', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x))), '[]') FROM public.flow_runs x WHERE x.contact_id = p_contact),
    'journeys', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x))), '[]') FROM public.journey_files x WHERE x.contact_id = p_contact AND x.account_id = p_account),
    'journey_optins', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x))), '[]') FROM public.journey_optin_claims x WHERE x.contact_id = p_contact AND x.account_id = p_account),
    'tasks', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x))), '[]') FROM public.tasks x WHERE x.contact_id = p_contact AND x.account_id = p_account),
    'callback_requests', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x))), '[]') FROM public.callback_requests x WHERE x.contact_id = p_contact AND x.account_id = p_account),
    'deals', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x)) || jsonb_build_object(
        'files', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(f))), '[]') FROM public.deal_files f WHERE f.deal_id = x.id)
      )), '[]') FROM public.deals x WHERE x.id = ANY (v_deals)),
    'compass', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x))), '[]') FROM public.compass_contacts x WHERE x.contact_id = p_contact AND x.account_id = p_account),
    'compass_notifications', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x))), '[]') FROM public.compass_notifications x WHERE x.contact_id = p_contact AND x.account_id = p_account),
    'calls', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x)) || jsonb_build_object(
        'recording', (SELECT jsonb_build_object('format', r.format, 'bytes', r.bytes, 'fetched_at', r.fetched_at, 'erased_at', r.erased_at) FROM public.call_recordings r WHERE r.call_id = x.id)
      ) ORDER BY x.started_at), '[]') FROM public.calls x WHERE x.id = ANY (v_calls)),
    'document_folder', (SELECT public.privacy_strip(to_jsonb(x)) FROM public.customer_doc_folders x WHERE x.contact_id = p_contact AND x.account_id = p_account),
    'documents', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x)) ORDER BY x.received_at), '[]') FROM public.customer_documents x WHERE x.contact_id = p_contact AND x.account_id = p_account),
    'cases', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(k)) || jsonb_build_object(
        'company', (SELECT jsonb_build_object('legal_name', d.legal_name, 'trade_licence_no', d.trade_licence_no) FROM public.desk_customers d WHERE d.id = k.desk_customer_id),
        'application_number', (SELECT a.app_number FROM public.desk_applications a WHERE a.id = k.desk_application_id),
        'stage_history', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(h)) ORDER BY h.changed_at), '[]') FROM public.case_stage_history h WHERE h.case_id = k.id),
        'notes', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(h))), '[]') FROM public.case_notes h WHERE h.case_id = k.id),
        'documents', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(h))), '[]') FROM public.case_documents h WHERE h.case_id = k.id),
        'files', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(h))), '[]') FROM public.case_document_files h WHERE h.case_id = k.id),
        'outcome_reasons', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(h))), '[]') FROM public.case_outcome_reasons h WHERE h.case_id = k.id),
        'bank_contacts', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(h))), '[]') FROM public.case_bank_contacts h WHERE h.case_id = k.id),
        'tasks', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(h))), '[]') FROM public.case_tasks h WHERE h.case_id = k.id)
      ) ORDER BY k.opened_at), '[]') FROM public.cases k WHERE k.id = ANY (v_cases)),
    'desk_uploads', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x)) ORDER BY x.received_at), '[]') FROM public.intake_items x WHERE x.contact_id = p_contact AND x.account_id = p_account),
    'submission_groups', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(g)) || jsonb_build_object(
        'messages', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(m)) ORDER BY m.created_at), '[]') FROM public.submission_group_messages m WHERE m.group_id = g.id)
      )), '[]') FROM public.submission_groups g WHERE g.id = ANY (v_groups)),
    'deal_rooms', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x))), '[]') FROM public.deal_rooms x WHERE x.contact_id = p_contact AND x.account_id = p_account),
    'deal_room_participation', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x))), '[]') FROM public.deal_room_participants x WHERE x.id = ANY (v_parts)),
    'deal_room_consents', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x))), '[]') FROM public.participant_consents x WHERE x.contact_id = p_contact AND x.account_id = p_account),
    'deal_room_messages', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x)) ORDER BY x.created_at), '[]') FROM public.group_messages x WHERE x.sender_participant_id = ANY (v_parts) AND x.account_id = p_account),
    'whatsapp_groups', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x))), '[]') FROM public.whatsapp_group_participants x WHERE x.contact_id = p_contact AND x.account_id = p_account),
    'whatsapp_group_messages', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x)) ORDER BY x.created_at), '[]') FROM public.whatsapp_group_messages x
       WHERE v_digits IS NOT NULL AND x.account_id = p_account AND public.privacy_digits(x.sender_wa_id) = v_digits),
    'hr_automated_messages', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x))), '[]') FROM public.hr_automsg_outbox x WHERE x.contact_id = p_contact AND x.account_id = p_account),
    'hr_consent', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x))), '[]') FROM public.hr_automsg_consent x WHERE x.contact_id = p_contact AND x.account_id = p_account),
    'memory', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x))), '[]') FROM public.memory_items x WHERE x.account_id = p_account AND x.scope_type = 'contact' AND x.scope_id = p_contact),
    'brain', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x))), '[]') FROM public.brain_items x WHERE x.account_id = p_account AND x.contact_id = p_contact),
    'brain_page', (SELECT public.privacy_strip(to_jsonb(x)) FROM public.brain_pages x WHERE x.account_id = p_account AND x.kind = 'contact' AND x.key = p_contact::text),
    'vault', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', x.kind, 'created_at', x.created_at, 'encrypted', true)), '[]') FROM public.vault_items x WHERE x.account_id = p_account AND x.subject_type = 'contact' AND x.subject_id = p_contact),
    'sales_app', (SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(x))), '[]') FROM public.taamul_sales_contacts x WHERE v_digits IS NOT NULL AND x.account_id = p_account AND public.privacy_digits(x.phone) = v_digits)
  );

  -- Tables of later migrations (229 onward) register their own export in
  -- privacy_extensions, so this body is never restated: re-running 221
  -- after them keeps them. Absent before 229.
  IF to_regclass('public.privacy_extensions') IS NOT NULL THEN
    FOR v_reg IN SELECT e.name, e.export_fn FROM public.privacy_extensions e ORDER BY e.name LOOP
      EXECUTE format('SELECT public.%I($1, $2)', v_reg.export_fn) INTO v_ext USING p_account, p_contact;
      v_out := v_out || jsonb_build_object(v_reg.name, coalesce(v_ext, 'null'::jsonb));
    END LOOP;
  END IF;

  SELECT jsonb_object_agg(k, CASE jsonb_typeof(v) WHEN 'array' THEN jsonb_array_length(v) WHEN 'null' THEN 0 ELSE 1 END)
    INTO v_counts FROM jsonb_each(v_out) AS e(k, v);
  INSERT INTO public.privacy_requests (account_id, kind, contact_hash, actor_id, detail)
  VALUES (p_account, 'export', public.privacy_contact_hash(p_account, p_contact), p_actor, jsonb_build_object('counts', v_counts));
  RETURN jsonb_build_object('schema_version', 1, 'generated_at', now(), 'contact_id', p_contact, 'data', v_out);
END;
$$;

REVOKE ALL ON FUNCTION public.privacy_contact_hash(uuid, uuid), public.privacy_digits(text),
  public.privacy_strip(jsonb), public.privacy_subject_export(uuid, uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.privacy_subject_export(uuid, uuid, uuid) TO service_role;
