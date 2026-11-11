-- ============================================================
-- 190 — Personal WhatsApp numbers
--
-- An owner or admin may let chosen staff connect their OWN WhatsApp
-- through OpenWA (144). Such a number belongs to that person:
-- `whatsapp_config.is_personal` marks it and `whatsapp_config.user_id`
-- is the person. Chats on it are visible to the person and to the
-- leaders of their teams, on top of 072's rules; admins and owners
-- still see everything and may still send from it. It is never the
-- default number, never a surface's route, never allocated to anyone
-- (people or teams), so no bot (broadcast, automation, flow, AI) is
-- ever routed onto it.
--
--   1. whatsapp_config.is_personal, one per person per workspace,
--      OpenWA only, never primary; is_personal and its owner frozen.
--      An insert needs the owner to hold the permission below.
--   2. set_primary_channel, whatsapp_routes, whatsapp_channel_members
--      and whatsapp_channel_teams refuse a personal number
--      (HINT 'PERSONAL_NUMBER'). The members/teams triggers cover
--      set_channel_members, set_channel_access and 071's team-derived
--      sync without rewriting them.
--   3. profiles.may_connect_personal_whatsapp, the permission, written
--      only by set_member_personal_whatsapp() (owner/admin); the
--      profile guard (135) now covers it, so nobody grants it to
--      themselves.
--   4. The visibility grant: a conversation whose channel_id (not
--      send_channel_id: a pin grants nothing, 072) is a personal number
--      is also visible to the number's owner and their team leaders.
--      Added to can_view_conversation, can_view_contact and their set
--      forms (177's contact_visibility_chat_contact_ids, 113's
--      pbx_visible_contact_ids), and to the explicit-user mirrors
--      (129's memory_can_read, 109's can_view_conversation_for_user,
--      which gains a 5-argument overload its push callers now use).
--   5. can_use_channel: a personal number is usable by admins, its
--      owner and their team leaders only, decided before the "no
--      allocation rows = shared" rule.
--
-- The conversations/messages SELECT policies are unchanged: they call
-- can_view_conversation with the row's channel_id, so they follow.
-- The TS mirror is lib/auth/conversation-visibility.ts: change both.
--
-- No refusal scan: every existing row takes is_personal = false and
-- may_connect_personal_whatsapp = false. Re-runnable.
-- ============================================================

-- ============================================================
-- 1. The column, its constraints and its guard
-- ============================================================

ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS is_personal BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.whatsapp_config.is_personal IS
  'A staff member''s own WhatsApp (OpenWA only); user_id is that person. Visible to them and their team leaders, never primary, routed or allocated. Migration 190.';

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_one_personal_per_user
  ON public.whatsapp_config (account_id, user_id)
  WHERE is_personal;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'whatsapp_config_personal_not_primary'
       AND conrelid = 'public.whatsapp_config'::regclass
  ) THEN
    ALTER TABLE public.whatsapp_config
      ADD CONSTRAINT whatsapp_config_personal_not_primary
      CHECK (NOT (is_personal AND is_primary));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'whatsapp_config_personal_openwa'
       AND conrelid = 'public.whatsapp_config'::regclass
  ) THEN
    ALTER TABLE public.whatsapp_config
      ADD CONSTRAINT whatsapp_config_personal_openwa
      CHECK (NOT is_personal OR provider = 'openwa');
  END IF;
END $$;

-- is_primary defaults to TRUE (046), so a personal insert that leaves
-- it out is put right here rather than refused by the CHECK. On UPDATE
-- the CHECK refuses instead.
CREATE OR REPLACE FUNCTION public.whatsapp_config_personal_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_personal THEN
      NEW.is_primary := FALSE;
      -- FOR SHARE, not a plain read: set_member_personal_whatsapp(false)
      -- locks this row FOR UPDATE and then checks that no personal
      -- number exists. With a plain read a revoke and a connect running
      -- at once could both commit (the revoke not seeing the uncommitted
      -- number, the insert not seeing the uncommitted revoke). The share
      -- lock makes them take turns, and under READ COMMITTED the locked
      -- read sees the newest committed row. Eligibility is the RPC's
      -- grant rule (live staff who can send), checked again here because
      -- the person may have been demoted since the grant.
      SELECT p.deactivated_at IS NULL
             AND p.account_role::text IN ('owner', 'admin', 'team_leader', 'agent')
             AND p.may_connect_personal_whatsapp
        INTO v_ok
        FROM public.profiles p
       WHERE p.user_id = NEW.user_id
         AND p.account_id = NEW.account_id
         FOR SHARE;
      IF NOT coalesce(v_ok, FALSE) THEN
        RAISE EXCEPTION 'This person may not connect a personal WhatsApp number'
          USING ERRCODE = '42501', HINT = 'PERSONAL_NOT_ALLOWED';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.is_personal IS DISTINCT FROM OLD.is_personal THEN
    RAISE EXCEPTION 'Whether a number is personal cannot be changed'
      USING ERRCODE = '42501', HINT = 'PERSONAL_NUMBER';
  END IF;
  IF OLD.is_personal AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'A personal number cannot change hands'
      USING ERRCODE = '42501', HINT = 'PERSONAL_NUMBER';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_config_personal_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS whatsapp_config_personal_guard ON public.whatsapp_config;
CREATE TRIGGER whatsapp_config_personal_guard
  BEFORE INSERT OR UPDATE ON public.whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_config_personal_guard();

-- ============================================================
-- 2. A personal number is never the default, a route or allocated
-- ============================================================

-- 062's body with the personal refusal before the demote.
CREATE OR REPLACE FUNCTION public.set_primary_channel(p_config_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_account  UUID;
  v_personal BOOLEAN;
BEGIN
  SELECT account_id, is_personal INTO v_account, v_personal FROM whatsapp_config
   WHERE id = p_config_id AND account_id = current_account_id();
  IF NOT FOUND OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'WhatsApp number not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_personal THEN
    RAISE EXCEPTION 'A personal number cannot be the default number'
      USING ERRCODE = '22023', HINT = 'PERSONAL_NUMBER';
  END IF;

  -- Demote, then promote: the one-primary partial unique index (046)
  -- is checked per row, so the other order trips it. Both in this one
  -- transaction, so the account is never left without a default.
  UPDATE whatsapp_config SET is_primary = FALSE
   WHERE account_id = v_account AND id <> p_config_id AND is_primary;
  UPDATE whatsapp_config SET is_primary = TRUE
   WHERE id = p_config_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_primary_channel(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_primary_channel(UUID) TO authenticated;

-- One refusal for the three tables keyed on config_id. Definer, so the
-- lookup sees the number whatever the writer's RLS allows.
CREATE OR REPLACE FUNCTION public.refuse_personal_number_config()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.whatsapp_config w
     WHERE w.id = NEW.config_id AND w.is_personal
  ) THEN
    RAISE EXCEPTION 'A personal number cannot be routed or allocated (%)', TG_TABLE_NAME
      USING ERRCODE = '22023', HINT = 'PERSONAL_NUMBER';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.refuse_personal_number_config() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS whatsapp_routes_refuse_personal ON public.whatsapp_routes;
CREATE TRIGGER whatsapp_routes_refuse_personal
  BEFORE INSERT OR UPDATE OF config_id ON public.whatsapp_routes
  FOR EACH ROW EXECUTE FUNCTION public.refuse_personal_number_config();

DROP TRIGGER IF EXISTS whatsapp_channel_members_refuse_personal ON public.whatsapp_channel_members;
CREATE TRIGGER whatsapp_channel_members_refuse_personal
  BEFORE INSERT OR UPDATE OF config_id ON public.whatsapp_channel_members
  FOR EACH ROW EXECUTE FUNCTION public.refuse_personal_number_config();

DROP TRIGGER IF EXISTS whatsapp_channel_teams_refuse_personal ON public.whatsapp_channel_teams;
CREATE TRIGGER whatsapp_channel_teams_refuse_personal
  BEFORE INSERT OR UPDATE OF config_id ON public.whatsapp_channel_teams
  FOR EACH ROW EXECUTE FUNCTION public.refuse_personal_number_config();

-- ============================================================
-- 3. The permission
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS may_connect_personal_whatsapp BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.profiles.may_connect_personal_whatsapp IS
  'May this person connect their own WhatsApp (OpenWA) as a personal number in this workspace. Written only by set_member_personal_whatsapp(). Migration 190.';

-- 135's body with may_connect_personal_whatsapp among the guarded
-- columns: without it a person could grant themselves the permission.
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user = 'authenticated' AND (
       TG_OP = 'INSERT'
       OR NEW.account_role IS DISTINCT FROM OLD.account_role
       OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.deactivated_at IS DISTINCT FROM OLD.deactivated_at
       OR NEW.deactivated_by IS DISTINCT FROM OLD.deactivated_by
       OR NEW.is_active IS DISTINCT FROM OLD.is_active
       OR NEW.bank_code IS DISTINCT FROM OLD.bank_code
       OR NEW.email IS DISTINCT FROM OLD.email
       OR NEW.may_connect_personal_whatsapp IS DISTINCT FROM OLD.may_connect_personal_whatsapp
     )
  THEN
    RAISE EXCEPTION
      'account_role, account_id, email and deactivation cannot be changed directly; use the account member/invitation RPCs (email changes go through sign-in settings)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- switch_account() checked the caller itself, and moving out of a
  -- workspace where they were deactivated is what it is for; so is
  -- redeem_invitation(), whose token is the authority. Those are the
  -- only places this flag is raised; clients cannot set it.
  IF COALESCE(current_setting('app.account_switch', TRUE), '') = 'on' THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NOT NULL AND EXISTS (
       SELECT 1 FROM profiles
       WHERE user_id = auth.uid() AND is_active AND deactivated_at IS NOT NULL
     )
  THEN
    RAISE EXCEPTION 'Your access to this account has been deactivated'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

-- Definer: runs as the function owner, so the profile guard above
-- (current_user = 'authenticated') lets its write through, as it does
-- for the other member RPCs.
CREATE OR REPLACE FUNCTION public.set_member_personal_whatsapp(p_user_id uuid, p_allowed boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct uuid := public.current_account_id();
BEGIN
  IF auth.uid() IS NULL OR v_acct IS NULL OR public.current_role_rank() < 4 THEN
    RAISE EXCEPTION 'Only an owner or admin can allow personal WhatsApp numbers'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_allowed IS NULL THEN
    RAISE EXCEPTION 'A person and a choice are required' USING ERRCODE = '22023';
  END IF;

  -- One writer per person at a time (the row lock switch_account takes).
  PERFORM 1 FROM public.profiles p
    WHERE p.user_id = p_user_id AND p.account_id = v_acct
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Member not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_allowed THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.user_id = p_user_id
         AND p.account_id = v_acct
         AND p.deactivated_at IS NULL
         AND p.account_role::text IN ('owner', 'admin', 'team_leader', 'agent')
    ) THEN
      RAISE EXCEPTION 'Only a live staff member who can send messages may connect a personal number'
        USING ERRCODE = '22023', HINT = 'not_eligible';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM public.whatsapp_config w
     WHERE w.account_id = v_acct AND w.user_id = p_user_id AND w.is_personal
  ) THEN
    RAISE EXCEPTION 'Remove this person''s personal number first'
      USING ERRCODE = '22023', HINT = 'PERSONAL_NUMBER_EXISTS';
  END IF;

  UPDATE public.profiles p
     SET may_connect_personal_whatsapp = p_allowed
   WHERE p.user_id = p_user_id AND p.account_id = v_acct;
END;
$$;

REVOKE ALL ON FUNCTION public.set_member_personal_whatsapp(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_personal_whatsapp(uuid, boolean) TO authenticated;

COMMENT ON FUNCTION public.set_member_personal_whatsapp(uuid, boolean) IS
  'Allow or forbid a person to connect a personal WhatsApp number in the caller''s active account (owner/admin only). Allowing needs a live owner/admin/team_leader/agent; forbidding is refused (PERSONAL_NUMBER_EXISTS) while they have one. Migration 190.';

-- ============================================================
-- 4. The visibility grant
-- ============================================================

-- The personal numbers of the active workspace whose chats the caller
-- sees through the grant: their own, and those of the people in the
-- teams they lead (177's contact_visibility_people).
CREATE OR REPLACE FUNCTION public.personal_number_visible_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
ROWS 5
SET search_path TO ''
AS $$
  SELECT w.id FROM public.whatsapp_config w
   WHERE w.is_personal
     AND w.account_id = public.current_account_id()
     AND w.user_id IN (SELECT public.contact_visibility_people())
$$;

COMMENT ON FUNCTION public.personal_number_visible_ids() IS
  'Personal numbers (190) of the active workspace owned by one of contact_visibility_people(): the caller''s own and those of the people in teams they lead. Set form of the personal-number grant.';

REVOKE ALL ON FUNCTION public.personal_number_visible_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.personal_number_visible_ids() TO authenticated, service_role;

-- 072's body plus the personal-number branch.
CREATE OR REPLACE FUNCTION public.can_view_conversation(
  p_account_id      UUID,
  p_owner_id        UUID,
  p_assigned_id     UUID,
  p_channel_id      UUID,
  p_send_channel_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN is_account_member(p_account_id, 'admin') THEN TRUE
    WHEN NOT is_account_member(p_account_id) THEN FALSE
    WHEN COALESCE(p_owner_id = auth.uid(), FALSE)
      OR COALESCE(p_assigned_id = auth.uid(), FALSE) THEN TRUE
    WHEN p_channel_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM whatsapp_config w
       WHERE w.id = p_channel_id
         AND w.account_id = p_account_id
         AND w.is_personal
         AND (
           w.user_id = auth.uid()
           OR (is_account_member(p_account_id, 'team_leader')
               AND leads_teammate(p_account_id, w.user_id))
         )
    ) THEN TRUE
    WHEN is_account_member(p_account_id, 'team_leader')
      AND (
        leads_teammate(p_account_id, p_owner_id)
        OR leads_teammate(p_account_id, p_assigned_id)
      ) THEN TRUE
    ELSE FALSE
  END;
$$;

COMMENT ON FUNCTION public.can_view_conversation(UUID, UUID, UUID, UUID, UUID) IS
  'Admin/owner: everything. Others: chats they own or are assigned, chats on their personal number (190), and a team leader''s team (including their personal numbers). Number allocation grants no visibility since 072; send_channel_id is kept for the callers'' signature.';

-- 072's body plus the personal-number branch.
CREATE OR REPLACE FUNCTION public.can_view_contact(
  p_account_id UUID,
  p_contact_id UUID,
  p_creator_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN is_account_member(p_account_id, 'admin') THEN TRUE
    WHEN NOT is_account_member(p_account_id) THEN FALSE
    WHEN COALESCE(p_creator_id = auth.uid(), FALSE) THEN TRUE
    WHEN EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.contact_id = p_contact_id
        AND (c.user_id = auth.uid() OR c.assigned_agent_id = auth.uid())
    ) THEN TRUE
    WHEN EXISTS (
      SELECT 1 FROM conversations c
      JOIN whatsapp_config w ON w.id = c.channel_id
      WHERE c.contact_id = p_contact_id
        AND w.account_id = p_account_id
        AND w.is_personal
        AND (
          w.user_id = auth.uid()
          OR (is_account_member(p_account_id, 'team_leader')
              AND leads_teammate(p_account_id, w.user_id))
        )
    ) THEN TRUE
    WHEN is_account_member(p_account_id, 'team_leader')
      AND (
        leads_teammate(p_account_id, p_creator_id)
        OR EXISTS (
          SELECT 1 FROM conversations c
          WHERE c.contact_id = p_contact_id
            AND (
              leads_teammate(p_account_id, c.user_id)
              OR leads_teammate(p_account_id, c.assigned_agent_id)
            )
        )
      ) THEN TRUE
    ELSE FALSE
  END;
$$;

COMMENT ON FUNCTION public.can_view_contact(UUID, UUID, UUID) IS
  'Admin/owner: everything. Others: contacts they created or have a chat with (own/assigned, or on their personal number, 190), and a team leader''s team. Number allocation grants no visibility since 072.';

-- 177's body plus the personal-number arm (changes with can_view_contact;
-- verify-contacts-select-set-based.sql compares them).
CREATE OR REPLACE FUNCTION public.contact_visibility_chat_contact_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
ROWS 100
SET search_path TO ''
AS $$
  -- Like can_view_contact's conversation probes, not scoped to an
  -- account: the policy's account term already confines the contact.
  SELECT v.contact_id
    FROM public.conversations v
   WHERE v.contact_id IS NOT NULL
     AND (
       v.user_id IN (SELECT public.contact_visibility_people())
       OR v.assigned_agent_id IN (SELECT public.contact_visibility_people())
       OR v.channel_id IN (SELECT public.personal_number_visible_ids())
     );
$$;

COMMENT ON FUNCTION public.contact_visibility_chat_contact_ids() IS
  'Contacts with a conversation owned by or assigned to one of contact_visibility_people(), or on one of personal_number_visible_ids() (190). Set form of can_view_contact for the contacts_select policy; see migrations 177, 190.';

-- 113's body plus the personal-number arm.
CREATE OR REPLACE FUNCTION public.pbx_visible_contact_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- can_view_contact as a set, for the caller's active workspace. Owner
  -- and admin: every contact. Below: created by one of the people, or
  -- with a chat owned by or assigned to one of them, or (190) with a
  -- chat on a personal number they see.
  WITH ctx AS (
    SELECT current_account_id() AS acct, current_role_rank() AS rnk, pbx_visible_user_ids() AS ppl
  )
  SELECT c.id FROM contacts c, ctx
   WHERE c.account_id = ctx.acct AND ctx.rnk >= 4
  UNION
  SELECT c.id FROM contacts c, ctx
   WHERE c.account_id = ctx.acct AND ctx.rnk < 4 AND c.user_id = ANY (ctx.ppl)
  UNION
  SELECT c.id
    FROM conversations cv
    JOIN contacts c ON c.id = cv.contact_id, ctx
   WHERE c.account_id = ctx.acct AND ctx.rnk < 4
     AND (cv.user_id = ANY (ctx.ppl) OR cv.assigned_agent_id = ANY (ctx.ppl))
  UNION
  SELECT c.id
    FROM conversations cv
    JOIN contacts c ON c.id = cv.contact_id, ctx
   WHERE c.account_id = ctx.acct AND ctx.rnk < 4
     AND cv.channel_id IN (SELECT public.personal_number_visible_ids())
$$;

COMMENT ON FUNCTION public.pbx_visible_contact_ids() IS
  'can_view_contact (072, 190) as a set: the contacts of the active workspace the caller may see. The calls policy reads it once per query. Migrations 113, 190.';

-- 129's body; the contact branch gains the personal-number grant for
-- the explicit user (owner of the number, or a live team leader who
-- leads them). Change with can_view_contact.
CREATE OR REPLACE FUNCTION public.memory_can_read(p_user uuid, p_account uuid, p_scope_type text, p_scope_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH me AS (
    SELECT p.account_role::text AS role
      FROM public.profiles p
     WHERE p.user_id = p_user
       AND p.account_id = p_account
       AND p.deactivated_at IS NULL
       AND p.account_role <> 'bank_guest'
  )
  SELECT CASE
    WHEN p_user IS NULL OR p_account IS NULL OR p_scope_type IS NULL OR p_scope_id IS NULL THEN false
    WHEN NOT EXISTS (SELECT 1 FROM me) THEN false
    WHEN EXISTS (SELECT 1 FROM me WHERE me.role IN ('owner', 'admin')) THEN true
    WHEN p_scope_type = 'workspace' AND p_scope_id = p_account THEN true
    WHEN p_scope_type = 'contact' AND EXISTS (
      SELECT 1 FROM public.contacts ct
       WHERE ct.id = p_scope_id AND ct.account_id = p_account
         AND (ct.user_id = p_user
              OR EXISTS (SELECT 1 FROM public.conversations c
                          WHERE c.contact_id = ct.id
                            AND (c.user_id = p_user OR c.assigned_agent_id = p_user))
              OR EXISTS (SELECT 1 FROM public.conversations c
                           JOIN public.whatsapp_config w ON w.id = c.channel_id
                          WHERE c.contact_id = ct.id
                            AND w.account_id = p_account
                            AND w.is_personal
                            AND (w.user_id = p_user
                                 OR (EXISTS (SELECT 1 FROM me WHERE me.role = 'team_leader')
                                     AND EXISTS (SELECT 1 FROM public.teams t
                                                   JOIN public.team_members tm ON tm.team_id = t.id
                                                  WHERE t.account_id = p_account
                                                    AND t.leader_user_id = p_user
                                                    AND tm.user_id = w.user_id))))
              OR (EXISTS (SELECT 1 FROM me WHERE me.role = 'team_leader')
                  AND EXISTS (SELECT 1 FROM public.teams t
                                JOIN public.team_members tm ON tm.team_id = t.id
                               WHERE t.account_id = p_account
                                 AND t.leader_user_id = p_user
                                 AND (tm.user_id = ct.user_id
                                      OR EXISTS (SELECT 1 FROM public.conversations c
                                                  WHERE c.contact_id = ct.id
                                                    AND tm.user_id IN (c.user_id, c.assigned_agent_id))))))
    ) THEN true
    WHEN p_scope_type = 'case'
      AND EXISTS (SELECT 1 FROM public.cases k WHERE k.id = p_scope_id AND k.account_id = p_account)
      AND public.case_role(p_scope_id, p_user) IS NOT NULL THEN true
    WHEN EXISTS (
      SELECT 1 FROM public.memory_acl a
       WHERE a.account_id = p_account AND a.user_id = p_user AND a.revoked_at IS NULL
         AND ((a.scope_type = p_scope_type AND a.scope_id = p_scope_id)
              OR (a.role IN ('admin', 'super_admin') AND a.scope_type = 'workspace' AND a.scope_id = p_account))
    ) THEN true
    ELSE false
  END
$$;

-- 109's 4-argument mirror plus the conversation's channel_id, carrying
-- the personal-number grant for an explicit person (the push path has
-- no auth.uid()). The 4-argument form stays for any other caller; the
-- push functions below now use this one. Private: no client grant.
CREATE OR REPLACE FUNCTION public.can_view_conversation_for_user(
  p_user_id     uuid,
  p_account_id  uuid,
  p_owner_id    uuid,
  p_assigned_id uuid,
  p_channel_id  uuid
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
    WHEN p_channel_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.whatsapp_config w
       WHERE w.id = p_channel_id
         AND w.account_id = p_account_id
         AND w.is_personal
         AND (
           w.user_id = p_user_id
           OR (coalesce((SELECT rank FROM me), 0) >= 3
               AND EXISTS (
                 SELECT 1
                   FROM public.teams t
                   JOIN public.team_members tm ON tm.team_id = t.id
                  WHERE t.account_id = p_account_id
                    AND t.leader_user_id = p_user_id
                    AND tm.user_id = w.user_id))
         )
    ) THEN TRUE
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

REVOKE ALL ON FUNCTION public.can_view_conversation_for_user(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- 109's push_whatsapp_inbound with the 5-argument check, and the
-- number's owner joining the allocated tier for a personal number.
CREATE OR REPLACE FUNCTION public.push_whatsapp_inbound(p_message_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  WITH m AS (
    SELECT cv.id AS conversation_id, cv.account_id, cv.user_id AS owner_id, cv.assigned_agent_id, cv.channel_id,
           coalesce(nullif(btrim(ct.name), ''), nullif(btrim(ct.phone), ''), 'WhatsApp') AS title,
           left(CASE
             WHEN msg.content_type IN ('image', 'video', 'audio', 'document', 'location', 'contacts') THEN
               CASE msg.content_type
                 WHEN 'image'    THEN '📷 Photo'
                 WHEN 'video'    THEN '🎥 Video'
                 WHEN 'audio'    THEN '🎤 Voice message'
                 WHEN 'document' THEN '📎 Document'
                 WHEN 'location' THEN '📍 Location'
                 ELSE '👤 Contact'
               END || coalesce(': ' || nullif(btrim(msg.content_text), ''), '')
             ELSE coalesce(nullif(btrim(msg.content_text), ''), '💬 Message')
           END, 140) AS body
      FROM public.messages msg
      JOIN public.conversations cv ON cv.id = msg.conversation_id
      LEFT JOIN public.contacts ct ON ct.id = cv.contact_id
     WHERE msg.id = p_message_id AND msg.sender_type = 'customer'
  -- Each tier is the people who should hear of it: live in the account
  -- and able to see the chat (can_view_conversation_for_user checks
  -- both). Whether they have a device is push_eligible's question,
  -- asked last, so a tier never falls through to the next for want of
  -- one.
  ), assignee AS (
    SELECT m.assigned_agent_id AS user_id FROM m
     WHERE m.assigned_agent_id IS NOT NULL
       AND public.can_view_conversation_for_user(m.assigned_agent_id, m.account_id, m.owner_id, m.assigned_agent_id, m.channel_id)
  ), allocated AS (
    SELECT w.user_id FROM m
      JOIN public.whatsapp_channel_members w ON w.config_id = m.channel_id AND w.account_id = m.account_id
     WHERE NOT EXISTS (SELECT 1 FROM assignee)
       AND public.can_view_conversation_for_user(w.user_id, m.account_id, m.owner_id, m.assigned_agent_id, m.channel_id)
    UNION
    -- 190: a personal number has no allocation rows; its owner is the
    -- person to hear of an unassigned chat on it.
    SELECT w.user_id FROM m
      JOIN public.whatsapp_config w ON w.id = m.channel_id AND w.account_id = m.account_id AND w.is_personal
     WHERE NOT EXISTS (SELECT 1 FROM assignee)
       AND public.can_view_conversation_for_user(w.user_id, m.account_id, m.owner_id, m.assigned_agent_id, m.channel_id)
  ), r AS (
    SELECT a.user_id FROM assignee a
    UNION
    SELECT a.user_id FROM allocated a
    UNION
    SELECT p.user_id FROM m
      JOIN public.profiles p ON p.account_id = m.account_id
     WHERE NOT EXISTS (SELECT 1 FROM assignee) AND NOT EXISTS (SELECT 1 FROM allocated)
       AND p.account_role IN ('owner', 'admin') AND p.deactivated_at IS NULL
  )
  INSERT INTO public.push_outbox (user_id, account_id, kind, title, body, url, tag, conversation_id)
  SELECT r.user_id, m.account_id, 'whatsapp_message', left(m.title, 120), m.body,
         '/inbox?c=' || m.conversation_id, 'wa:' || m.conversation_id, m.conversation_id
    FROM m, r
   WHERE public.can_view_conversation_for_user(r.user_id, m.account_id, m.owner_id, m.assigned_agent_id, m.channel_id)
     AND public.push_eligible(r.user_id, m.account_id, 'whatsapp_message');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- 112's push_still_allowed with the 5-argument check.
CREATE OR REPLACE FUNCTION public.push_still_allowed(o public.push_outbox)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.push_eligible(o.user_id, o.account_id, o.kind)
     AND CASE o.kind
           WHEN 'whatsapp_message' THEN EXISTS (
             SELECT 1 FROM public.conversations cv
              WHERE cv.id = o.conversation_id AND cv.account_id = o.account_id
                AND public.can_view_conversation_for_user(o.user_id, o.account_id, cv.user_id, cv.assigned_agent_id, cv.channel_id))
           WHEN 'chat_message' THEN EXISTS (
             SELECT 1 FROM public.chat_channel_members cm
               JOIN public.chat_channels ch ON ch.id = cm.channel_id
              WHERE cm.channel_id = o.channel_id AND cm.user_id = o.user_id AND ch.account_id = o.account_id)
             AND coalesce(public.chat_user_can_read_channel(o.channel_id, o.user_id, true), false)
             -- 112: never the words of a message deleted, erased or
             -- edited since it was queued (NULL: queued before 112). A
             -- row is queued as its message is inserted, so any edit
             -- came after it.
             AND (o.message_id IS NULL OR EXISTS (
               SELECT 1 FROM public.internal_messages im
                WHERE im.id = o.message_id
                  AND im.deleted_at IS NULL AND im.erased_at IS NULL
                  AND im.edited_at IS NULL))
           ELSE true
         END
$$;

-- ============================================================
-- 5. Who may send from a personal number
-- ============================================================

-- 062's body with the personal branch decided first: with no
-- allocation rows a personal number would otherwise read as shared.
CREATE OR REPLACE FUNCTION public.can_use_channel(
  p_account_id UUID,
  p_channel_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM whatsapp_config w
    WHERE w.id = p_channel_id
      AND w.account_id = p_account_id
  )
  AND is_account_member(p_account_id)
  AND (
    is_account_member(p_account_id, 'admin')
    OR CASE
      WHEN EXISTS (
        SELECT 1 FROM whatsapp_config w
        WHERE w.id = p_channel_id AND w.account_id = p_account_id AND w.is_personal
      ) THEN EXISTS (
        SELECT 1 FROM whatsapp_config w
        WHERE w.id = p_channel_id
          AND w.account_id = p_account_id
          AND (
            -- The owner must still be able to send here: a person
            -- demoted to viewer keeps the number (an admin deletes it)
            -- but may not use it.
            (w.user_id = auth.uid() AND is_account_member(p_account_id, 'agent'))
            OR (is_account_member(p_account_id, 'team_leader')
                AND leads_teammate(p_account_id, w.user_id))
          )
      )
      ELSE (
        NOT EXISTS (
          SELECT 1 FROM whatsapp_channel_members m
          WHERE m.config_id = p_channel_id AND m.account_id = p_account_id
        )
        OR EXISTS (
          SELECT 1 FROM whatsapp_channel_members m
          WHERE m.config_id = p_channel_id
            AND m.account_id = p_account_id
            AND m.user_id = auth.uid()
        )
      )
    END
  );
$$;
COMMENT ON FUNCTION public.can_use_channel(UUID, UUID) IS
  'May the calling user send from this number? Admins: any number on the account. A personal number (190): its owner while an agent or above there, and the leaders of their teams. Others: numbers they are allocated to, and shared numbers (no allocation). See migrations 061, 062, 190.';
