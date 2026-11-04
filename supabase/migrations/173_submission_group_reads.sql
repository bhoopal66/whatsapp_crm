-- ============================================================
-- 173_submission_group_reads.sql — unread counts and a bell for
-- submission groups, the case agent's team leader in the group, and
-- WhatsApp groups an admin deleted staying deleted.
--
--  * submission_group_reads: (group_id, user_id) -> last_read_at, as
--    146's whatsapp_group_reads. Moved forward only, by sg_mark_read,
--    which refuses (42501) a group outside sg_visible_ids().
--  * sg_unread_by_group() / sg_unread_count(): inbound messages after
--    the marker in the caller's ACTIVE wa_mode 'group' groups of the
--    active workspace. created_at is the arrival time here:
--    sg_record_inbound names no created_at and WhatsApp's send time is
--    wa_timestamp, so 146's received_at problem does not arise. No
--    marker: read up to 7 days ago (146's rule).
--  * SECURITY DEFINER, unlike 146's count. The tables are RLS-forced
--    and each of the three policies runs sg_visible_ids(), which calls
--    per-group role functions; as invoker that set is computed once per
--    table. Here it is computed once and the plan starts from it. The
--    functions name the account, the caller and the messages policy's
--    NOT post_end themselves. (group_id, created_at, id) of 115 already
--    serves the range scan, so no new index: the direction filter only
--    touches rows after the marker.
--  * sg_leads_group_agent(group, user): a live team_leader leading a
--    team the case's agent is a member of (case_role's team_lead rule,
--    122/161). On an ACTIVE group: a real open row keeps its own label;
--    else such a leader counts as an open 'team_lead' row; else a bank
--    holder as an open 'coordinator' row (163). sg_resolve_role,
--    sg_read_role, sg_can_send and sg_visible_ids change together;
--    ENDED groups are unchanged, the archive stays with the list. The
--    rule is live: no access rows are written. TS mirrors:
--    lib/submission-groups/store.ts (openAccessLabel, bankHolderLabel).
--  * The bell: notification type submission_group_message, rung by the
--    AFTER INSERT trigger submission_group_messages_ring for a
--    customer's message on an ACTIVE group, to live staff with an open
--    'agent' / 'coordinator' row and live holders of the case's bank.
--    One unread bell per person per group: concurrent inserts into a
--    group already queue on 115's FOR NO KEY UPDATE of the group row,
--    so the second sees the first's bell, and a redelivery inserts no
--    row (ON CONFLICT DO NOTHING). idx_notifications_user_unread serves
--    the lookup. The bell carries the group's customer_name (else
--    submission_ref), never the message. A failure is a WARNING; it
--    never loses the message. 109's push_on_notification pushes it like
--    any non-chat_* type under the kind submission_group_message;
--    push_bell_url sends it to /submission-groups/<id>. Change together:
--    notifications_type_check, push_bell_url, hrefFor, PUSH_KINDS,
--    kindGroup.
--  * whatsapp_group_tombstones: a group an admin deleted, so an admin
--    Sync or a webhook does not bring it back. Service role only. No FK
--    to whatsapp_groups (the row is gone) or to the channel.
--  * whatsapp_group_unread_count() skips rows mirroring a submission
--    group. It becomes SECURITY DEFINER: submission_groups is RLS-forced
--    to the caller's ACTIVE groups, so as invoker the exclusion would
--    miss every group the caller cannot see and every ENDED one, and
--    the mirror would still count. It already names the account and
--    the visible set.
--
-- The SECURITY DEFINER functions read RLS-forced tables, so, as in
-- 115, this must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE … IF NOT EXISTS, CREATE OR REPLACE with the same
-- signatures (older grants stay), DROP … IF EXISTS. Asserted by
-- supabase/ci/verify-submission-group-reads.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '173 must be applied by a superuser or BYPASSRLS role (the functions read and write RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. The markers ----------

CREATE TABLE IF NOT EXISTS public.submission_group_reads (
  group_id     uuid NOT NULL,
  account_id   uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL,
  PRIMARY KEY (group_id, user_id),
  CONSTRAINT submission_group_reads_group_fkey FOREIGN KEY (group_id, account_id)
    REFERENCES public.submission_groups (id, account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS submission_group_reads_user_idx
  ON public.submission_group_reads (user_id, account_id);

COMMENT ON TABLE public.submission_group_reads IS
  'Per-person read marker of a submission group (auth.users ids). Written only by sg_mark_read, forward-only. Migration 173.';
COMMENT ON COLUMN public.submission_group_reads.last_read_at IS
  'When the person last opened the group (our clock). An inbound message whose created_at (arrival here) is later is unread for them.';

ALTER TABLE public.submission_group_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submission_group_reads FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS submission_group_reads_select ON public.submission_group_reads;
CREATE POLICY submission_group_reads_select ON public.submission_group_reads FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- A new public table starts with every privilege for anon and
-- authenticated (TRUNCATE skips RLS): start from nothing.
REVOKE ALL ON public.submission_group_reads FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.submission_group_reads TO authenticated;
GRANT SELECT ON public.submission_group_reads TO service_role;

-- ---------- 2. Leading the case's agent ----------

CREATE OR REPLACE FUNCTION public.sg_leads_group_agent(p_group uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_user IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.cases c
      JOIN public.profiles p
        ON p.user_id = p_user AND p.account_id = c.account_id
       AND p.deactivated_at IS NULL AND p.account_role = 'team_leader'
      JOIN public.teams t
        ON t.account_id = c.account_id AND t.leader_user_id = p_user
      JOIN public.team_members m
        ON m.team_id = t.id AND m.account_id = c.account_id AND m.user_id = c.agent_id
     WHERE c.group_id = p_group)
$$;

REVOKE ALL ON FUNCTION public.sg_leads_group_agent(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sg_leads_group_agent(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.sg_leads_group_agent(uuid, uuid) IS
  'Is p_user a live team_leader leading a team the agent of the case of group p_group is a member of (case_role''s team_lead rule)? On an ACTIVE group that counts as an open ''team_lead'' access row. Migration 173.';

-- ---------- 3. Role resolvers (163's bodies plus the leader) ----------

-- 'owner'/'admin' if an archive reader, else the open access label,
-- else on an ACTIVE group 'team_lead' for a leader of the case's agent,
-- else 'coordinator' for a holder of its bank.
CREATE OR REPLACE FUNCTION public.sg_resolve_role(p_group uuid, p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(public.sg_archive_role(g.account_id, p_user),
                  (SELECT a.label FROM public.submission_group_access a
                    WHERE a.group_id = g.id AND a.user_id = p_user AND a.removed_at IS NULL),
                  CASE WHEN g.status = 'ACTIVE' AND public.sg_leads_group_agent(g.id, p_user)
                       THEN 'team_lead'
                       WHEN g.status = 'ACTIVE' AND public.sg_holds_group_bank(g.id, p_user)
                       THEN 'coordinator' END)
    FROM public.submission_groups g WHERE g.id = p_group
$$;

-- On an ACTIVE group with no open row, leading the case's agent reads
-- as an open 'team_lead' row and holding its bank as an open
-- 'coordinator' row. ENDED unchanged.
CREATE OR REPLACE FUNCTION public.sg_read_role(p_group uuid, p_user uuid, p_now timestamptz, p_window_days int)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  g      public.submission_groups%ROWTYPE;
  v_role text;
  v_open boolean := false;
BEGIN
  SELECT * INTO g FROM public.submission_groups WHERE id = p_group;
  IF NOT FOUND OR p_user IS NULL THEN
    RETURN NULL;
  END IF;
  v_role := public.sg_archive_role(g.account_id, p_user);
  IF v_role IS NULL AND public.sg_is_staff(g.account_id, p_user) THEN
    IF g.status = 'ACTIVE' THEN
      SELECT a.label INTO v_role FROM public.submission_group_access a
       WHERE a.group_id = g.id AND a.user_id = p_user AND a.removed_at IS NULL;
      IF v_role IS NULL AND public.sg_leads_group_agent(g.id, p_user) THEN
        v_role := 'team_lead';
      END IF;
      IF v_role IS NULL AND public.sg_holds_group_bank(g.id, p_user) THEN
        v_role := 'coordinator';
      END IF;
      v_open := v_role IS NOT NULL;
    ELSE
      SELECT a.label INTO v_role FROM public.submission_group_access a
       WHERE a.group_id = g.id AND a.user_id = p_user
         AND a.added_at <= g.ended_at AND (a.removed_at IS NULL OR a.removed_at >= g.ended_at)
       ORDER BY a.added_at DESC LIMIT 1;
    END IF;
  END IF;
  IF public.sg_rule_can_read(g.status, v_role, v_open, v_role IS NOT NULL, g.ended_at,
                             coalesce(p_now, now()), p_window_days) THEN
    RETURN v_role;
  END IF;
  RETURN NULL;
END;
$$;

-- ACTIVE, live staff, and on the open list, leading the case's agent or
-- holding the case's bank. sg_send_begin calls this and reads no label.
CREATE OR REPLACE FUNCTION public.sg_can_send(p_group uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce((
    SELECT g.status = 'ACTIVE'
       AND public.sg_is_staff(g.account_id, p_user)
       AND (EXISTS (SELECT 1 FROM public.submission_group_access a
                     WHERE a.group_id = g.id AND a.user_id = p_user AND a.removed_at IS NULL)
            OR public.sg_leads_group_agent(g.id, p_user)
            OR public.sg_holds_group_bank(g.id, p_user))
      FROM public.submission_groups g WHERE g.id = p_group), false)
$$;

-- ACTIVE groups of the active workspace that the caller is on the open
-- list of, leads the case's agent of, or holds the case's bank of,
-- while live staff; all of them for an owner/admin.
CREATE OR REPLACE FUNCTION public.sg_visible_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT g.id FROM public.submission_groups g
   WHERE g.account_id = public.current_account_id()
     AND g.status = 'ACTIVE'
     AND (public.is_account_member(g.account_id, 'admin')
          OR (public.sg_is_staff(g.account_id, auth.uid())
              AND (EXISTS (SELECT 1 FROM public.submission_group_access a
                            WHERE a.group_id = g.id AND a.user_id = auth.uid() AND a.removed_at IS NULL)
                   OR public.sg_leads_group_agent(g.id, auth.uid())
                   OR public.sg_holds_group_bank(g.id, auth.uid()))))
$$;

-- ---------- 4. Mark read, and the counts ----------

CREATE OR REPLACE FUNCTION public.sg_mark_read(p_group uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_acct uuid;
BEGIN
  -- A refusal, not a silent no-op, as 146: a caller that cannot see the
  -- group has a bug (or a stale tab after a workspace switch).
  IF v_uid IS NULL OR p_group IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.sg_visible_ids() v(id) WHERE v.id = p_group) THEN
    RAISE EXCEPTION 'not_visible: this group is not visible to you'
      USING ERRCODE = '42501';
  END IF;
  SELECT g.account_id INTO v_acct FROM public.submission_groups g WHERE g.id = p_group;

  INSERT INTO public.submission_group_reads AS r (group_id, account_id, user_id, last_read_at)
  VALUES (p_group, v_acct, v_uid, now())
  ON CONFLICT (group_id, user_id) DO UPDATE
    SET last_read_at = greatest(r.last_read_at, EXCLUDED.last_read_at);
END
$$;
COMMENT ON FUNCTION public.sg_mark_read(uuid) IS
  'Moves the caller''s read marker of a submission group to now (never back). Refuses 42501 unless the group is in sg_visible_ids() (ACTIVE groups only). Migration 173.';

CREATE OR REPLACE FUNCTION public.sg_unread_by_group()
RETURNS TABLE (group_id uuid, unread integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT g.id, count(*)::integer
    FROM public.sg_visible_ids() v(id)
    JOIN public.submission_groups g ON g.id = v.id
    LEFT JOIN public.submission_group_reads r
      ON r.group_id = g.id AND r.user_id = auth.uid()
    JOIN public.submission_group_messages m
      ON m.group_id = g.id
     AND m.direction = 'in'
     AND NOT m.post_end
     AND m.created_at > coalesce(r.last_read_at, now() - interval '7 days')
   WHERE g.account_id = public.current_account_id()
     AND g.status = 'ACTIVE'
     AND g.wa_mode = 'group'
   GROUP BY g.id
$$;
COMMENT ON FUNCTION public.sg_unread_by_group() IS
  'The caller''s visible ACTIVE wa_mode ''group'' groups of the active workspace with inbound messages after their marker (no marker reads as 7 days ago), with the count. SECURITY DEFINER so sg_visible_ids() runs once. Migration 173.';

CREATE OR REPLACE FUNCTION public.sg_unread_count()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(sum(u.unread), 0)::integer FROM public.sg_unread_by_group() u
$$;
COMMENT ON FUNCTION public.sg_unread_count() IS
  'Sum of sg_unread_by_group(): unread messages, not groups; 0 when none. Migration 173.';

REVOKE ALL ON FUNCTION public.sg_mark_read(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sg_unread_by_group() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sg_unread_count() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sg_mark_read(uuid),
  public.sg_unread_by_group(),
  public.sg_unread_count()
  TO authenticated, service_role;

-- ---------- 5. The bell ----------

-- 153's list plus submission_group_message; a later type edits it here.
ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned',
    'channel_disconnected',
    'channel_reconnected',
    'team_activity_alert',
    'ai_handoff',
    'task_assigned',
    'task_due',
    'chat_mention',
    'chat_dm',
    'chat_thread_reply',
    'chat_broadcast',
    'call_missed',
    'callback_requested',
    'deal_room_join_request',
    'deal_room_update',
    'call_outcome_due',
    'pbx_connection_silent',
    'pbx_connection_restored',
    'meeting_invite',
    'calendar_invite',
    'calendar_update',
    'calendar_cancelled',
    'calendar_response',
    'event_reminder',
    'meeting_reminder',
    'group_join_request',
    'conversation_shared',
    'insight_attention',
    'submission_group_message'
  ));

-- Restates 153's push_bell_url with that one type added; change it
-- together with hrefFor in src/lib/notifications/target.ts.
CREATE OR REPLACE FUNCTION public.push_bell_url(n public.notifications)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_role    text;
  v_chat    text := CASE WHEN n.conversation_id IS NOT NULL THEN '/inbox?c=' || n.conversation_id END;
  v_contact text;
BEGIN
  SELECT p.account_role::text INTO v_role FROM public.profiles p
   WHERE p.user_id = n.user_id AND p.account_id = n.account_id AND p.deactivated_at IS NULL;
  CASE
    WHEN n.type IN ('conversation_assigned', 'ai_handoff', 'conversation_shared',
                    'insight_attention') THEN
      RETURN coalesce(v_chat, '/notifications');
    WHEN n.type IN ('task_assigned', 'task_due') THEN
      RETURN coalesce('/contacts/' || n.contact_id, v_chat, '/calls');
    WHEN n.type IN ('call_missed', 'callback_requested', 'call_outcome_due') THEN
      v_contact := coalesce(n.contact_id::text, n.meta ->> 'contact_id');
      RETURN CASE WHEN public.push_is_uuid(v_contact) THEN '/contacts/' || v_contact ELSE '/calls' END;
    WHEN n.type IN ('deal_room_join_request', 'deal_room_update') THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> 'room_id')
                  THEN '/chat/rooms/' || (n.meta ->> 'room_id') ELSE '/notifications' END;
    WHEN n.type IN ('channel_disconnected', 'channel_reconnected') THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin') THEN '/settings?tab=whatsapp' ELSE '/notifications' END;
    WHEN n.type IN ('pbx_connection_silent', 'pbx_connection_restored') THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin') THEN '/settings?tab=phone-system' ELSE '/notifications' END;
    WHEN n.type = 'team_activity_alert' THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin', 'team_leader') THEN '/team-activity' ELSE '/notifications' END;
    WHEN n.type = 'meeting_invite' THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> 'meeting_id')
                  THEN '/meetings/' || (n.meta ->> 'meeting_id') ELSE '/notifications' END;
    WHEN n.type = 'submission_group_message' THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> 'group_id')
                  THEN '/submission-groups/' || (n.meta ->> 'group_id') ELSE '/notifications' END;
    ELSE
      RETURN '/notifications';
  END CASE;
END $$;

REVOKE ALL ON FUNCTION public.push_bell_url(public.notifications) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sg_ring_customer_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_who text;
BEGIN
  IF NEW.direction IS DISTINCT FROM 'in' OR NEW.sender_kind IS DISTINCT FROM 'customer' OR NEW.post_end THEN
    RETURN NULL;
  END IF;
  BEGIN
    -- The customer's name, never NEW.body: a bell and its push show on
    -- a lock screen.
    SELECT CASE WHEN g.customer_name IS NULL OR g.customer_name ~ '^[[:space:]]*$'
                THEN g.submission_ref ELSE g.customer_name END
      INTO v_who
      FROM public.submission_groups g
     WHERE g.id = NEW.group_id AND g.status = 'ACTIVE';
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;

    INSERT INTO public.notifications (account_id, user_id, type, title, body, meta)
    SELECT NEW.account_id, w.user_id, 'submission_group_message',
           'Customer message: ' || v_who, 'New message in the submission group',
           jsonb_build_object('group_id', NEW.group_id)
      FROM (SELECT a.user_id FROM public.submission_group_access a
             WHERE a.group_id = NEW.group_id AND a.removed_at IS NULL
               AND a.label IN ('agent', 'coordinator')
               AND public.sg_is_staff(NEW.account_id, a.user_id)
            UNION
            SELECT b.user_id FROM public.cases c
              JOIN public.coordinator_banks b
                ON b.account_id = c.account_id AND b.bank_code = c.bank_code
             WHERE c.group_id = NEW.group_id
               AND public.sg_holds_group_bank(NEW.group_id, b.user_id)) w
     WHERE NOT EXISTS (
       SELECT 1 FROM public.notifications n
        WHERE n.user_id = w.user_id
          AND n.read_at IS NULL
          AND n.account_id = NEW.account_id
          AND n.type = 'submission_group_message'
          AND n.meta ->> 'group_id' = NEW.group_id::text);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'sg_ring_customer_message: group %: % (%)', NEW.group_id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.sg_ring_customer_message() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.sg_ring_customer_message() IS
  'AFTER INSERT on submission_group_messages: one unread submission_group_message bell per person per group, for a customer''s message on an ACTIVE group, to live staff with an open agent/coordinator row and live holders of the case''s bank. A failure is a WARNING. Migration 173.';

DROP TRIGGER IF EXISTS submission_group_messages_ring ON public.submission_group_messages;
CREATE TRIGGER submission_group_messages_ring
  AFTER INSERT ON public.submission_group_messages
  FOR EACH ROW
  WHEN (NEW.direction = 'in' AND NEW.sender_kind = 'customer' AND NOT NEW.post_end)
  EXECUTE FUNCTION public.sg_ring_customer_message();

-- ---------- 6. Deleted WhatsApp groups stay deleted ----------

CREATE TABLE IF NOT EXISTS public.whatsapp_group_tombstones (
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  channel_id  uuid NOT NULL,
  wa_group_id text NOT NULL,
  deleted_at  timestamptz NOT NULL DEFAULT now(),
  deleted_by  uuid NULL,
  PRIMARY KEY (account_id, channel_id, wa_group_id)
);

COMMENT ON TABLE public.whatsapp_group_tombstones IS
  'A group an admin deleted; persistGroupSnapshot and the webhook never recreate it. No FK to whatsapp_groups (the row is gone) or to the channel. Migration 173.';

ALTER TABLE public.whatsapp_group_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_group_tombstones FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.whatsapp_group_tombstones FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.whatsapp_group_tombstones TO service_role;

-- ---------- 7. Mirrored rows leave the Groups count ----------

CREATE OR REPLACE FUNCTION public.whatsapp_group_unread_count()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::integer
    FROM whatsapp_groups g
    LEFT JOIN whatsapp_group_reads r
      ON r.group_id = g.id AND r.user_id = auth.uid()
   WHERE g.account_id = (SELECT current_account_id())
     AND g.id IN (SELECT whatsapp_group_visible_ids())
     AND g.our_role <> 'left'
     -- An admin Sync mirrored submission groups here; they are shown
     -- from submission_groups, whatever their status and whether or
     -- not the caller can see them (hence SECURITY DEFINER).
     AND NOT EXISTS (
       SELECT 1 FROM submission_groups s
        WHERE s.account_id = g.account_id AND s.wa_group_id = g.wa_group_id)
     AND EXISTS (
       SELECT 1 FROM whatsapp_group_messages m
        WHERE m.group_id = g.id
          AND m.direction = 'in'
          -- Arrival time, not WhatsApp's send time; no marker: read
          -- up to 7 days ago (146's header).
          AND m.received_at > coalesce(r.last_read_at, now() - interval '7 days'))
$$;
COMMENT ON FUNCTION public.whatsapp_group_unread_count() IS
  'Groups of the active workspace the caller sees (whatsapp_group_visible_ids), not left, not mirroring a submission group of the account, with an inbound message that arrived (received_at, not WhatsApp''s created_at) after the caller''s marker; no marker reads as 7 days ago. SECURITY DEFINER since 173: submission_groups is RLS-forced. The sidebar''s Groups count. Migrations 146, 173.';

RESET lock_timeout;
