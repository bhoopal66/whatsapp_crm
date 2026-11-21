-- ============================================================
-- 230_desk_whatsapp_routing.sql — WhatsApp documents to desk cases, and
-- the unassigned tray (design 035 D6/D8 and section 4, slice C).
--
-- OFF BY DEFAULT: nothing routes until an owner or admin switches
-- desk_settings.routing_enabled on.
--
--  * A document a customer sends 1:1 (178's customer_documents, source
--    'chat') is offered to desk_route_customer_document after it is
--    recorded. Group documents keep 181/183's path; personal numbers are
--    never filed (178).
--  * A STAFF phone (142's coordinator_phones of exactly one live staff
--    member) answers 'staff': the app stores the bytes and submits a desk
--    upload in that person's name from the caption (220's intake,
--    channel 'whatsapp', through desk_whatsapp_intake).
--  * Anyone else: the companies the sender acts for (229) and their open
--    desk cases. Never by phone alone:
--      E1 the message quotes one of OUR messages naming one open case
--         number                                            (may file)
--      E2 the caption carries one open case's number or caption code
--         (the check character verified, 220)               (may file)
--      E4 exactly one open case, and the phone acts for ONE company
--         (may file)
--      E1 and E2 disagreeing, or several codes, or several companies or
--      several open cases without E1/E2 -> the tray, every open case of
--      those companies listed as a candidate with its reasons (quoted,
--      code, prompt = 183's open intake prompt, sender = the case's own
--      contact), NONE pre-selected.
--    A chosen case files the document only when the sender IS the case's
--    contact (181's rule: a case file is its customer's document); a
--    document from another person (a PRO) goes to the tray, and a person
--    files it through the desk intake, which copies it in their name.
--    The automatic file is 181's system intake (registered_by NULL).
--  * A sender linked to no company: on a number listed in
--    desk_settings.desk_channel_ids it goes to the tray
--    ('unknown_sender'); elsewhere it is not the desk's (most chats are
--    sales chats).
--  * Tray: one row per document. Sorted by team leaders and up (every
--    item) and the holders of a candidate's bank (133/161); filing checks
--    the bank like 220's queue. A case whose company the sender is not
--    linked to needs the company's legal name typed (CONFIRM_COMPANY).
--    Dismissing needs a reason. An item open longer than escalate_minutes
--    (default 120) is escalated once: the app raises a follow-up task for
--    the duty owner (else the workspace owner) through 085's system
--    writer.
--
-- Refusals (HINT): INVALID, NOT_ALLOWED, BANK_SCOPE, CASE_NOT_FOUND,
-- CASE_CLOSED, TRAY_NOT_FOUND, TRAY_NOT_OPEN, CONFIRM_COMPANY,
-- REASON_REQUIRED, ITEM_NOT_FOUND.
--
-- PRIVILEGES: SECURITY DEFINER, search_path '', service_role only; the
-- tables force RLS with no policy and no grants. Apply as a superuser or
-- BYPASSRLS role after 229. Re-runnable. Asserted by
-- supabase/ci/verify-desk-whatsapp-routing.sql. docs/case-desk.md is the
-- contract.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '230 must be applied by a superuser or BYPASSRLS role (the desk functions read RLS-forced tables)';
  END IF;
  IF to_regclass('public.desk_customer_contacts') IS NULL OR to_regclass('public.privacy_extensions') IS NULL THEN
    RAISE EXCEPTION '230: apply 229_desk_customer_contacts.sql first';
  END IF;
END $$;

-- ---------- 1. Tables ----------

CREATE TABLE IF NOT EXISTS public.desk_settings (
  account_id        uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  routing_enabled   boolean NOT NULL DEFAULT false,
  desk_channel_ids  uuid[] NOT NULL DEFAULT '{}',
  duty_user_id      uuid NULL,
  escalate_minutes  integer NOT NULL DEFAULT 120,
  updated_by        uuid NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT desk_settings_escalate_check CHECK (escalate_minutes BETWEEN 15 AND 1440),
  CONSTRAINT desk_settings_channels_check CHECK (cardinality(desk_channel_ids) <= 20)
);
ALTER TABLE public.desk_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.desk_settings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.desk_settings FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.desk_settings IS
  'Desk WhatsApp routing per workspace: off by default; desk numbers (unknown senders there go to the tray); '
  'the duty owner; minutes before a tray item escalates. Migration 230.';

CREATE TABLE IF NOT EXISTS public.desk_tray (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  customer_document_id  uuid NOT NULL REFERENCES public.customer_documents(id) ON DELETE CASCADE,
  contact_id            uuid NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  conversation_id       uuid NULL REFERENCES public.conversations(id) ON DELETE SET NULL,
  channel_id            uuid NULL,
  reason                text NOT NULL,
  candidates            jsonb NOT NULL DEFAULT '[]'::jsonb,
  state                 text NOT NULL DEFAULT 'open',
  duty_user_id          uuid NULL,
  received_at           timestamptz NOT NULL,
  escalated_at          timestamptz NULL,
  resolved_by           uuid NULL,
  resolved_at           timestamptz NULL,
  resolved_case_id      uuid NULL,
  resolved_item_id      uuid NULL REFERENCES public.intake_items(id),
  dismiss_reason        text NULL,
  CONSTRAINT desk_tray_one_per_document UNIQUE (customer_document_id),
  CONSTRAINT desk_tray_reason_check CHECK (reason IN ('unknown_sender', 'no_open_case', 'many_companies',
    'many_cases', 'evidence_conflict', 'other_person', 'file_refused')),
  CONSTRAINT desk_tray_state_check CHECK (state IN ('open', 'filed', 'dismissed')),
  CONSTRAINT desk_tray_candidates_check CHECK (jsonb_typeof(candidates) = 'array'),
  CONSTRAINT desk_tray_state_cols CHECK (
    (state = 'open' AND resolved_at IS NULL AND resolved_case_id IS NULL AND dismiss_reason IS NULL)
    OR (state = 'filed' AND resolved_at IS NOT NULL AND resolved_case_id IS NOT NULL AND dismiss_reason IS NULL)
    OR (state = 'dismissed' AND resolved_at IS NOT NULL AND resolved_case_id IS NULL
        AND dismiss_reason IS NOT NULL AND char_length(dismiss_reason) BETWEEN 3 AND 500))
);
CREATE INDEX IF NOT EXISTS desk_tray_open_idx ON public.desk_tray (account_id, received_at) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS desk_tray_contact_idx ON public.desk_tray (account_id, contact_id);
ALTER TABLE public.desk_tray ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.desk_tray FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.desk_tray FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.desk_tray IS
  'Customer WhatsApp documents the desk router could not place with certainty: candidates listed, none chosen; '
  'a person files or dismisses. Migration 230.';

-- ---------- 2. Settings ----------

CREATE OR REPLACE FUNCTION public.desk_settings_get(p_actor uuid, p_account uuid)
RETURNS TABLE (routing_enabled boolean, desk_channel_ids uuid[], duty_user_id uuid, escalate_minutes integer,
               updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF public.case_account_role(p_account, p_actor) IS NULL THEN
    PERFORM public.desk_refuse('desk_settings_get', 'NOT_ALLOWED', 'staff only');
  END IF;
  RETURN QUERY
  SELECT coalesce(s.routing_enabled, false), coalesce(s.desk_channel_ids, '{}'::uuid[]), s.duty_user_id,
         coalesce(s.escalate_minutes, 120), s.updated_at
    FROM (SELECT 1) one
    LEFT JOIN public.desk_settings s ON s.account_id = p_account;
END;
$$;

-- Owner / admin: the switch, the desk numbers (company numbers of this
-- workspace, never personal ones) and the escalation delay.
CREATE OR REPLACE FUNCTION public.desk_settings_set(p_actor uuid, p_account uuid, p_routing_enabled boolean,
  p_desk_channel_ids uuid[], p_escalate_minutes integer, p_now timestamptz DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids uuid[] := coalesce(p_desk_channel_ids, '{}'::uuid[]);
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor) IN ('admin', 'super_admin'), false) IS NOT TRUE THEN
    PERFORM public.desk_refuse('desk_settings_set', 'NOT_ALLOWED', 'owners and admins only');
  END IF;
  IF p_routing_enabled IS NULL OR p_escalate_minutes IS NULL OR p_escalate_minutes NOT BETWEEN 15 AND 1440
     OR cardinality(v_ids) > 20
     OR EXISTS (SELECT 1 FROM unnest(v_ids) i
                 WHERE NOT EXISTS (SELECT 1 FROM public.whatsapp_config w
                                    WHERE w.id = i AND w.account_id = p_account
                                      AND NOT coalesce(w.is_personal, false))) THEN
    PERFORM public.desk_refuse('desk_settings_set', 'INVALID', 'routing, company numbers of this workspace and 15-1440 minutes');
  END IF;
  INSERT INTO public.desk_settings AS s (account_id, routing_enabled, desk_channel_ids, escalate_minutes,
                                        updated_by, updated_at)
  VALUES (p_account, p_routing_enabled, (SELECT coalesce(array_agg(DISTINCT i), '{}') FROM unnest(v_ids) i),
          p_escalate_minutes, p_actor, coalesce(p_now, now()))
  ON CONFLICT (account_id) DO UPDATE
     SET routing_enabled = excluded.routing_enabled, desk_channel_ids = excluded.desk_channel_ids,
         escalate_minutes = excluded.escalate_minutes, updated_by = excluded.updated_by,
         updated_at = excluded.updated_at;
END;
$$;

-- Team leader and up: who is on duty for the tray (NULL clears it).
CREATE OR REPLACE FUNCTION public.desk_duty_set(p_actor uuid, p_account uuid, p_user uuid,
  p_now timestamptz DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor) IN ('team_lead', 'admin', 'super_admin'), false) IS NOT TRUE THEN
    PERFORM public.desk_refuse('desk_duty_set', 'NOT_ALLOWED', 'team leaders and up');
  END IF;
  IF p_user IS NOT NULL AND public.case_account_role(p_account, p_user) IS NULL THEN
    PERFORM public.desk_refuse('desk_duty_set', 'INVALID', 'the duty owner must be live staff of this workspace');
  END IF;
  INSERT INTO public.desk_settings AS s (account_id, duty_user_id, updated_by, updated_at)
  VALUES (p_account, p_user, p_actor, coalesce(p_now, now()))
  ON CONFLICT (account_id) DO UPDATE
     SET duty_user_id = excluded.duty_user_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
END;
$$;

-- ---------- 3. Who sent it ----------

-- The one live staff member whose saved WhatsApp number (142) is this
-- contact's phone, or NULL (none, or more than one: never guessed).
CREATE OR REPLACE FUNCTION public.desk_staff_for_contact(p_account uuid, p_contact uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE WHEN count(*) = 1 THEN min(p.user_id::text)::uuid END
    FROM public.contacts c
    JOIN public.coordinator_phones p
      ON p.account_id = c.account_id
     AND regexp_replace(p.phone, '[^0-9]', '', 'g') = regexp_replace(coalesce(c.phone_normalized, c.phone), '[^0-9]', '', 'g')
   WHERE c.id = p_contact AND c.account_id = p_account
     AND regexp_replace(coalesce(c.phone_normalized, c.phone), '[^0-9]', '', 'g') <> ''
     AND public.case_account_role(p_account, p.user_id) IS NOT NULL
$$;

-- ---------- 4. The router ----------

-- Every open desk case of the sender's companies, with why each is a
-- candidate (sorted by case number; nothing is chosen here).
CREATE OR REPLACE FUNCTION public.desk_route_candidates(p_account uuid, p_contact uuid, p_customers uuid[],
  p_quoted uuid[], p_coded uuid[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'case_id', k.id, 'case_number', k.case_number, 'bank_code', k.bank_code,
           'company', d.legal_name, 'product', k.product,
           'why', to_jsonb(array_remove(ARRAY[
             CASE WHEN k.id = ANY (p_quoted) THEN 'quoted' END,
             CASE WHEN k.id = ANY (p_coded) THEN 'code' END,
             CASE WHEN EXISTS (SELECT 1 FROM public.case_intake_prompts q
                                WHERE q.case_id = k.id AND q.answered_at IS NULL AND q.superseded_at IS NULL)
                  THEN 'prompt' END,
             CASE WHEN k.contact_id = p_contact THEN 'sender' END], NULL)))
         ORDER BY k.case_number), '[]'::jsonb)
    FROM public.cases k
    JOIN public.desk_customers d ON d.id = k.desk_customer_id
   WHERE k.account_id = p_account AND k.desk_customer_id = ANY (p_customers) AND k.closed_at IS NULL
$$;

CREATE OR REPLACE FUNCTION public.desk_route_customer_document(p_account uuid, p_document uuid, p_channel uuid,
  p_now timestamptz DEFAULT NULL)
RETURNS TABLE (action text, case_id uuid, tray_id uuid, reason text, staff_user_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_now     timestamptz := coalesce(p_now, now());
  s         public.desk_settings%ROWTYPE;
  d         public.customer_documents%ROWTYPE;
  v_staff   uuid;
  v_custs   uuid[];
  v_open    uuid[];
  v_quoted  uuid[] := '{}';
  v_coded   uuid[] := '{}';
  v_text    text;
  v_tok     text;
  v_case    uuid;
  v_chosen  uuid;
  v_reason  text;
  v_cands   jsonb;
  v_tray    uuid;
  v_cc      uuid;
BEGIN
  SELECT * INTO s FROM public.desk_settings x WHERE x.account_id = p_account;
  IF NOT coalesce(s.routing_enabled, false) THEN
    RETURN QUERY SELECT 'off'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid;
    RETURN;
  END IF;
  SELECT * INTO d FROM public.customer_documents x WHERE x.id = p_document AND x.account_id = p_account;
  IF NOT FOUND OR d.source <> 'chat' OR d.contact_id IS NULL THEN
    RETURN QUERY SELECT 'ignored'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  -- A replay answers what was decided the first time.
  SELECT t.id, t.reason INTO v_tray, v_reason FROM public.desk_tray t WHERE t.customer_document_id = p_document;
  IF v_tray IS NOT NULL THEN
    RETURN QUERY SELECT 'tray'::text, NULL::uuid, v_tray, v_reason, NULL::uuid;
    RETURN;
  END IF;
  SELECT f.case_id INTO v_case FROM public.case_document_files f
    JOIN public.cases k ON k.id = f.case_id AND k.desk_customer_id IS NOT NULL
   WHERE f.customer_document_id = p_document
   ORDER BY f.registered_at LIMIT 1;
  IF v_case IS NOT NULL THEN
    RETURN QUERY SELECT 'filed'::text, v_case, NULL::uuid, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  v_staff := public.desk_staff_for_contact(p_account, d.contact_id);
  IF v_staff IS NOT NULL THEN
    RETURN QUERY SELECT 'staff'::text, NULL::uuid, NULL::uuid, NULL::text, v_staff;
    RETURN;
  END IF;

  SELECT coalesce(array_agg(x.customer_id), '{}') INTO v_custs
    FROM public.desk_customers_for_contact(p_account, d.contact_id) x;
  IF cardinality(v_custs) = 0 THEN
    IF p_channel IS NOT NULL AND p_channel = ANY (coalesce(s.desk_channel_ids, '{}')) THEN
      v_reason := 'unknown_sender';
      v_cands := '[]'::jsonb;
    ELSE
      RETURN QUERY SELECT 'ignored'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid;
      RETURN;
    END IF;
  ELSE
    SELECT coalesce(array_agg(k.id), '{}') INTO v_open FROM public.cases k
     WHERE k.account_id = p_account AND k.desk_customer_id = ANY (v_custs) AND k.closed_at IS NULL;

    -- E1: the message quotes one of our messages that names case numbers.
    SELECT q.content_text INTO v_text
      FROM public.messages m
      JOIN public.messages q ON q.id = m.reply_to_message_id AND q.conversation_id = m.conversation_id
     WHERE m.id = d.message_id AND q.sender_type <> 'customer';
    IF v_text IS NOT NULL THEN
      SELECT coalesce(array_agg(DISTINCT k.id), '{}') INTO v_quoted
        FROM regexp_matches(upper(v_text), 'TC-[0-9]{2}-[0-9]{5,7}-[A-Z]{3}[2-9]?', 'g') AS mm(arr)
        JOIN public.cases k ON k.account_id = p_account AND k.case_number = mm.arr[1]
       WHERE k.id = ANY (v_open);
    END IF;

    -- E2: case numbers and caption codes in the caption (check character
    -- verified by 220's resolver; a typo resolves to nothing).
    FOR v_tok IN SELECT DISTINCT t FROM regexp_split_to_table(upper(coalesce(d.caption, '')), '[[:space:],;]+') t
                  WHERE t <> '' LOOP
      v_case := NULL;
      IF v_tok ~ '^TC-[0-9]{2}-[0-9]{5,7}-[A-Z]{3}[2-9]?$' THEN
        SELECT k.id INTO v_case FROM public.cases k WHERE k.account_id = p_account AND k.case_number = v_tok;
      ELSIF v_tok ~ '^[1-9][0-9]{0,6}[A-Z]{3}[2-9]?[0-9A-Z]$' THEN
        v_case := public.desk_case_resolve_code(p_account, v_tok);
      END IF;
      IF v_case IS NOT NULL AND v_case = ANY (v_open) AND NOT v_case = ANY (v_coded) THEN
        v_coded := v_coded || v_case;
      END IF;
    END LOOP;

    v_cands := public.desk_route_candidates(p_account, d.contact_id, v_custs, v_quoted, v_coded);
    IF cardinality(v_open) = 0 THEN
      v_reason := 'no_open_case';
    ELSIF cardinality(v_quoted) > 1 OR cardinality(v_coded) > 1
       OR (cardinality(v_quoted) = 1 AND cardinality(v_coded) = 1 AND v_quoted[1] <> v_coded[1]) THEN
      v_reason := 'evidence_conflict';
    ELSE
      v_chosen := coalesce(v_quoted[1], v_coded[1]);
      IF v_chosen IS NULL THEN
        IF cardinality(v_custs) > 1 THEN
          v_reason := 'many_companies';
        ELSIF cardinality(v_open) > 1 THEN
          v_reason := 'many_cases';
        ELSE
          v_chosen := v_open[1];  -- E4
        END IF;
      END IF;
    END IF;

    IF v_chosen IS NOT NULL THEN
      SELECT k.contact_id INTO v_cc FROM public.cases k WHERE k.id = v_chosen;
      IF v_cc IS DISTINCT FROM d.contact_id THEN
        v_reason := 'other_person';
      ELSE
        BEGIN
          PERFORM public.case_document_file_register(NULL, v_chosen, p_document);
          RETURN QUERY SELECT 'filed'::text, v_chosen, NULL::uuid, NULL::text, NULL::uuid;
          RETURN;
        EXCEPTION WHEN OTHERS THEN
          v_reason := 'file_refused';
        END;
      END IF;
    END IF;
  END IF;

  INSERT INTO public.desk_tray AS t (account_id, customer_document_id, contact_id, conversation_id, channel_id,
                                     reason, candidates, duty_user_id, received_at)
  VALUES (p_account, p_document, d.contact_id, d.conversation_id, p_channel, v_reason, v_cands,
          s.duty_user_id, coalesce(d.received_at, v_now))
  ON CONFLICT (customer_document_id) DO NOTHING
  RETURNING t.id INTO v_tray;
  IF v_tray IS NULL THEN
    SELECT t.id, t.reason INTO v_tray, v_reason FROM public.desk_tray t WHERE t.customer_document_id = p_document;
  END IF;
  RETURN QUERY SELECT 'tray'::text, NULL::uuid, v_tray, v_reason, NULL::uuid;
END;
$$;

-- A staff member's WhatsApp upload: 220's intake_submit in their name,
-- marked as arriving by WhatsApp.
CREATE OR REPLACE FUNCTION public.desk_whatsapp_intake(p_actor uuid, p_account uuid, p_item uuid, p_idem_key text,
  p_kind text, p_bank_code text, p_case_ref text, p_company_name text, p_trade_licence text, p_product text,
  p_doc_key text, p_note text, p_storage_path text, p_original_name text, p_mime text,
  p_size bigint, p_sha256 text, p_now timestamptz DEFAULT NULL)
RETURNS TABLE (item_id uuid, state text, case_id uuid, case_number text, caption_code text, file_id uuid,
  duplicate_of_item uuid, queue_bank_code text, queue_reason text, replayed boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT x.* FROM public.intake_submit(p_actor, p_account, p_item, p_idem_key, p_kind, p_bank_code, p_case_ref,
    p_company_name, p_trade_licence, p_product, NULL, p_doc_key, p_note, p_storage_path, p_original_name, p_mime,
    p_size, p_sha256, p_now) x;
  UPDATE public.intake_items i SET channel = 'whatsapp'
   WHERE i.id = p_item AND i.account_id = p_account AND i.uploaded_by = p_actor AND i.channel = 'wacrm';
END;
$$;

-- ---------- 5. The tray ----------

-- May p_actor sort this tray item? Team leader and up; else a holder of
-- one of its candidates' banks.
CREATE OR REPLACE FUNCTION public.desk_tray_can_sort(p_actor uuid, p_account uuid, p_candidates jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(public.case_account_role(p_account, p_actor) IN ('team_lead', 'admin', 'super_admin'), false)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb)) e
                  WHERE public.case_holds_bank(p_account, p_actor, e->>'bank_code'))
$$;

CREATE OR REPLACE FUNCTION public.desk_tray_list(p_actor uuid, p_account uuid, p_state text DEFAULT 'open',
  p_limit integer DEFAULT 100, p_now timestamptz DEFAULT NULL)
RETURNS TABLE (tray_id uuid, reason text, candidates jsonb, state text, received_at timestamptz,
               age_seconds bigint, escalated_at timestamptz, duty_user_id uuid, contact_id uuid,
               contact_name text, contact_phone text, sender_companies jsonb, document_kind text, mime text,
               original_name text, caption text, media_url text, resolved_case_id uuid, dismiss_reason text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := coalesce(p_now, now());
BEGIN
  IF public.case_account_role(p_account, p_actor) IS NULL THEN
    PERFORM public.desk_refuse('desk_tray_list', 'NOT_ALLOWED', 'staff only');
  END IF;
  IF p_state IS NULL OR p_state NOT IN ('open', 'filed', 'dismissed') THEN
    PERFORM public.desk_refuse('desk_tray_list', 'INVALID', 'state is open, filed or dismissed');
  END IF;
  RETURN QUERY
  SELECT t.id, t.reason, t.candidates, t.state, t.received_at,
         greatest(0, extract(epoch FROM v_now - t.received_at))::bigint, t.escalated_at, t.duty_user_id,
         t.contact_id, c.name, c.phone,
         (SELECT coalesce(jsonb_agg(jsonb_build_object('company', x.legal_name, 'role', x.role)
                                    ORDER BY x.legal_name), '[]'::jsonb)
            FROM public.desk_customers_for_contact(p_account, t.contact_id) x),
         d.kind, d.mime, d.original_name, d.caption, d.media_url, t.resolved_case_id, t.dismiss_reason
    FROM public.desk_tray t
    JOIN public.customer_documents d ON d.id = t.customer_document_id
    LEFT JOIN public.contacts c ON c.id = t.contact_id
   WHERE t.account_id = p_account AND t.state = p_state
     AND public.desk_tray_can_sort(p_actor, p_account, t.candidates)
   ORDER BY t.received_at
   LIMIT least(greatest(coalesce(p_limit, 100), 1), 200);
END;
$$;

-- File a tray item to an open desk case. The sender's own document is
-- registered on the case at once ('filed'); another person's comes back
-- 'needs_copy' with the file's link, and the app files it through the
-- desk intake in the sorter's name, then calls desk_tray_resolve.
CREATE OR REPLACE FUNCTION public.desk_tray_file(p_actor uuid, p_account uuid, p_tray uuid, p_case uuid,
  p_confirm_company text, p_now timestamptz DEFAULT NULL)
RETURNS TABLE (outcome text, case_number text, media_url text, mime text, original_name text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_now  timestamptz := coalesce(p_now, now());
  t      public.desk_tray%ROWTYPE;
  k      public.cases%ROWTYPE;
  d      public.customer_documents%ROWTYPE;
  v_name text;
BEGIN
  SELECT * INTO t FROM public.desk_tray x WHERE x.id = p_tray AND x.account_id = p_account;
  IF NOT FOUND OR NOT public.desk_tray_can_sort(p_actor, p_account, t.candidates) THEN
    PERFORM public.desk_refuse('desk_tray_file', 'TRAY_NOT_FOUND', 'tray item not found');
  END IF;
  SELECT * INTO k FROM public.cases x
   WHERE x.id = p_case AND x.account_id = p_account AND x.desk_customer_id IS NOT NULL
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM public.desk_refuse('desk_tray_file', 'CASE_NOT_FOUND', 'not a desk case of this workspace');
  END IF;
  IF NOT public.intake_scope_ok(p_actor, p_account, k.bank_code) THEN
    PERFORM public.desk_refuse('desk_tray_file', 'BANK_SCOPE', 'that case belongs to another bank');
  END IF;
  SELECT * INTO t FROM public.desk_tray x WHERE x.id = p_tray FOR UPDATE;
  IF t.state <> 'open' THEN
    PERFORM public.desk_refuse('desk_tray_file', 'TRAY_NOT_OPEN', 'this item was already sorted');
  END IF;
  IF k.closed_at IS NOT NULL THEN
    PERFORM public.desk_refuse('desk_tray_file', 'CASE_CLOSED', 'the case is closed');
  END IF;
  -- A company the sender is not linked to needs its legal name typed.
  IF NOT EXISTS (SELECT 1 FROM public.desk_customer_contacts l
                  WHERE l.customer_id = k.desk_customer_id AND l.contact_id = t.contact_id) THEN
    SELECT x.legal_name INTO v_name FROM public.desk_customers x WHERE x.id = k.desk_customer_id;
    IF public.desk_normalise_name(coalesce(p_confirm_company, '')) IS DISTINCT FROM public.desk_normalise_name(v_name) THEN
      PERFORM public.desk_refuse('desk_tray_file', 'CONFIRM_COMPANY', 'type the company''s legal name to confirm');
    END IF;
  END IF;
  SELECT * INTO d FROM public.customer_documents x WHERE x.id = t.customer_document_id;

  IF t.contact_id IS NOT DISTINCT FROM k.contact_id THEN
    INSERT INTO public.case_document_files (account_id, case_id, customer_document_id, registered_by)
    VALUES (k.account_id, k.id, d.id, p_actor)
    ON CONFLICT (case_id, customer_document_id) DO NOTHING;
    UPDATE public.desk_tray x
       SET state = 'filed', resolved_by = p_actor, resolved_at = v_now, resolved_case_id = k.id
     WHERE x.id = p_tray;
    RETURN QUERY SELECT 'filed'::text, k.case_number, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'needs_copy'::text, k.case_number, d.media_url, d.mime, d.original_name;
END;
$$;

-- After the app filed another person's document through the intake:
-- the item must be the sorter's, filed (or a duplicate) on that case.
CREATE OR REPLACE FUNCTION public.desk_tray_resolve(p_actor uuid, p_account uuid, p_tray uuid, p_case uuid,
  p_item uuid, p_now timestamptz DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  t public.desk_tray%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.desk_tray x WHERE x.id = p_tray AND x.account_id = p_account FOR UPDATE;
  IF NOT FOUND OR NOT public.desk_tray_can_sort(p_actor, p_account, t.candidates) THEN
    PERFORM public.desk_refuse('desk_tray_resolve', 'TRAY_NOT_FOUND', 'tray item not found');
  END IF;
  IF t.state <> 'open' THEN
    PERFORM public.desk_refuse('desk_tray_resolve', 'TRAY_NOT_OPEN', 'this item was already sorted');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.intake_items i
                  WHERE i.id = p_item AND i.account_id = p_account AND i.uploaded_by = p_actor
                    AND i.state IN ('filed', 'duplicate')
                    AND (i.filed_case_id = p_case
                         OR EXISTS (SELECT 1 FROM public.intake_items o
                                     WHERE o.id = i.duplicate_of_item AND o.filed_case_id = p_case))) THEN
    PERFORM public.desk_refuse('desk_tray_resolve', 'ITEM_NOT_FOUND', 'no upload of yours filed on that case');
  END IF;
  UPDATE public.desk_tray x
     SET state = 'filed', resolved_by = p_actor, resolved_at = coalesce(p_now, now()),
         resolved_case_id = p_case, resolved_item_id = p_item
   WHERE x.id = p_tray;
END;
$$;

CREATE OR REPLACE FUNCTION public.desk_tray_dismiss(p_actor uuid, p_account uuid, p_tray uuid, p_reason text,
  p_now timestamptz DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  t        public.desk_tray%ROWTYPE;
  v_reason text := public.desk_clean(p_reason);
BEGIN
  SELECT * INTO t FROM public.desk_tray x WHERE x.id = p_tray AND x.account_id = p_account FOR UPDATE;
  IF NOT FOUND OR NOT public.desk_tray_can_sort(p_actor, p_account, t.candidates) THEN
    PERFORM public.desk_refuse('desk_tray_dismiss', 'TRAY_NOT_FOUND', 'tray item not found');
  END IF;
  IF t.state <> 'open' THEN
    PERFORM public.desk_refuse('desk_tray_dismiss', 'TRAY_NOT_OPEN', 'this item was already sorted');
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) NOT BETWEEN 3 AND 500 THEN
    PERFORM public.desk_refuse('desk_tray_dismiss', 'REASON_REQUIRED', 'a reason of 3 to 500 characters');
  END IF;
  UPDATE public.desk_tray x
     SET state = 'dismissed', resolved_by = p_actor, resolved_at = coalesce(p_now, now()), dismiss_reason = v_reason
   WHERE x.id = p_tray;
END;
$$;

-- ---------- 6. Escalation (the automations cron) ----------

-- Open items past their workspace's delay, not yet escalated, with whom
-- to give the follow-up: the item's duty owner if still live staff, else
-- the workspace's longest-standing live owner.
CREATE OR REPLACE FUNCTION public.desk_tray_due_escalation(p_now timestamptz DEFAULT NULL, p_limit integer DEFAULT 200)
RETURNS TABLE (tray_id uuid, account_id uuid, assignee uuid, age_minutes integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT t.id, t.account_id,
         coalesce(CASE WHEN public.case_account_role(t.account_id, t.duty_user_id) IS NOT NULL THEN t.duty_user_id END,
                  (SELECT p.user_id FROM public.profiles p
                    WHERE p.account_id = t.account_id AND p.account_role = 'owner' AND p.deactivated_at IS NULL
                    ORDER BY p.created_at, p.user_id LIMIT 1)),
         (extract(epoch FROM coalesce(p_now, now()) - t.received_at) / 60)::integer
    FROM public.desk_tray t
    LEFT JOIN public.desk_settings s ON s.account_id = t.account_id
   WHERE t.state = 'open' AND t.escalated_at IS NULL
     AND t.received_at <= coalesce(p_now, now()) - make_interval(mins => coalesce(s.escalate_minutes, 120))
   ORDER BY t.received_at
   LIMIT least(greatest(coalesce(p_limit, 200), 1), 500)
$$;

CREATE OR REPLACE FUNCTION public.desk_tray_mark_escalated(p_tray uuid, p_now timestamptz DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.desk_tray t SET escalated_at = coalesce(p_now, now())
   WHERE t.id = p_tray AND t.state = 'open' AND t.escalated_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

-- ---------- 7. Privacy: tray rows are exported and erased ----------

CREATE OR REPLACE FUNCTION public.privacy_desk_tray_export(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'reason', t.reason, 'state', t.state, 'received_at', t.received_at,
           'resolved_at', t.resolved_at, 'dismiss_reason', t.dismiss_reason) ORDER BY t.received_at), '[]'::jsonb)
    FROM public.desk_tray t
   WHERE t.account_id = p_account AND t.contact_id = p_contact
$$;

CREATE OR REPLACE FUNCTION public.privacy_desk_tray_erase(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM public.desk_tray t WHERE t.account_id = p_account AND t.contact_id = p_contact;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  -- The documents themselves are 178's, erased by 222 with their objects.
  RETURN jsonb_build_object('counts', jsonb_build_object('desk_tray', v_n), 'objects', '[]'::jsonb);
END;
$$;

INSERT INTO public.privacy_extensions (name, export_fn, erase_fn, added_in)
VALUES ('desk_tray', 'privacy_desk_tray_export', 'privacy_desk_tray_erase', '230')
ON CONFLICT (name) DO UPDATE SET export_fn = excluded.export_fn, erase_fn = excluded.erase_fn;

-- ---------- 8. Privileges ----------

REVOKE ALL ON FUNCTION
  public.desk_settings_get(uuid, uuid), public.desk_settings_set(uuid, uuid, boolean, uuid[], integer, timestamptz),
  public.desk_duty_set(uuid, uuid, uuid, timestamptz), public.desk_staff_for_contact(uuid, uuid),
  public.desk_route_candidates(uuid, uuid, uuid[], uuid[], uuid[]),
  public.desk_route_customer_document(uuid, uuid, uuid, timestamptz),
  public.desk_whatsapp_intake(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text,
                              text, bigint, text, timestamptz),
  public.desk_tray_can_sort(uuid, uuid, jsonb), public.desk_tray_list(uuid, uuid, text, integer, timestamptz),
  public.desk_tray_file(uuid, uuid, uuid, uuid, text, timestamptz),
  public.desk_tray_resolve(uuid, uuid, uuid, uuid, uuid, timestamptz),
  public.desk_tray_dismiss(uuid, uuid, uuid, text, timestamptz),
  public.desk_tray_due_escalation(timestamptz, integer), public.desk_tray_mark_escalated(uuid, timestamptz),
  public.privacy_desk_tray_export(uuid, uuid), public.privacy_desk_tray_erase(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.desk_settings_get(uuid, uuid), public.desk_settings_set(uuid, uuid, boolean, uuid[], integer, timestamptz),
  public.desk_duty_set(uuid, uuid, uuid, timestamptz),
  public.desk_route_customer_document(uuid, uuid, uuid, timestamptz),
  public.desk_whatsapp_intake(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text,
                              text, bigint, text, timestamptz),
  public.desk_tray_list(uuid, uuid, text, integer, timestamptz),
  public.desk_tray_file(uuid, uuid, uuid, uuid, text, timestamptz),
  public.desk_tray_resolve(uuid, uuid, uuid, uuid, uuid, timestamptz),
  public.desk_tray_dismiss(uuid, uuid, uuid, text, timestamptz),
  public.desk_tray_due_escalation(timestamptz, integer), public.desk_tray_mark_escalated(uuid, timestamptz)
TO service_role;
