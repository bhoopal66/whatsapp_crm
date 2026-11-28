-- ============================================================
-- 334_desk_group_intake.sql — WhatsApp groups linked to a bank, and what
-- became of each file a staff member posts in one (the "CC group wall",
-- slice A: the database only; the inbound hook and the screen follow).
--
--  * A group (114) may be linked to one bank (122's case_banks); several
--    groups may link to the same bank. intake_enabled turns file intake
--    on for the group; replies_enabled (only with intake) lets the app
--    answer the file in the group. Owners, admins and team leaders who
--    can see the group set it (desk_group_link_set); a submission group's
--    mirror (299) is never linked: it is GROUP_NOT_FOUND, as in
--    loadGroupForCaller. The inbound hook reads one group's link with
--    no actor (desk_group_link_for_group).
--  * Who posted: desk_group_staff_for_phone, the one live staff member
--    whose saved number (142's coordinator_phones) is the sender's
--    digits; none or more than one is NULL (never guessed), as 230's
--    desk_staff_for_contact.
--  * desk_group_intake: one row per group message, written only by
--    desk_group_intake_record (first write wins, but a no_copy gives way to
--    a call that brings an intake item). It holds the outcome, a
--    reason code (never free text) and the intake item (220) the file
--    became; the item's state is read live, so a queued file a
--    coordinator later files shows filed (desk_group_outcomes).
--  * Replies: desk_group_reply_claim moves off -> pending at most once
--    per message, only while the link has replies on and the outcome is
--    filed, new_case, queued, duplicate or refused; desk_group_reply_settle
--    records sent or failed. A failed reply is not retried.
--  * The wall (desk_group_wall): per linked group the actor can see, the
--    bank, its primary and second coordinator (232), files of the bank
--    filed today (Asia/Dubai, any channel), its sorting queue and the
--    queue alert with 220's thresholds (2 h second, 4 h lead;
--    no_coordinator when the bank has neither a primary nor a second).
--  * Who sees a group is 299's whatsapp_group_visible_ids with the actor
--    passed in (desk_group_can_see; verify compares the two), staff
--    only: viewers and bank guests see nothing here.
--
-- Refusals (HINT): INVALID, NOT_ALLOWED, GROUP_NOT_FOUND, BANK_NOT_FOUND,
-- NOT_LINKED, GROUP_ALREADY_LINKED.
--
-- PRIVILEGES: SECURITY DEFINER, search_path '', service_role only; the
-- tables force RLS with no policy and no grants. Called with the
-- caller's ACTIVE account (the routes pass ctx.accountId). Apply as a
-- superuser or BYPASSRLS role after 333. Re-runnable. Asserted by
-- supabase/ci/verify-desk-group-intake.sql. docs/case-desk.md is the
-- contract.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '334 must be applied by a superuser or BYPASSRLS role (the desk functions read RLS-forced tables)';
  END IF;
  IF to_regclass('public.desk_bank_roles') IS NULL THEN
    RAISE EXCEPTION '334: apply 232_desk_bank_cover.sql first';
  END IF;
  IF to_regclass('public.whatsapp_group_messages') IS NULL
     OR to_regprocedure('public.staff_removal_phone(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION '334: apply 114_whatsapp_groups.sql and 299_submission_groups_not_groups.sql first';
  END IF;
END $$;

-- ---------- 1. Tables ----------

CREATE TABLE IF NOT EXISTS public.desk_group_links (
  account_id      uuid NOT NULL,
  group_id        uuid NOT NULL,
  bank_code       text NOT NULL,
  intake_enabled  boolean NOT NULL DEFAULT false,
  replies_enabled boolean NOT NULL DEFAULT false,
  updated_by      uuid NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, group_id),
  CONSTRAINT desk_group_links_group_fkey FOREIGN KEY (group_id, account_id)
    REFERENCES public.whatsapp_groups (id, account_id) ON DELETE CASCADE,
  CONSTRAINT desk_group_links_bank_fkey FOREIGN KEY (account_id, bank_code)
    REFERENCES public.case_banks (account_id, code) ON DELETE CASCADE,
  CONSTRAINT desk_group_links_replies_check CHECK (intake_enabled OR NOT replies_enabled)
);
CREATE INDEX IF NOT EXISTS desk_group_links_bank_idx ON public.desk_group_links (account_id, bank_code);
ALTER TABLE public.desk_group_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.desk_group_links FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.desk_group_links FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.desk_group_links IS
  'A WhatsApp group linked to a bank for desk file intake. Written only through desk_group_link_set. Migration 334.';

CREATE TABLE IF NOT EXISTS public.desk_group_intake (
  account_id       uuid NOT NULL,
  group_message_id uuid PRIMARY KEY REFERENCES public.whatsapp_group_messages (id) ON DELETE CASCADE,
  group_id         uuid NOT NULL,
  bank_code        text NOT NULL,
  outcome          text NOT NULL,
  intake_item_id   uuid NULL REFERENCES public.intake_items (id) ON DELETE SET NULL,
  detail           text NULL,
  reply_state      text NOT NULL DEFAULT 'off',
  reply_message_id text NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT desk_group_intake_outcome_check CHECK (outcome IN
    ('filed', 'new_case', 'queued', 'duplicate', 'refused', 'unknown_sender', 'no_copy', 'file_type', 'chat')),
  CONSTRAINT desk_group_intake_detail_check CHECK (detail IS NULL OR detail ~ '^[A-Za-z0-9_]{1,64}$'),
  CONSTRAINT desk_group_intake_reply_state_check CHECK (reply_state IN ('off', 'pending', 'sent', 'failed')),
  CONSTRAINT desk_group_intake_reply_id_check CHECK (
    reply_message_id IS NULL OR char_length(reply_message_id) BETWEEN 1 AND 200)
);
CREATE INDEX IF NOT EXISTS desk_group_intake_group_idx ON public.desk_group_intake (account_id, group_id, created_at);
CREATE INDEX IF NOT EXISTS desk_group_intake_item_idx ON public.desk_group_intake (intake_item_id)
  WHERE intake_item_id IS NOT NULL;
ALTER TABLE public.desk_group_intake ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.desk_group_intake FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.desk_group_intake FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.desk_group_intake IS
  'What became of a file posted in a linked group: outcome, reason code, intake item, reply state. No text, no number. Written only through desk_group_intake_record and the reply claim/settle. Migration 334.';

-- ---------- 2. Who sees a group ----------

-- A submission group's mirror (same account and WhatsApp id, 299).
CREATE OR REPLACE FUNCTION public.desk_group_is_mirror(p_account uuid, p_group uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.whatsapp_groups g
                   JOIN public.submission_groups s ON s.account_id = g.account_id AND s.wa_group_id = g.wa_group_id
                  WHERE g.id = p_group AND g.account_id = p_account)
$$;

-- 299's whatsapp_group_visible_ids with the actor passed in, for live
-- staff of p_account (agent and up): owner/admin every group; else the
-- groups created or managed by the actor or, for a team leader, by a
-- person in a team they lead. Never a submission group's mirror.
CREATE OR REPLACE FUNCTION public.desk_group_can_see(p_actor uuid, p_account uuid, p_group uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH r AS (SELECT public.case_account_role(p_account, p_actor) AS role),
  ppl AS (
    SELECT p_actor AS user_id
    UNION
    SELECT tm.user_id
      FROM public.teams t
      JOIN public.team_members tm ON tm.team_id = t.id AND tm.account_id = t.account_id, r
     WHERE r.role = 'team_lead' AND t.account_id = p_account AND t.leader_user_id = p_actor
  )
  SELECT EXISTS (
    SELECT 1 FROM public.whatsapp_groups g, r
     WHERE g.id = p_group AND g.account_id = p_account AND r.role IS NOT NULL
       AND (r.role IN ('admin', 'super_admin')
            OR g.created_by IN (SELECT ppl.user_id FROM ppl)
            OR EXISTS (SELECT 1 FROM public.whatsapp_group_managers m
                        WHERE m.group_id = g.id AND m.account_id = p_account
                          AND m.user_id IN (SELECT ppl.user_id FROM ppl)))
       AND NOT public.desk_group_is_mirror(p_account, g.id))
$$;

-- ---------- 3. Links ----------

-- Owner / admin / team leader who can see the group: link it to a bank
-- (NULL bank removes the link). Replies only with intake.
CREATE OR REPLACE FUNCTION public.desk_group_link_set(p_actor uuid, p_account uuid, p_group uuid, p_bank_code text,
  p_intake boolean, p_replies boolean, p_now timestamptz DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor) IN ('team_lead', 'admin', 'super_admin'), false) IS NOT TRUE THEN
    PERFORM public.desk_refuse('desk_group_link_set', 'NOT_ALLOWED', 'owners, admins and team leaders only');
  END IF;
  IF p_group IS NULL OR NOT public.desk_group_can_see(p_actor, p_account, p_group) THEN
    PERFORM public.desk_refuse('desk_group_link_set', 'GROUP_NOT_FOUND', 'a group of this workspace you can see');
  END IF;
  IF p_bank_code IS NULL THEN
    DELETE FROM public.desk_group_links l WHERE l.account_id = p_account AND l.group_id = p_group;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.case_banks b WHERE b.account_id = p_account AND b.code = p_bank_code) THEN
    PERFORM public.desk_refuse('desk_group_link_set', 'BANK_NOT_FOUND', 'a bank of this workspace');
  END IF;
  IF p_intake IS NULL OR p_replies IS NULL OR (p_replies AND NOT p_intake) THEN
    PERFORM public.desk_refuse('desk_group_link_set', 'INVALID', 'replies only with intake on');
  END IF;
  -- Each of our numbers keeps its own whatsapp_groups row for one WhatsApp
  -- group and message ids differ per gateway: a second linked row would
  -- file and reply twice.
  IF EXISTS (SELECT 1 FROM public.whatsapp_groups g, public.whatsapp_groups o, public.desk_group_links ol WHERE g.id = p_group AND g.account_id = p_account AND o.account_id = g.account_id AND o.wa_group_id = g.wa_group_id AND o.id <> g.id AND ol.account_id = o.account_id AND ol.group_id = o.id) THEN
    PERFORM public.desk_refuse('desk_group_link_set', 'GROUP_ALREADY_LINKED', 'a group not linked through another of our numbers');
  END IF;
  INSERT INTO public.desk_group_links AS l (account_id, group_id, bank_code, intake_enabled, replies_enabled,
                                            updated_by, updated_at)
  VALUES (p_account, p_group, p_bank_code, p_intake, p_replies, p_actor, coalesce(p_now, now()))
  ON CONFLICT (account_id, group_id) DO UPDATE
     SET bank_code = excluded.bank_code, intake_enabled = excluded.intake_enabled,
         replies_enabled = excluded.replies_enabled, updated_by = excluded.updated_by,
         updated_at = excluded.updated_at;
END;
$$;

-- Staff: the links of the groups the actor can see.
CREATE OR REPLACE FUNCTION public.desk_group_link_list(p_actor uuid, p_account uuid)
RETURNS TABLE (group_id uuid, group_name text, bank_code text, bank_name text, intake_enabled boolean,
               replies_enabled boolean, updated_by uuid, updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF public.case_account_role(p_account, p_actor) IS NULL THEN
    PERFORM public.desk_refuse('desk_group_link_list', 'NOT_ALLOWED', 'not staff of this workspace');
  END IF;
  RETURN QUERY
  SELECT l.group_id, g.name, l.bank_code, b.name, l.intake_enabled, l.replies_enabled, l.updated_by, l.updated_at
    FROM public.desk_group_links l
    JOIN public.whatsapp_groups g ON g.id = l.group_id AND g.account_id = l.account_id
    JOIN public.case_banks b ON b.account_id = l.account_id AND b.code = l.bank_code
   WHERE l.account_id = p_account AND public.desk_group_can_see(p_actor, p_account, l.group_id)
   ORDER BY g.name, l.group_id;
END;
$$;

-- The inbound hook (no actor): one group's link, or no row for an
-- unlinked group or a submission group's mirror.
CREATE OR REPLACE FUNCTION public.desk_group_link_for_group(p_account uuid, p_group uuid)
RETURNS TABLE (bank_code text, intake_enabled boolean, replies_enabled boolean, bank_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT l.bank_code, l.intake_enabled, l.replies_enabled, b.name
    FROM public.desk_group_links l
    JOIN public.case_banks b ON b.account_id = l.account_id AND b.code = l.bank_code
   WHERE l.account_id = p_account AND l.group_id = p_group
     AND NOT public.desk_group_is_mirror(p_account, p_group)
$$;

-- ---------- 4. Who posted ----------

-- The one live staff member (agent and up, not deactivated) whose saved
-- number is these digits, or NULL (none, or more than one: never guessed).
CREATE OR REPLACE FUNCTION public.desk_group_staff_for_phone(p_account uuid, p_digits text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE WHEN count(*) = 1 THEN min(p.user_id::text)::uuid END
    FROM public.coordinator_phones p
   WHERE p.account_id = p_account
     AND regexp_replace(coalesce(p_digits, ''), '[^0-9]', '', 'g') <> ''
     AND regexp_replace(p.phone, '[^0-9]', '', 'g') = regexp_replace(coalesce(p_digits, ''), '[^0-9]', '', 'g')
     AND public.case_account_role(p_account, p.user_id) IS NOT NULL
$$;

-- ---------- 5. Recording a group file ----------

-- The inbound hook: what became of a group message. First write wins;
-- answers the stored outcome (a no_copy gives way to a call that brings an
-- intake item). The group must be linked (not a mirror).
CREATE OR REPLACE FUNCTION public.desk_group_intake_record(p_account uuid, p_group_message_id uuid, p_outcome text,
  p_intake_item_id uuid, p_detail text, p_now timestamptz DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_group uuid;
  v_bank  text;
  v_out   text;
BEGIN
  SELECT m.group_id INTO v_group FROM public.whatsapp_group_messages m
   WHERE m.id = p_group_message_id AND m.account_id = p_account;
  IF v_group IS NULL
     OR p_outcome IS NULL
     OR p_outcome NOT IN ('filed', 'new_case', 'queued', 'duplicate', 'refused', 'unknown_sender', 'no_copy',
                          'file_type', 'chat')
     OR (p_detail IS NOT NULL AND p_detail !~ '^[A-Za-z0-9_]{1,64}$')
     OR (p_intake_item_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM public.intake_items i WHERE i.id = p_intake_item_id AND i.account_id = p_account)) THEN
    PERFORM public.desk_refuse('desk_group_intake_record', 'INVALID',
      'a group message and intake item of this workspace, a known outcome and a reason code');
  END IF;
  SELECT l.bank_code INTO v_bank FROM public.desk_group_links l
   WHERE l.account_id = p_account AND l.group_id = v_group;
  IF v_bank IS NULL OR public.desk_group_is_mirror(p_account, v_group) THEN
    PERFORM public.desk_refuse('desk_group_intake_record', 'NOT_LINKED', 'the group is not linked to a bank');
  END IF;
  INSERT INTO public.desk_group_intake (account_id, group_message_id, group_id, bank_code, outcome, intake_item_id,
                                        detail, created_at, updated_at)
  VALUES (p_account, p_group_message_id, v_group, v_bank, p_outcome, p_intake_item_id, p_detail,
          coalesce(p_now, now()), coalesce(p_now, now()))
  ON CONFLICT (group_message_id) DO NOTHING;
  -- A no_copy is the one outcome that may be superseded: the copy of the
  -- file can arrive later, and a retry that files it must not be locked out.
  IF p_intake_item_id IS NOT NULL THEN
    UPDATE public.desk_group_intake d
       SET outcome = p_outcome, intake_item_id = p_intake_item_id, detail = p_detail,
           updated_at = coalesce(p_now, now())
     WHERE d.group_message_id = p_group_message_id AND d.account_id = p_account AND d.outcome = 'no_copy';
  END IF;
  SELECT d.outcome INTO v_out FROM public.desk_group_intake d
   WHERE d.group_message_id = p_group_message_id AND d.account_id = p_account;
  RETURN v_out;
END;
$$;

-- off -> pending, at most once per message: only while the group's link
-- has replies on, and only for an outcome the group is told of (not chat,
-- unknown_sender, no_copy or file_type). The row lock of the UPDATE makes
-- two callers race to one winner.
CREATE OR REPLACE FUNCTION public.desk_group_reply_claim(p_account uuid, p_group_message_id uuid,
  p_now timestamptz DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.desk_group_intake d
     SET reply_state = 'pending', updated_at = coalesce(p_now, now())
   WHERE d.group_message_id = p_group_message_id AND d.account_id = p_account
     AND d.reply_state = 'off'
     AND d.outcome IN ('filed', 'new_case', 'queued', 'duplicate', 'refused')
     AND EXISTS (SELECT 1 FROM public.desk_group_links l
                  WHERE l.account_id = d.account_id AND l.group_id = d.group_id
                    AND l.intake_enabled AND l.replies_enabled)
     AND NOT public.desk_group_is_mirror(d.account_id, d.group_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

-- pending -> sent (with our reply's WhatsApp id) or failed. True when it
-- settled a pending claim.
CREATE OR REPLACE FUNCTION public.desk_group_reply_settle(p_account uuid, p_group_message_id uuid, p_ok boolean,
  p_reply_message_id text, p_now timestamptz DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_ok IS NULL OR (p_reply_message_id IS NOT NULL AND char_length(p_reply_message_id) NOT BETWEEN 1 AND 200) THEN
    PERFORM public.desk_refuse('desk_group_reply_settle', 'INVALID', 'an outcome and a WhatsApp message id');
  END IF;
  UPDATE public.desk_group_intake d
     SET reply_state = CASE WHEN p_ok THEN 'sent' ELSE 'failed' END,
         reply_message_id = CASE WHEN p_ok THEN p_reply_message_id END,
         updated_at = coalesce(p_now, now())
   WHERE d.group_message_id = p_group_message_id AND d.account_id = p_account AND d.reply_state = 'pending';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

-- ---------- 6. Reading ----------

-- Staff: one row per linked group among p_group_ids that the actor can
-- see (others silently omitted). 220's thresholds: 2 h second, 4 h lead.
CREATE OR REPLACE FUNCTION public.desk_group_wall(p_actor uuid, p_account uuid, p_group_ids uuid[],
  p_now timestamptz DEFAULT NULL)
RETURNS TABLE (group_id uuid, bank_code text, bank_name text, short_code text, primary_name text,
               second_name text, filed_today bigint, to_sort bigint, oldest_age_seconds bigint, alert text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  c_second constant integer := 2 * 3600;
  c_lead   constant integer := 4 * 3600;
  v_now    timestamptz := coalesce(p_now, now());
  v_day    date := public.desk_today(coalesce(p_now, now()));
BEGIN
  IF public.case_account_role(p_account, p_actor) IS NULL THEN
    PERFORM public.desk_refuse('desk_group_wall', 'NOT_ALLOWED', 'not staff of this workspace');
  END IF;
  IF coalesce(cardinality(p_group_ids), 0) > 500 THEN
    PERFORM public.desk_refuse('desk_group_wall', 'INVALID', 'at most 500 groups');
  END IF;
  RETURN QUERY
  WITH l AS (
    SELECT x.group_id AS grp, x.bank_code AS bank
      FROM public.desk_group_links x
     WHERE x.account_id = p_account AND x.group_id = ANY (coalesce(p_group_ids, '{}'::uuid[]))
       AND public.desk_group_can_see(p_actor, p_account, x.group_id)
  ), banks AS (
    SELECT DISTINCT l.bank FROM l
  ), q AS (
    SELECT i.queue_bank_code AS bank, count(*) AS n, min(i.received_at) AS oldest
      FROM public.intake_items i
     WHERE i.account_id = p_account AND i.state = 'untagged' AND i.queue_bank_code IN (SELECT banks.bank FROM banks)
     GROUP BY i.queue_bank_code
  ), f AS (
    SELECT c.bank_code AS bank, count(*) AS n
      FROM public.intake_items i
      JOIN public.cases c ON c.id = i.filed_case_id
     WHERE i.account_id = p_account AND i.state = 'filed' AND i.decided_at IS NOT NULL
       AND public.desk_today(i.decided_at) = v_day
       AND c.bank_code IN (SELECT banks.bank FROM banks)
     GROUP BY c.bank_code
  ), roles AS (
    SELECT r.bank_code AS bank,
           max(p.full_name) FILTER (WHERE r.role = 'primary') AS pri,
           max(p.full_name) FILTER (WHERE r.role = 'second') AS sec,
           count(*) AS n
      FROM public.desk_bank_roles r
      LEFT JOIN public.profiles p ON p.user_id = r.user_id AND p.account_id = r.account_id
     WHERE r.account_id = p_account AND r.bank_code IN (SELECT banks.bank FROM banks)
     GROUP BY r.bank_code
  )
  SELECT l.grp, l.bank, b.name, x.short_code, ro.pri, ro.sec,
         coalesce(f.n, 0)::bigint, coalesce(q.n, 0)::bigint,
         CASE WHEN q.oldest IS NULL THEN NULL ELSE floor(extract(epoch FROM v_now - q.oldest))::bigint END,
         CASE
           WHEN coalesce(ro.n, 0) = 0 THEN 'no_coordinator'
           WHEN q.oldest IS NOT NULL AND v_now - q.oldest >= make_interval(secs => c_lead) THEN 'lead'
           WHEN q.oldest IS NOT NULL AND v_now - q.oldest >= make_interval(secs => c_second) THEN 'second'
           ELSE 'none'
         END
    FROM l
    JOIN public.case_banks b ON b.account_id = p_account AND b.code = l.bank
    LEFT JOIN public.desk_bank_codes x ON x.account_id = p_account AND x.bank_code = l.bank
    LEFT JOIN q ON q.bank = l.bank
    LEFT JOIN f ON f.bank = l.bank
    LEFT JOIN roles ro ON ro.bank = l.bank
   ORDER BY array_position(p_group_ids, l.grp);
END;
$$;

-- Staff: the recorded outcome of messages in groups the actor can see,
-- with the intake item's CURRENT state (a queued file a coordinator
-- filed later reads filed). At most 500 ids.
CREATE OR REPLACE FUNCTION public.desk_group_outcomes(p_actor uuid, p_account uuid, p_message_ids uuid[])
RETURNS TABLE (group_message_id uuid, outcome text, detail text, reply_state text, item_state text,
               case_number text, caption_code text, doc_key text, queue_reason text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF public.case_account_role(p_account, p_actor) IS NULL THEN
    PERFORM public.desk_refuse('desk_group_outcomes', 'NOT_ALLOWED', 'not staff of this workspace');
  END IF;
  IF coalesce(cardinality(p_message_ids), 0) > 500 THEN
    PERFORM public.desk_refuse('desk_group_outcomes', 'INVALID', 'at most 500 messages');
  END IF;
  RETURN QUERY
  SELECT d.group_message_id, d.outcome, d.detail, d.reply_state, i.state, c.case_number,
         CASE WHEN a.id IS NOT NULL THEN public.desk_caption_code(a.seq, split_part(c.case_number, '-', 4)) END,
         coalesce(i.filed_doc_key, i.doc_key), i.queue_reason
    FROM public.desk_group_intake d
    LEFT JOIN public.intake_items i ON i.id = d.intake_item_id AND i.account_id = d.account_id
    LEFT JOIN public.cases c ON c.id = i.filed_case_id
    LEFT JOIN public.desk_applications a ON a.id = c.desk_application_id
   WHERE d.account_id = p_account AND d.group_message_id = ANY (coalesce(p_message_ids, '{}'::uuid[]))
     AND public.desk_group_can_see(p_actor, p_account, d.group_id)
   ORDER BY d.created_at, d.group_message_id;
END;
$$;

-- ---------- 7. Privileges ----------

REVOKE ALL ON FUNCTION
  public.desk_group_is_mirror(uuid, uuid), public.desk_group_can_see(uuid, uuid, uuid),
  public.desk_group_link_set(uuid, uuid, uuid, text, boolean, boolean, timestamptz),
  public.desk_group_link_list(uuid, uuid), public.desk_group_link_for_group(uuid, uuid),
  public.desk_group_staff_for_phone(uuid, text),
  public.desk_group_intake_record(uuid, uuid, text, uuid, text, timestamptz),
  public.desk_group_reply_claim(uuid, uuid, timestamptz),
  public.desk_group_reply_settle(uuid, uuid, boolean, text, timestamptz),
  public.desk_group_wall(uuid, uuid, uuid[], timestamptz), public.desk_group_outcomes(uuid, uuid, uuid[])
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.desk_group_link_set(uuid, uuid, uuid, text, boolean, boolean, timestamptz),
  public.desk_group_link_list(uuid, uuid), public.desk_group_link_for_group(uuid, uuid),
  public.desk_group_staff_for_phone(uuid, text),
  public.desk_group_intake_record(uuid, uuid, text, uuid, text, timestamptz),
  public.desk_group_reply_claim(uuid, uuid, timestamptz),
  public.desk_group_reply_settle(uuid, uuid, boolean, text, timestamptz),
  public.desk_group_wall(uuid, uuid, uuid[], timestamptz), public.desk_group_outcomes(uuid, uuid, uuid[])
TO service_role;
