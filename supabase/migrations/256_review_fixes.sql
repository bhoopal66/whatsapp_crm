-- ============================================================
-- 256_review_fixes.sql — fixes from the independent review of the
-- 2026-11-22 release (migrations 236-255).
--
--  1. Broadcast drafts (252). broadcasts.draft_state could hold a CSV
--     audience (up to 5,000 phones and names) and broadcasts_select
--     lets every member read it, viewers included, although 057 made
--     broadcast_recipients admin-only. The wizard state moves to its
--     own table, broadcast_drafts, readable and writable by owners and
--     admins only, keyed by the broadcast and its account (composite FK
--     to broadcasts(id, account_id), ON DELETE CASCADE, so a send that
--     deletes the draft row deletes its state). Existing values are
--     copied across, then the column is dropped. PDPL: the CSV rows are
--     personal; privacy_broadcast_drafts_erase (registered in 229's
--     privacy_extensions) deletes a draft whose CSV names the erased
--     customer's number. Not exported: an unsent draft.
--  2. Note @mentions (241). conversation_note_user_can_see asked 190's
--     can_view_conversation_for_user, whose personal-number arm shows a
--     personal number's owner (and their leader) any chat on that
--     number. A note now uses its own rule for company chats with no
--     number arm: admins, the owner, the assignee and their team
--     leaders (conversation_note_company_chat_visible). 191's guard
--     keeps company chats off personal numbers, so the arm only
--     mattered for a row that slipped past it; a note never rings
--     through it now. RESTATES 241's conversation_note_user_can_see:
--     apply in order, once.
--  3. recycle_excluded_among (251) had no role check and counted
--     personal chats: it now answers team leaders and up only (empty
--     otherwise) and reads company chats only. RESTATES 251's body:
--     apply in order, once.
--  4. web_form_submit (249) could rename an existing contact (a name
--     that was empty or equal to the phone, an empty email). It now
--     fills name and email only on a contact this submission created;
--     for an existing contact the submitted name and email go in the
--     "New web lead" task's meta (submitted_name, submitted_email) and
--     its note. RESTATES 249's body: apply in order, once.
--  6. assignment_compass_assign (236) ignored human_engaged_at: an
--     engaged chat is now refused with reason 'engaged', as
--     assignment_rotate_assign and the call-history assign do.
--     RESTATES 236's body: apply in order, once.
--  7. Report grants (255) survived a person leaving the workspace or
--     being deactivated, and came back on re-add. A profiles trigger
--     now deletes their report_access rows in that workspace on leave
--     (account change or delete) and on deactivation; grants already
--     stale are deleted once here.
--  8. chat_tag_report (255) named an unlabelled number by its waba_id,
--     which for a phone number is the phone itself. It now says
--     "Unnamed number ending NN" (the last two digits). RESTATES 255's body:
--     apply in order, once.
--  9. response_escalation_sweep (237) took the 500 oldest waits by wall
--     clock before checking business minutes or what had already rung,
--     so chats still under target in business hours, or already rung
--     at their level, could crowd out newer waits. The candidate query
--     now works out each chat's level (live assignee, business
--     minutes) and leaves out chats already rung at it, before the
--     LIMIT. RESTATES 237's body: apply in order, once.
-- 10. 237's helpers kept PUBLIC/anon EXECUTE (classic default grants):
--     revoked; authenticated keeps what RLS-side callers (238's
--     invoker functions, the CHECK on response_settings) need.
--
-- (Fixes 5 and 11 are app code only: the web form route's rate limits
-- and the broadcast detail page's CSV.)
--
-- Apply as a superuser or BYPASSRLS role after 255 (the backfills write
-- RLS-forced tables). Guarded and re-runnable. Asserted by
-- supabase/ci/verify-review-fixes.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '256 must be applied by a superuser or BYPASSRLS role';
  END IF;
  IF to_regclass('public.report_access') IS NULL THEN
    RAISE EXCEPTION '256: apply 255_chat_tag_report.sql first (report_access)';
  END IF;
  IF to_regclass('public.privacy_extensions') IS NULL THEN
    RAISE EXCEPTION '256: apply 229_desk_customer_contacts.sql first (privacy_extensions)';
  END IF;
END $$;

-- ---------- 1. Broadcast drafts ----------

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.broadcasts'::regclass
                    AND conname = 'broadcasts_id_account_key') THEN
    ALTER TABLE public.broadcasts
      ADD CONSTRAINT broadcasts_id_account_key UNIQUE (id, account_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.broadcast_drafts (
  broadcast_id uuid PRIMARY KEY,
  account_id   uuid NOT NULL,
  state        jsonb NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid NULL,  -- auth user id
  CONSTRAINT broadcast_drafts_broadcast_account_key UNIQUE (broadcast_id, account_id),
  CONSTRAINT broadcast_drafts_broadcast_fkey FOREIGN KEY (broadcast_id, account_id)
    REFERENCES public.broadcasts (id, account_id) ON DELETE CASCADE
);

ALTER TABLE public.broadcast_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS broadcast_drafts_select ON public.broadcast_drafts;
CREATE POLICY broadcast_drafts_select ON public.broadcast_drafts
  FOR SELECT USING (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS broadcast_drafts_insert ON public.broadcast_drafts;
CREATE POLICY broadcast_drafts_insert ON public.broadcast_drafts
  FOR INSERT WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS broadcast_drafts_update ON public.broadcast_drafts;
CREATE POLICY broadcast_drafts_update ON public.broadcast_drafts
  FOR UPDATE USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS broadcast_drafts_delete ON public.broadcast_drafts;
CREATE POLICY broadcast_drafts_delete ON public.broadcast_drafts
  FOR DELETE USING (public.is_account_member(account_id, 'admin'));

REVOKE ALL ON public.broadcast_drafts FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.broadcast_drafts TO authenticated;
GRANT ALL ON public.broadcast_drafts TO service_role;

COMMENT ON TABLE public.broadcast_drafts IS
  'Whole wizard state of a status=draft broadcast (src/lib/broadcasts/draft-state.ts). May hold uploaded CSV rows (phones, names): personal data, so owners and admins only, deleted with the draft. Moved here from broadcasts.draft_state by migration 256.';

-- Copy what 252 stored, then drop the column (members could read it).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'broadcasts'
                AND column_name = 'draft_state') THEN
    EXECUTE $q$
      INSERT INTO public.broadcast_drafts (broadcast_id, account_id, state, updated_by)
      SELECT b.id, b.account_id, b.draft_state, b.user_id
        FROM public.broadcasts b
       WHERE b.draft_state IS NOT NULL AND b.account_id IS NOT NULL
      ON CONFLICT (broadcast_id) DO NOTHING$q$;
    ALTER TABLE public.broadcasts DROP COLUMN draft_state;
  END IF;
END $$;

-- PDPL erase: a draft whose CSV holds the customer's number is deleted.
CREATE OR REPLACE FUNCTION public.privacy_broadcast_drafts_erase(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_digits text;
  v_n int := 0;
BEGIN
  SELECT public.privacy_digits(coalesce(c.phone_normalized, c.phone)) INTO v_digits
    FROM public.contacts c
   WHERE c.account_id = p_account AND c.id = p_contact;
  IF v_digits IS NOT NULL THEN
    DELETE FROM public.broadcast_drafts d
     WHERE d.account_id = p_account
       AND jsonb_typeof(d.state -> 'audience' -> 'csvContacts') = 'array'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(d.state -> 'audience' -> 'csvContacts') e
          WHERE jsonb_typeof(e) = 'object'
            AND public.privacy_digits(e ->> 'phone') = v_digits);
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;
  RETURN jsonb_build_object('counts', jsonb_build_object('broadcast_drafts', v_n),
                            'objects', '[]'::jsonb);
END;
$$;

-- PDPL export: the CSV rows of unsent drafts that hold the number.
CREATE OR REPLACE FUNCTION public.privacy_broadcast_drafts_export(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH c AS (
    SELECT public.privacy_digits(coalesce(ct.phone_normalized, ct.phone)) AS digits
      FROM public.contacts ct
     WHERE ct.account_id = p_account AND ct.id = p_contact
  )
  SELECT jsonb_build_object('broadcast_drafts', coalesce(jsonb_agg(
           jsonb_build_object('broadcast_id', d.broadcast_id, 'updated_at', d.updated_at,
                              'csv_row', e.row) ORDER BY d.updated_at), '[]'::jsonb))
    FROM c
    JOIN public.broadcast_drafts d ON d.account_id = p_account
   CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(d.state -> 'audience' -> 'csvContacts') = 'array'
                THEN d.state -> 'audience' -> 'csvContacts' ELSE '[]'::jsonb END) AS e(row)
   WHERE c.digits IS NOT NULL
     AND jsonb_typeof(e.row) = 'object'
     AND public.privacy_digits(e.row ->> 'phone') = c.digits
$$;

INSERT INTO public.privacy_extensions (name, export_fn, erase_fn, added_in)
VALUES ('broadcast_drafts', 'privacy_broadcast_drafts_export', 'privacy_broadcast_drafts_erase', '256')
ON CONFLICT (name) DO UPDATE SET export_fn = excluded.export_fn, erase_fn = excluded.erase_fn;

REVOKE ALL ON FUNCTION public.privacy_broadcast_drafts_export(uuid, uuid),
  public.privacy_broadcast_drafts_erase(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;

-- ---------- 2. Note mentions: their own visibility rule ----------

-- 190's can_view_conversation_for_user without the personal-number arm,
-- for a company chat: admins and owners, the owner, the assignee, and a
-- team leader of either. Private.
CREATE OR REPLACE FUNCTION public.conversation_note_company_chat_visible(
  p_user_id     uuid,
  p_account_id  uuid,
  p_owner_id    uuid,
  p_assigned_id uuid
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT CASE p.account_role
             WHEN 'owner'       THEN 5
             WHEN 'admin'       THEN 4
             WHEN 'team_leader' THEN 3
             WHEN 'agent'       THEN 2
             WHEN 'viewer'      THEN 1
           END AS rank
      FROM public.profiles p
     WHERE p.user_id = p_user_id
       AND p.account_id = p_account_id
       AND p.deactivated_at IS NULL
       AND p.account_role <> 'bank_guest'
  )
  SELECT CASE
    WHEN p_user_id IS NULL THEN FALSE
    WHEN coalesce((SELECT rank FROM me), 0) >= 4 THEN TRUE
    WHEN NOT EXISTS (SELECT 1 FROM me) THEN FALSE
    WHEN coalesce(p_owner_id = p_user_id, FALSE)
      OR coalesce(p_assigned_id = p_user_id, FALSE) THEN TRUE
    WHEN coalesce((SELECT rank FROM me), 0) >= 3
      AND EXISTS (
        SELECT 1
          FROM public.teams t
          JOIN public.team_members tm ON tm.team_id = t.id
         WHERE t.account_id = p_account_id
           AND t.leader_user_id = p_user_id
           AND tm.user_id IN (p_owner_id, p_assigned_id)
      ) THEN TRUE
    ELSE FALSE
  END
$$;

REVOKE ALL ON FUNCTION public.conversation_note_company_chat_visible(uuid, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.conversation_note_user_can_see(p_user uuid, p_conversation uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_user IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.conversations c
      JOIN public.profiles p
        ON p.user_id = p_user
       AND p.account_id = c.account_id
       AND p.deactivated_at IS NULL
       AND p.account_role <> 'bank_guest'
     WHERE c.id = p_conversation
       AND CASE
             WHEN c.personal_owner_id IS NULL THEN
               public.conversation_note_company_chat_visible(
                 p_user, c.account_id, c.user_id, c.assigned_agent_id)
             -- 191's can_view_personal_chat, for an explicit person.
             ELSE p.account_role IN ('owner', 'admin')
               OR c.personal_owner_id = p_user
               OR (p.account_role = 'team_leader' AND EXISTS (
                     SELECT 1 FROM public.teams t
                       JOIN public.team_members tm ON tm.team_id = t.id
                      WHERE t.account_id = c.account_id
                        AND t.leader_user_id = p_user
                        AND tm.user_id = c.personal_owner_id))
           END
  )
$$;

COMMENT ON FUNCTION public.conversation_note_user_can_see(uuid, uuid) IS
  'Can this live staff person see this chat? Company chats: conversation_note_company_chat_visible (256: 190''s rule without the personal-number arm); personal chats: 191''s rule. No coordinator shares. Private: the note triggers and the mention list use it. Migrations 241, 256.';

-- ---------- 3. recycle_excluded_among: team leaders and up, company chats ----------

CREATE OR REPLACE FUNCTION public.recycle_excluded_among(p_contact_ids uuid[], p_ended timestamptz[])
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT x.cid
    FROM unnest(p_contact_ids, p_ended) AS x(cid, ended)
   WHERE public.current_account_id() IS NOT NULL
     AND public.current_role_rank() >= 3
     AND EXISTS (SELECT 1 FROM public.contacts ct
                  WHERE ct.id = x.cid AND ct.account_id = public.current_account_id())
     AND (
       -- Active again: a case or lead of any bank is still open.
       EXISTS (SELECT 1 FROM public.cases c
                WHERE c.account_id = public.current_account_id()
                  AND c.contact_id = x.cid AND c.closed_at IS NULL)
       -- Came back: the customer wrote after the ending.
       OR EXISTS (SELECT 1
                    FROM public.conversations cv
                    JOIN public.messages m ON m.conversation_id = cv.id
                   WHERE cv.account_id = public.current_account_id()
                     AND cv.contact_id = x.cid
                     AND cv.personal_owner_id IS NULL
                     AND m.sender_type = 'customer'
                     AND m.created_at > x.ended)
     )
$$;

-- ---------- 4. web_form_submit: never rename an existing contact ----------

CREATE OR REPLACE FUNCTION public.web_form_submit(
  p_token text, p_name text, p_phone text, p_email text, p_message text,
  p_meta jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct    uuid;
  v_owner   uuid;
  v_name    text := nullif(left(regexp_replace(coalesce(p_name, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), 120), '');
  v_email   text := lower(nullif(left(btrim(coalesce(p_email, '')), 254), ''));
  v_message text := nullif(left(regexp_replace(coalesce(p_message, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), 2000), '');
  v_page    text;
  v_contact uuid;
  v_created boolean := false;
  v_task    boolean := false;
  v_detail  jsonb;
  v_note    text := v_message;
  v_meta    jsonb := '{}'::jsonb;
BEGIN
  SELECT w.account_id, a.owner_user_id INTO v_acct, v_owner
    FROM public.web_lead_forms w
    JOIN public.accounts a ON a.id = w.account_id
   WHERE p_token ~ '^[0-9a-f]{64}$'
     AND w.token = p_token
     AND w.enabled
     AND a.archived_at IS NULL;
  IF v_acct IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF p_phone IS NULL OR p_phone !~ '^[1-9][0-9]{9,14}$' THEN
    RAISE EXCEPTION 'The phone number must be international digits'
      USING ERRCODE = '22023', HINT = 'bad_phone';
  END IF;
  IF v_email IS NOT NULL AND v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    v_email := NULL;
  END IF;
  IF p_meta IS NOT NULL AND jsonb_typeof(p_meta) = 'object'
     AND jsonb_typeof(p_meta -> 'page_url') = 'string' THEN
    v_page := nullif(left(p_meta ->> 'page_url', 500), '');
  END IF;
  v_detail := jsonb_build_object('form', 'web', 'submitted_at', now())
    || CASE WHEN v_page IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('page_url', v_page) END;

  -- One submission per (workspace, number) at a time: the dedupe
  -- window below and the find-or-create are decided under this lock.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('web_form_submit'),
    pg_catalog.hashtext(v_acct::text || ':' || p_phone));

  SELECT c.id INTO v_contact
    FROM public.contacts c
   WHERE c.account_id = v_acct AND c.phone_normalized = p_phone
   LIMIT 1;

  IF v_contact IS NULL THEN
    INSERT INTO public.contacts (account_id, user_id, phone, name, email)
    VALUES (v_acct, v_owner, p_phone, v_name, v_email)
    ON CONFLICT (account_id, phone_normalized) WHERE phone_normalized <> ''
    DO NOTHING
    RETURNING id INTO v_contact;
    IF v_contact IS NOT NULL THEN
      v_created := true;
    ELSE
      -- An inbound message created it meanwhile.
      SELECT c.id INTO v_contact
        FROM public.contacts c
       WHERE c.account_id = v_acct AND c.phone_normalized = p_phone
       LIMIT 1;
    END IF;
  END IF;

  IF NOT v_created THEN
    -- An existing contact is never renamed by a public form (256): what
    -- was submitted goes in the task below for a person to judge.
    v_note := concat_ws(E'\n', v_message,
                        'Submitted name: ' || v_name,
                        'Submitted email: ' || v_email);
    v_meta := jsonb_strip_nulls(jsonb_build_object('submitted_name', v_name,
                                                   'submitted_email', v_email));
  END IF;

  PERFORM public.contact_set_lead_source_if_empty(v_acct, v_contact, 'web_form', v_detail);

  -- At most one "New web lead" task per contact per 10 minutes: a
  -- double click, a refresh or a bot repeating itself opens nothing new.
  IF NOT EXISTS (
    SELECT 1 FROM public.tasks t
     WHERE t.contact_id = v_contact
       AND t.account_id = v_acct
       AND t.source = 'automation'
       AND t.source_ref LIKE 'web_form:%'
       AND t.created_at > now() - interval '10 minutes') THEN
    INSERT INTO public.tasks
           (account_id, kind, title, note, contact_id, source, source_ref, meta)
    VALUES (v_acct, 'follow_up', 'New web lead', v_note, v_contact,
            'automation',
            'web_form:' || v_contact::text || ':'
              || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text,
            jsonb_build_object('web_form', true)
              || CASE WHEN v_page IS NULL THEN '{}'::jsonb
                      ELSE jsonb_build_object('page_url', v_page) END
              || v_meta)
    ON CONFLICT (account_id, source, source_ref) DO NOTHING;
    v_task := FOUND;
  END IF;

  RETURN jsonb_build_object('status', 'ok', 'contact_id', v_contact,
    'contact_created', v_created, 'task_created', v_task);
END;
$$;

-- ---------- 6. Compass assign refuses an engaged chat ----------

CREATE OR REPLACE FUNCTION public.assignment_compass_assign(
  p_account_id          uuid,
  p_conversation_id     uuid,
  p_agent_user_id       uuid,
  p_coordinator_user_id uuid DEFAULT NULL,
  p_bank_code           text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_on       boolean;
  v_conv     record;
  v_assigned uuid;
  v_bank     text := nullif(btrim(coalesce(p_bank_code, '')), '');
  v_open     public.conversation_coordinator_shares%ROWTYPE;
  v_share    uuid;
  v_shared   boolean := false;
  v_share_reason text;
  v_name     text;
BEGIN
  SELECT s.compass_assign_enabled INTO v_on
    FROM public.assignment_settings s WHERE s.account_id = p_account_id;
  IF NOT coalesce(v_on, false) THEN
    RETURN jsonb_build_object('enabled', false, 'assigned_to', NULL,
                              'shared_with', NULL, 'reason', 'off');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('assignment_rotation:' || p_account_id::text, 0));

  SELECT c.id, c.account_id, c.contact_id, c.personal_owner_id, c.assigned_agent_id,
         c.human_engaged_at
    INTO v_conv
    FROM public.conversations c
   WHERE c.id = p_conversation_id
   FOR UPDATE;
  IF NOT FOUND OR v_conv.account_id IS DISTINCT FROM p_account_id THEN
    RETURN jsonb_build_object('enabled', true, 'assigned_to', NULL,
                              'shared_with', NULL, 'reason', 'not_found');
  END IF;
  IF v_conv.personal_owner_id IS NOT NULL THEN
    RETURN jsonb_build_object('enabled', true, 'assigned_to', NULL,
                              'shared_with', NULL, 'reason', 'personal');
  END IF;
  IF v_conv.assigned_agent_id IS NOT NULL THEN
    RETURN jsonb_build_object('enabled', true, 'assigned_to', NULL,
                              'shared_with', NULL, 'reason', 'already_assigned');
  END IF;
  -- Someone is working the chat (replying does not assign): leave it,
  -- as assignment_rotate_assign and the call-history assign do (256).
  IF v_conv.human_engaged_at IS NOT NULL THEN
    RETURN jsonb_build_object('enabled', true, 'assigned_to', NULL,
                              'shared_with', NULL, 'reason', 'engaged');
  END IF;

  -- The agent: live staff of this account (not a guest or a viewer).
  IF p_agent_user_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.profiles p
        WHERE p.account_id = p_account_id
          AND p.user_id = p_agent_user_id
          AND p.deactivated_at IS NULL
          AND p.account_role::text NOT IN ('bank_guest', 'viewer')) THEN
    UPDATE public.conversations
       SET assigned_agent_id = p_agent_user_id
     WHERE id = p_conversation_id;
    v_assigned := p_agent_user_id;
  END IF;

  -- The coordinator's share, inserted as share_conversation_with_
  -- coordinator (133/191) inserts one, with no sharer (shared_by NULL).
  IF p_coordinator_user_id IS NULL THEN
    v_share_reason := 'no_coordinator';
  ELSIF p_coordinator_user_id IS NOT DISTINCT FROM v_assigned THEN
    v_share_reason := 'coordinator_is_assignee';
  ELSE
    IF v_bank IS NULL THEN
      -- No bank named: the coordinator's only bank, if they have one.
      SELECT CASE WHEN count(*) = 1 THEN min(b.bank_code) END INTO v_bank
        FROM public.coordinator_banks b
       WHERE b.account_id = p_account_id AND b.user_id = p_coordinator_user_id;
    END IF;

    IF v_bank IS NULL OR NOT EXISTS (
         SELECT 1 FROM public.coordinator_banks b
           JOIN public.profiles p ON p.user_id = b.user_id AND p.account_id = b.account_id
          WHERE b.account_id = p_account_id
            AND b.user_id = p_coordinator_user_id
            AND b.bank_code = v_bank
            AND p.deactivated_at IS NULL
            AND p.account_role::text IN ('agent', 'team_leader')) THEN
      v_share_reason := 'not_coordinator';
    ELSE
      SELECT * INTO v_open FROM public.conversation_coordinator_shares s
       WHERE s.conversation_id = p_conversation_id
         AND s.coordinator_user_id = p_coordinator_user_id
         AND s.revoked_at IS NULL;
      IF FOUND AND v_open.bank_code = v_bank THEN
        v_share := v_open.id;  -- already shared: no second bell
        v_share_reason := 'already_shared';
      ELSE
        IF FOUND THEN
          -- Shared before under another bank: that share is replaced.
          UPDATE public.conversation_coordinator_shares
             SET revoked_at = now()
           WHERE id = v_open.id;
        END IF;

        INSERT INTO public.conversation_coordinator_shares
          (account_id, conversation_id, coordinator_user_id, bank_code, shared_by)
        VALUES (p_account_id, p_conversation_id, p_coordinator_user_id, v_bank, NULL)
        RETURNING id INTO v_share;
        v_shared := true;
        v_share_reason := 'shared';

        SELECT coalesce(nullif(btrim(ct.name), ''), ct.phone) INTO v_name
          FROM public.contacts ct WHERE ct.id = v_conv.contact_id;

        INSERT INTO public.notifications
          (account_id, user_id, type, conversation_id, contact_id, actor_user_id, title, body, meta)
        VALUES (p_account_id, p_coordinator_user_id, 'conversation_shared', p_conversation_id,
                v_conv.contact_id, NULL,
                left('Chat shared with you' || coalesce(': ' || v_name, ''), 200),
                'Bank: ' || v_bank,
                jsonb_build_object('share_id', v_share, 'bank_code', v_bank, 'source', 'compass'));
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'enabled', true,
    'assigned_to', v_assigned,
    'reason', CASE WHEN v_assigned IS NOT NULL THEN 'assigned' ELSE 'agent_not_eligible' END,
    'shared_with', CASE WHEN v_share IS NOT NULL THEN p_coordinator_user_id END,
    'share_id', v_share,
    'share_created', v_shared,
    'share_reason', v_share_reason,
    'bank_code', v_bank);
END;
$$;

-- ---------- 7. Report grants end with the membership ----------

CREATE OR REPLACE FUNCTION public.profiles_drop_report_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.account_id IS NOT NULL
     AND (TG_OP = 'DELETE'
          OR OLD.account_id IS DISTINCT FROM NEW.account_id
          OR (OLD.deactivated_at IS NULL AND NEW.deactivated_at IS NOT NULL)) THEN
    DELETE FROM public.report_access ra
     WHERE ra.account_id = OLD.account_id AND ra.user_id = OLD.user_id;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.profiles_drop_report_access()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS profiles_drop_report_access ON public.profiles;
CREATE TRIGGER profiles_drop_report_access
  AFTER UPDATE OF account_id, deactivated_at OR DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_drop_report_access();

-- Grants already stale: no live staff row of that person there.
DELETE FROM public.report_access ra
 WHERE NOT EXISTS (
   SELECT 1 FROM public.profiles p
    WHERE p.user_id = ra.user_id
      AND p.account_id = ra.account_id
      AND p.deactivated_at IS NULL
      AND p.account_role <> 'bank_guest');

-- ---------- 8. Tag report: never a phone number as a name ----------

CREATE OR REPLACE FUNCTION public.chat_tag_report(
  p_from timestamptz,
  p_to   timestamptz,
  p_tz   text DEFAULT 'UTC'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid := public.current_account_id();
  v_tz      text := coalesce(nullif(p_tz, ''), 'UTC');
  v_since   timestamptz := public.chat_tag_history_since();
BEGIN
  IF v_account IS NULL OR NOT public.report_can_open('chat_tags') THEN
    RAISE EXCEPTION 'You do not have access to the chat tag report'
      USING ERRCODE = '42501', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from
     OR p_to - p_from > interval '400 days' THEN
    RAISE EXCEPTION 'The period is not valid'
      USING ERRCODE = '22023', HINT = 'BAD_RANGE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_tz) THEN
    v_tz := 'UTC';
  END IF;

  RETURN (
    WITH chats AS (
      SELECT c.id, c.chat_tag_id, c.chat_sub_tag_id, c.assigned_agent_id,
             c.channel_id, coalesce(ct.lead_source, 'none') AS lead_source
        FROM public.conversations c
        JOIN public.contacts ct ON ct.id = c.contact_id
       WHERE c.account_id = v_account
         AND c.personal_owner_id IS NULL
         AND c.chat_tag_id IS NOT NULL
    ),
    moves AS (
      SELECT h.conversation_id, h.to_tag_id, h.to_sub_tag_id, h.changed_at
        FROM public.chat_tag_history h
        JOIN public.conversations c ON c.id = h.conversation_id
       WHERE h.account_id = v_account
         AND c.account_id = v_account
         AND c.personal_owner_id IS NULL
         AND h.changed_at >= p_from
         AND h.changed_at <  p_to
         AND h.to_tag_id IS NOT NULL
    )
    SELECT jsonb_build_object(
      'history_since', v_since,
      'tags', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'id', t.id, 'parent_id', t.parent_id, 'name', t.name,
                 'color', t.color, 'sub_tag_title', t.sub_tag_title,
                 'position', t.position)
               ORDER BY t.parent_id NULLS FIRST, t.position, t.name)
          FROM public.chat_tags t WHERE t.account_id = v_account), '[]'::jsonb),
      'current', coalesce((
        SELECT jsonb_agg(jsonb_build_object('tag_id', s.chat_tag_id,
                 'sub_tag_id', s.chat_sub_tag_id, 'chats', s.n)
               ORDER BY s.n DESC)
          FROM (SELECT chat_tag_id, chat_sub_tag_id, count(*) n
                  FROM chats GROUP BY 1, 2) s), '[]'::jsonb),
      'by_agent', coalesce((
        SELECT jsonb_agg(jsonb_build_object('tag_id', s.chat_tag_id,
                 'key', s.agent, 'name', s.name, 'chats', s.n) ORDER BY s.n DESC)
          FROM (SELECT ch.chat_tag_id, ch.assigned_agent_id AS agent,
                       (SELECT pr.full_name FROM public.profiles pr
                         WHERE pr.user_id = ch.assigned_agent_id
                           AND pr.account_id = v_account) AS name,
                       count(*) n
                  FROM chats ch GROUP BY 1, 2) s), '[]'::jsonb),
      'by_number', coalesce((
        SELECT jsonb_agg(jsonb_build_object('tag_id', s.chat_tag_id,
                 'key', s.channel, 'name', s.name, 'chats', s.n) ORDER BY s.n DESC)
          FROM (SELECT ch.chat_tag_id, ch.channel_id AS channel,
                       (SELECT coalesce(nullif(btrim(w.label), ''),
                                       'Unnamed number' || coalesce(
                                         ' ending ' || nullif(right(regexp_replace(coalesce(w.waba_id, ''), '\D', '', 'g'), 2), ''),
                                         ''))
                          FROM public.whatsapp_config w
                         WHERE w.id = ch.channel_id AND w.account_id = v_account) AS name,
                       count(*) n
                  FROM chats ch GROUP BY 1, 2) s), '[]'::jsonb),
      'by_source', coalesce((
        SELECT jsonb_agg(jsonb_build_object('tag_id', s.chat_tag_id,
                 'key', s.lead_source, 'chats', s.n) ORDER BY s.n DESC)
          FROM (SELECT chat_tag_id, lead_source, count(*) n
                  FROM chats GROUP BY 1, 2) s), '[]'::jsonb),
      'arrivals', coalesce((
        -- Chats that arrived at each tag (and sub-tag) in the period:
        -- one per chat per (tag, sub-tag), however often it came back.
        SELECT jsonb_agg(jsonb_build_object('tag_id', s.to_tag_id,
                 'sub_tag_id', s.to_sub_tag_id, 'chats', s.n) ORDER BY s.n DESC)
          FROM (SELECT to_tag_id, to_sub_tag_id, count(DISTINCT conversation_id) n
                  FROM moves GROUP BY 1, 2) s), '[]'::jsonb),
      'arrivals_daily', coalesce((
        SELECT jsonb_agg(jsonb_build_object('day', s.day, 'tag_id', s.to_tag_id,
                 'chats', s.n) ORDER BY s.day)
          FROM (SELECT to_char((changed_at AT TIME ZONE v_tz)::date, 'YYYY-MM-DD') AS day,
                       to_tag_id, count(DISTINCT conversation_id) n
                  FROM moves GROUP BY 1, 2) s), '[]'::jsonb)
    )
  );
END;
$$;

-- ---------- 9. Escalation sweep: level before the LIMIT ----------

CREATE OR REPLACE FUNCTION public.response_escalation_sweep()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s           record;
  c           record;
  v_mins      integer;
  v_assignee  uuid;
  v_name      text;
  v_leaders   uuid[];
  v_meta      jsonb;
  v_wait      text;
  n_accounts  integer := 0;
  n_failed    integer := 0;
  n_chats     integer := 0;
  n_bells     integer := 0;
  n_trimmed   integer := 0;
BEGIN
  FOR s IN
    SELECT r.account_id, r.timezone, r.hours, r.target_minutes
      FROM public.response_settings r
      JOIN public.accounts a ON a.id = r.account_id
     WHERE r.enabled
       AND a.archived_at IS NULL
  LOOP
    n_accounts := n_accounts + 1;
    BEGIN
      -- Each chat's level is worked out before the LIMIT (256): business
      -- minutes, and whether its assignee is live staff here (else it is
      -- 'unassigned'). Chats under target, or already rung at their
      -- level, are left out so they cannot crowd out newer waits.
      FOR c IN
        SELECT q.id, q.contact_id, q.assigned_agent_id, q.since, q.who, q.mins
          FROM (
            SELECT cv.id, cv.contact_id, cv.assigned_agent_id,
                   cv.customer_waiting_since AS since,
                   coalesce(nullif(btrim(ct.name), ''), ct.phone, 'A customer') AS who,
                   bm.mins,
                   CASE
                     WHEN NOT EXISTS (
                       SELECT 1 FROM public.profiles p
                        WHERE p.user_id = cv.assigned_agent_id
                          AND p.account_id = s.account_id
                          AND p.deactivated_at IS NULL
                          AND p.account_role <> 'bank_guest') THEN 'unassigned'
                     WHEN bm.mins >= 2 * s.target_minutes THEN 'escalated'
                     ELSE 'target'
                   END AS level
              FROM public.conversations cv
              LEFT JOIN public.contacts ct ON ct.id = cv.contact_id
             CROSS JOIN LATERAL (
               SELECT public.response_business_minutes(
                        s.hours, s.timezone, cv.customer_waiting_since, now()) AS mins) bm
             WHERE cv.account_id = s.account_id
               AND cv.customer_waiting_since IS NOT NULL
               AND cv.personal_owner_id IS NULL
               AND cv.status <> 'closed'
               AND cv.customer_waiting_since <= now() - make_interval(mins => s.target_minutes)
               AND cv.customer_waiting_since >= now() - interval '7 days'
               AND NOT EXISTS (
                 SELECT 1 FROM public.response_escalations e
                  WHERE e.conversation_id = cv.id
                    AND e.waiting_since = cv.customer_waiting_since
                    AND e.level = 'escalated')
          ) q
         WHERE q.mins >= s.target_minutes
           AND NOT EXISTS (
             SELECT 1 FROM public.response_escalations e
              WHERE e.conversation_id = q.id
                AND e.waiting_since = q.since
                AND e.level = q.level)
         ORDER BY q.since
         LIMIT 500
      LOOP
        v_mins := c.mins;
        CONTINUE WHEN v_mins < s.target_minutes;
        n_chats := n_chats + 1;
        v_wait := public.response_minutes_label(v_mins);

        -- A live, non-guest assignee in this workspace, else none.
        SELECT p.user_id, coalesce(nullif(btrim(p.full_name), ''), p.email)
          INTO v_assignee, v_name
          FROM public.profiles p
         WHERE p.user_id = c.assigned_agent_id
           AND p.account_id = s.account_id
           AND p.deactivated_at IS NULL
           AND p.account_role <> 'bank_guest'
         LIMIT 1;
        IF NOT FOUND THEN
          v_assignee := NULL;
          v_name := NULL;
        END IF;

        v_meta := jsonb_build_object(
          'waiting_since', c.since,
          'business_minutes', v_mins,
          'target_minutes', s.target_minutes,
          'assignee_id', v_assignee);

        IF v_assignee IS NULL THEN
          n_bells := n_bells + public.response_ring(
            s.account_id, c.id, c.contact_id, c.since, 'unassigned',
            public.response_admins(s.account_id), v_mins,
            'response_unassigned',
            'A customer is waiting and nobody is assigned',
            c.who || ' has waited ' || v_wait || ' (business hours) with no one assigned.',
            v_meta || jsonb_build_object('level', 'unassigned'));
          CONTINUE;
        END IF;

        n_bells := n_bells + public.response_ring(
          s.account_id, c.id, c.contact_id, c.since, 'target',
          ARRAY[v_assignee], v_mins,
          'response_target_missed',
          'A customer is waiting for your reply',
          c.who || ' has waited ' || v_wait || ' (business hours), past the '
            || public.response_minutes_label(s.target_minutes) || ' target.',
          v_meta || jsonb_build_object('level', 'target'));

        IF v_mins >= 2 * s.target_minutes THEN
          SELECT coalesce(array_agg(DISTINCT t.leader_user_id), '{}')
            INTO v_leaders
            FROM public.team_members tm
            JOIN public.teams t ON t.id = tm.team_id AND t.account_id = s.account_id
            JOIN public.profiles lp ON lp.user_id = t.leader_user_id
                                   AND lp.account_id = s.account_id
                                   AND lp.deactivated_at IS NULL
           WHERE tm.account_id = s.account_id
             AND tm.user_id = v_assignee
             AND t.leader_user_id IS NOT NULL
             AND t.leader_user_id <> v_assignee;
          IF cardinality(v_leaders) = 0 THEN
            v_leaders := public.response_admins(s.account_id);
          END IF;
          n_bells := n_bells + public.response_ring(
            s.account_id, c.id, c.contact_id, c.since, 'escalated',
            v_leaders, v_mins,
            'response_escalated',
            'A customer has waited twice the target',
            c.who || ' has waited ' || v_wait || ' (business hours) for '
              || coalesce(v_name, 'their agent') || '.',
            v_meta || jsonb_build_object('level', 'escalated'));
        END IF;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      n_failed := n_failed + 1;
      RAISE WARNING 'response_escalation_sweep: account % failed: % (%)',
        s.account_id, SQLERRM, SQLSTATE;
    END;
  END LOOP;

  DELETE FROM public.response_escalations
   WHERE id IN (SELECT e.id FROM public.response_escalations e
                 WHERE e.created_at < now() - interval '14 days'
                 LIMIT 5000);
  GET DIAGNOSTICS n_trimmed = ROW_COUNT;

  RETURN jsonb_build_object(
    'accounts', n_accounts,
    'failed', n_failed,
    'chats', n_chats,
    'notifications', n_bells,
    'trimmed', n_trimmed);
END $$;

-- ---------- 10. 237's helpers: no PUBLIC / anon ----------

REVOKE ALL ON FUNCTION public.response_default_hours() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.response_hours_valid(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.conversation_waiting_since(public.conversations) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.response_business_minutes(jsonb, text, timestamptz, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.business_minutes_between(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.response_minutes_label(integer) FROM PUBLIC, anon, authenticated;
-- Invoker callers (238's worklist and live view, the CHECK and default
-- on response_settings) run as authenticated.
GRANT EXECUTE ON FUNCTION public.response_default_hours() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.response_hours_valid(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.conversation_waiting_since(public.conversations) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.response_business_minutes(jsonb, text, timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.business_minutes_between(uuid, timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.response_minutes_label(integer) TO service_role;
