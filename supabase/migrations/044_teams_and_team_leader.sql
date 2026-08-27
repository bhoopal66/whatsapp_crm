-- ============================================================
-- 044: teams, and a team_leader role
--
-- Adds a rung between agent and admin. A team leader runs a group of
-- agents: they see everything their team handles, and can move work
-- around WITHIN that team — but they configure nothing account-wide,
-- and they cannot see another team's customers.
--
--   owner       5   everything, plus ownership transfer
--   admin       4   everything in the account; creates and staffs teams
--   team_leader 3   own work + their team's work; assigns within the team
--   agent       2   own work
--   viewer      1   own work, read-only
--
-- Teams are created and staffed by admins (Settings -> Teams). A user
-- belongs to at most one team, which keeps "their team" unambiguous
-- everywhere it appears; a leader may lead more than one, so a leader's
-- view is the union of the teams they lead.
--
-- NOTE ON ORDERING: the new enum label has to be committed before
-- anything can reference it, so this file relies on psql's per-
-- statement autocommit (no BEGIN/COMMIT). Do not wrap it.
-- ============================================================

ALTER TYPE account_role_enum ADD VALUE IF NOT EXISTS 'team_leader' AFTER 'agent';

-- ---------- the rank ladder ----------
--
-- `is_account_member` is the single comparison every policy in the
-- schema funnels through, so inserting a rung means rewriting it. The
-- numbers shift (admin 3 -> 4, owner 4 -> 5) but only relative order
-- matters, and it is compared against itself on both sides.

CREATE OR REPLACE FUNCTION public.is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'::account_role_enum
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND CASE p.account_role
            WHEN 'owner'       THEN 5
            WHEN 'admin'       THEN 4
            WHEN 'team_leader' THEN 3
            WHEN 'agent'       THEN 2
            WHEN 'viewer'      THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'       THEN 5
            WHEN 'admin'       THEN 4
            WHEN 'team_leader' THEN 3
            WHEN 'agent'       THEN 2
            WHEN 'viewer'      THEN 1
          END
  );
$$;

-- ---------- schema ----------

CREATE TABLE IF NOT EXISTS public.teams (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id     UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  -- ON DELETE SET NULL, not CASCADE: removing a person must never take
  -- the team and its membership with them. A leaderless team is a
  -- visible, fixable state; a silently deleted one is not.
  leader_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_account_name
  ON public.teams (account_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_teams_leader
  ON public.teams (leader_user_id) WHERE leader_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.team_members (
  team_id    UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id)
);

-- One team per person, per account. Without this, "their team" stops
-- being a single answer and every visibility rule below needs a
-- tie-breaker nobody would remember.
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_one_team_per_user
  ON public.team_members (account_id, user_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON public.team_members (user_id);

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

-- Any member may READ the roster: names of teams and who is in them are
-- how the UI labels an assignment, and none of it is customer data.
DROP POLICY IF EXISTS teams_select ON public.teams;
CREATE POLICY teams_select ON public.teams
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS teams_modify ON public.teams;
CREATE POLICY teams_modify ON public.teams
  FOR ALL USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS team_members_select ON public.team_members;
CREATE POLICY team_members_select ON public.team_members
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS team_members_modify ON public.team_members;
CREATE POLICY team_members_modify ON public.team_members
  FOR ALL USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- ---------- "does the caller lead this person?" ----------

-- SECURITY DEFINER for the same reason `can_view_contact` is: it is
-- called from inside policies and must answer the plain question,
-- not a question already filtered by another policy.
CREATE OR REPLACE FUNCTION public.leads_teammate(
  p_account_id UUID,
  p_user_id    UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p_user_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM teams t
    JOIN team_members tm ON tm.team_id = t.id
    WHERE t.account_id = p_account_id
      AND t.leader_user_id = auth.uid()
      AND tm.user_id = p_user_id
  );
$$;

COMMENT ON FUNCTION public.leads_teammate(UUID, UUID) IS
  'True when the calling user leads a team that p_user_id belongs to. See migration 044.';

-- ---------- visibility, extended ----------

CREATE OR REPLACE FUNCTION public.can_view_conversation(
  p_account_id  UUID,
  p_owner_id    UUID,
  p_assigned_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN is_account_member(p_account_id, 'admin') THEN TRUE
    WHEN NOT is_account_member(p_account_id) THEN FALSE
    -- Mine: created by me, or handed to me.
    WHEN COALESCE(p_owner_id = auth.uid(), FALSE)
      OR COALESCE(p_assigned_id = auth.uid(), FALSE) THEN TRUE
    -- My team's: anything one of my team members created or holds.
    -- This is what the Team Inbox reads; the personal Inbox narrows
    -- back down to "mine" in the query, not here, so a leader has one
    -- rule and two views rather than two rules.
    WHEN is_account_member(p_account_id, 'team_leader')
      AND (
        leads_teammate(p_account_id, p_owner_id)
        OR leads_teammate(p_account_id, p_assigned_id)
      ) THEN TRUE
    ELSE FALSE
  END;
$$;

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
    -- A leader sees their team's customers: contacts their people
    -- added, and contacts behind chats their people handle.
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

-- ---------- assignment, extended ----------

CREATE OR REPLACE FUNCTION public.enforce_conversation_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  -- Server-side callers pass straight through; see migration 042.
  IF auth.uid() IS NULL OR COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF is_account_member(NEW.account_id, 'admin') THEN
    RETURN NEW;
  END IF;

  -- A leader moves work around inside their own team, and no further.
  -- Note this is checked against the DESTINATION: they may hand a chat
  -- to anyone they lead. Whether they could see the chat to begin with
  -- is the UPDATE policy's business, not this trigger's.
  IF is_account_member(NEW.account_id, 'team_leader')
     AND leads_teammate(NEW.account_id, NEW.assigned_agent_id) THEN
    RETURN NEW;
  END IF;

  -- Anyone may take a visible conversation for themselves, or release
  -- it (the AI hand-off buttons).
  IF NEW.assigned_agent_id IS NULL OR NEW.assigned_agent_id = auth.uid() THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'You can only assign conversations to people you lead'
    USING ERRCODE = '42501';
END;
$$;
