-- ============================================================
-- 071: allocate a WhatsApp number to a whole team
--
-- 060 lets an admin allocate a number to people, one tick at a time.
-- This lets them allocate it to a TEAM (044): the team's members and
-- its leader get the number, and joining or leaving the team gains or
-- loses it with no further admin action.
--
-- Design: `whatsapp_channel_members` stays the single materialised
-- truth. Every access predicate already reads it — is_channel_member,
-- can_use_channel, can_view_conversation/4 and /5, can_view_contact —
-- and so does app code, so none of them changes here. Team allocations
-- are stored in their own table, and the rows they imply are DERIVED
-- into whatsapp_channel_members by triggers:
--
--   whatsapp_channel_teams  (config_id, team_id)       what the admin chose
--   whatsapp_channel_members.direct    ticked by name (set_channel_members)
--   whatsapp_channel_members.via_team  implied by a team allocation
--
-- A row exists while either flag is true (CHECK). Clearing the direct
-- list never takes away access someone has through a team, and
-- removing a team allocation never takes away a direct one.
--
-- `sync_channel_team_members(account)` recomputes an account's via-team
-- set from scratch. It runs after every change to team_members, to a
-- team's leader, and to whatsapp_channel_teams, including the rows a
-- cascade deletes (team deleted, number deleted, user deleted), so no
-- stale via-team row survives. It is SECURITY DEFINER and not callable
-- by clients; the trigger function that calls it is SECURITY DEFINER
-- too, because the call inside a trigger IS privilege-checked against
-- the user whose write fired it.
--
-- A person who leaves the account (remove_account_member, or a move to
-- another account by invitation) leaves its teams too: a trigger on
-- profiles deletes their team rows and their number allocations there,
-- clears any team they led, and syncs both accounts (section 4b).
--
-- Every write path is one transaction, so a refusal changes nothing:
-- set_team_members / update_team for a team's people (and, through
-- update_team, its name, leader and numbers together), set_channel_access
-- for a number's people and teams together. Each RPC takes the account's
-- sync lock (channel_access_lock_key) BEFORE locking the row it edits,
-- and locks that row FOR NO KEY UPDATE: a sync already holding the lock
-- needs a KEY SHARE on the same row (the FK check of its inserts), and
-- the other order is a deadlock.
--
-- Known and accepted: a number allocated ONLY to a team that currently
-- has nobody in it (no members, no leader) has no member rows, and so
-- still counts as SHARED — everyone may use it — exactly like a number
-- with no allocation at all. "Allocated to an empty team" is not a
-- state the access predicates can see.
--
-- Re-runnable: IF NOT EXISTS / CREATE OR REPLACE / DROP … IF EXISTS /
-- guarded DO blocks.
-- ============================================================

-- ============================================================
-- 1. whatsapp_channel_teams — which teams work each number
-- ============================================================

-- The composite FK below needs a key on (id, account_id), as 062 did
-- for whatsapp_config: a team of another account cannot be allocated.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'teams_id_account_key'
  ) THEN
    ALTER TABLE public.teams
      ADD CONSTRAINT teams_id_account_key UNIQUE (id, account_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.whatsapp_channel_teams (
  config_id  UUID NOT NULL,
  team_id    UUID NOT NULL,
  account_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (config_id, team_id),
  CONSTRAINT whatsapp_channel_teams_config_account_fkey
    FOREIGN KEY (config_id, account_id)
    REFERENCES public.whatsapp_config (id, account_id) ON DELETE CASCADE,
  CONSTRAINT whatsapp_channel_teams_team_account_fkey
    FOREIGN KEY (team_id, account_id)
    REFERENCES public.teams (id, account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_channel_teams_team
  ON public.whatsapp_channel_teams (team_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_channel_teams_account
  ON public.whatsapp_channel_teams (account_id);

ALTER TABLE public.whatsapp_channel_teams ENABLE ROW LEVEL SECURITY;

-- Same ladder as whatsapp_channel_members: any member reads, admins write.
DROP POLICY IF EXISTS whatsapp_channel_teams_select ON public.whatsapp_channel_teams;
CREATE POLICY whatsapp_channel_teams_select ON public.whatsapp_channel_teams
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS whatsapp_channel_teams_modify ON public.whatsapp_channel_teams;
CREATE POLICY whatsapp_channel_teams_modify ON public.whatsapp_channel_teams
  FOR ALL USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

COMMENT ON TABLE public.whatsapp_channel_teams IS
  'Teams allocated to a WhatsApp number. Their members and leader are derived into whatsapp_channel_members (via_team) by triggers; access predicates read only that table. See migration 071.';

-- ============================================================
-- 2. whatsapp_channel_members: why each row exists
-- ============================================================

-- Every existing row was ticked by name, which the defaults record.
ALTER TABLE public.whatsapp_channel_members
  ADD COLUMN IF NOT EXISTS direct BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.whatsapp_channel_members
  ADD COLUMN IF NOT EXISTS via_team BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_channel_members_reason_check'
  ) THEN
    ALTER TABLE public.whatsapp_channel_members
      ADD CONSTRAINT whatsapp_channel_members_reason_check
      CHECK (direct OR via_team);
  END IF;
END $$;

COMMENT ON COLUMN public.whatsapp_channel_members.direct IS
  'Allocated by name (set_channel_members). See migration 071.';
COMMENT ON COLUMN public.whatsapp_channel_members.via_team IS
  'Allocated through a team (whatsapp_channel_teams); maintained only by sync_channel_team_members. See migration 071.';

-- ============================================================
-- 3. Derive the via-team rows
-- ============================================================

-- The (number, person) pairs an account's team allocations imply: each
-- allocated team's members and its leader, provided they are still a
-- member of the account (a removed member moves to another account).
CREATE OR REPLACE FUNCTION public.channel_team_desired_members(p_account_id UUID)
RETURNS TABLE (config_id UUID, user_id UUID)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT DISTINCT d.config_id, d.user_id
    FROM (
      SELECT ct.config_id, tm.user_id
        FROM whatsapp_channel_teams ct
        JOIN team_members tm ON tm.team_id = ct.team_id
       WHERE ct.account_id = p_account_id
      UNION
      SELECT ct.config_id, t.leader_user_id
        FROM whatsapp_channel_teams ct
        JOIN teams t ON t.id = ct.team_id
       WHERE ct.account_id = p_account_id
         AND t.leader_user_id IS NOT NULL
    ) d
   WHERE EXISTS (
     SELECT 1 FROM profiles p
      WHERE p.user_id = d.user_id AND p.account_id = p_account_id
   );
$$;

REVOKE ALL ON FUNCTION public.channel_team_desired_members(UUID) FROM PUBLIC, anon, authenticated;

-- The one per-account lock every writer of channel access takes: the
-- sync below, and each RPC in sections 5-10 BEFORE it locks a row.
-- Only a key, so the SECURITY INVOKER RPCs can compute it; calling it
-- locks nothing.
CREATE OR REPLACE FUNCTION public.channel_access_lock_key(p_account_id UUID)
RETURNS BIGINT
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT hashtextextended('sync_channel_team_members:' || p_account_id::text, 0);
$$;

REVOKE ALL ON FUNCTION public.channel_access_lock_key(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.channel_access_lock_key(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.sync_channel_team_members(p_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Inside an account-deletion cascade there is nothing left to
  -- derive, and an INSERT would reference a row being deleted.
  IF p_account_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM accounts WHERE id = p_account_id) THEN
    RETURN;
  END IF;

  -- Serialise syncs per account. Without this, two transactions (one
  -- adding a person to a team, one allocating that team to a number)
  -- each derive from a snapshot missing the other's change, and the
  -- person never gets the number. Each statement below takes a fresh
  -- snapshot after the lock is granted. Re-entrant: an RPC that took it
  -- already just stacks another hold, released at commit with the rest.
  PERFORM pg_advisory_xact_lock(channel_access_lock_key(p_account_id));

  -- No longer implied by a team. The CHECK (direct OR via_team) means a
  -- team-only row is deleted rather than cleared.
  DELETE FROM whatsapp_channel_members m
   WHERE m.account_id = p_account_id
     AND m.via_team AND NOT m.direct
     AND (m.config_id, m.user_id) NOT IN (
       SELECT d.config_id, d.user_id FROM channel_team_desired_members(p_account_id) d
     );
  UPDATE whatsapp_channel_members m
     SET via_team = FALSE
   WHERE m.account_id = p_account_id
     AND m.via_team
     AND (m.config_id, m.user_id) NOT IN (
       SELECT d.config_id, d.user_id FROM channel_team_desired_members(p_account_id) d
     );

  -- Implied by a team: add, or mark an existing direct row.
  INSERT INTO whatsapp_channel_members (config_id, user_id, account_id, direct, via_team)
  SELECT d.config_id, d.user_id, p_account_id, FALSE, TRUE
    FROM channel_team_desired_members(p_account_id) d
  ON CONFLICT (config_id, user_id) DO UPDATE
     SET via_team = TRUE
   WHERE NOT whatsapp_channel_members.via_team;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_channel_team_members(UUID) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.sync_channel_team_members(UUID) IS
  'Recomputes the via_team rows of whatsapp_channel_members for one account from whatsapp_channel_teams, team_members and teams.leader_user_id. Trigger-driven; not callable by clients. See migration 071.';

-- ============================================================
-- 4. Triggers
-- ============================================================

-- One function for all three tables: every one of them carries
-- account_id. Row-level: the tables are small, and a cascade fires
-- each row's trigger after its own delete, so the last sync to run
-- sees the final state.
CREATE OR REPLACE FUNCTION public.sync_channel_team_members_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM sync_channel_team_members(NEW.account_id);
  END IF;
  IF TG_OP = 'DELETE'
     OR (TG_OP = 'UPDATE' AND OLD.account_id IS DISTINCT FROM NEW.account_id) THEN
    PERFORM sync_channel_team_members(OLD.account_id);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_channel_team_members_trigger() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS team_members_sync_channels ON public.team_members;
CREATE TRIGGER team_members_sync_channels
  AFTER INSERT OR UPDATE OR DELETE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.sync_channel_team_members_trigger();

-- Also fires for the ON DELETE SET NULL when a leader's login is deleted.
DROP TRIGGER IF EXISTS teams_sync_channels ON public.teams;
CREATE TRIGGER teams_sync_channels
  AFTER UPDATE OF leader_user_id ON public.teams
  FOR EACH ROW
  WHEN (OLD.leader_user_id IS DISTINCT FROM NEW.leader_user_id)
  EXECUTE FUNCTION public.sync_channel_team_members_trigger();

DROP TRIGGER IF EXISTS whatsapp_channel_teams_sync ON public.whatsapp_channel_teams;
CREATE TRIGGER whatsapp_channel_teams_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.whatsapp_channel_teams
  FOR EACH ROW EXECUTE FUNCTION public.sync_channel_team_members_trigger();

-- Nothing triggers on whatsapp_channel_members itself, so the sync's
-- own writes cannot recurse.

-- ============================================================
-- 4b. Leaving an account leaves its teams
-- ============================================================

-- remove_account_member (018) and redeem_invitation (019) move a person
-- by re-pointing profiles.account_id; neither knows about teams. Their
-- team_members row in the old account would survive, and although the
-- derivation ignores people outside the account, nothing re-ran it: a
-- number whose only team just emptied stayed restricted in the database
-- while the UI showed it shared. A deleted profile is the same case.
-- Their DIRECT allocations in the old account go too: the sync only
-- maintains via-team rows, so a number ticked for them alone would
-- otherwise stay restricted to nobody. Every row of theirs there is
-- deleted (a via-team one would go with the sync anyway; a direct one
-- that a team also implied would survive it as direct).
-- The writes below fire the team triggers (which sync the old account);
-- none of them touches profiles, so this cannot recurse. The new
-- account is synced too: a team row someone was given there before they
-- joined takes effect now.
CREATE OR REPLACE FUNCTION public.profiles_leave_account_teams()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.account_id IS NOT NULL THEN
    -- The account's sync lock before any row (see the header).
    PERFORM pg_advisory_xact_lock(channel_access_lock_key(OLD.account_id));
    DELETE FROM whatsapp_channel_members
     WHERE user_id = OLD.user_id AND account_id = OLD.account_id;
    DELETE FROM team_members
     WHERE user_id = OLD.user_id AND account_id = OLD.account_id;
    UPDATE teams SET leader_user_id = NULL
     WHERE leader_user_id = OLD.user_id AND account_id = OLD.account_id;
    PERFORM sync_channel_team_members(OLD.account_id);
  END IF;
  IF TG_OP = 'UPDATE' THEN
    PERFORM sync_channel_team_members(NEW.account_id);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.profiles_leave_account_teams() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_leave_account_teams ON public.profiles;
CREATE TRIGGER profiles_leave_account_teams
  AFTER UPDATE OF account_id ON public.profiles
  FOR EACH ROW
  WHEN (OLD.account_id IS DISTINCT FROM NEW.account_id)
  EXECUTE FUNCTION public.profiles_leave_account_teams();

DROP TRIGGER IF EXISTS profiles_deleted_leave_teams ON public.profiles;
CREATE TRIGGER profiles_deleted_leave_teams
  AFTER DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_leave_account_teams();

-- ============================================================
-- 5. set_channel_members: the DIRECT list only
-- ============================================================

-- Same signature, checks, error codes and grants as 062. It now sets
-- only who is allocated by name: someone left out of the list loses
-- their direct allocation but keeps any access they have through a
-- team. (062 deleted every row not in the list, which would wipe the
-- derived rows on every save of the per-person checkboxes.)
CREATE OR REPLACE FUNCTION public.set_channel_members(
  p_config_id UUID,
  p_user_ids  UUID[]
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_account UUID := current_account_id();
  v_ids     UUID[] := COALESCE(p_user_ids, '{}');
BEGIN
  -- The account's sync lock first, then the row (see the header).
  IF v_account IS NULL OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'WhatsApp number not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(channel_access_lock_key(v_account));
  PERFORM 1 FROM whatsapp_config
   WHERE id = p_config_id AND account_id = v_account
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WhatsApp number not found' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(v_ids) AS u(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM profiles p WHERE p.user_id = u.id AND p.account_id = v_account
    )
  ) THEN
    RAISE EXCEPTION 'Every allocated person must be a member of this account'
      USING ERRCODE = '22023', HINT = 'member_not_in_account';
  END IF;

  -- Not in the list: a direct-only row goes; a row a team also implies
  -- stays, no longer direct. (Delete before update: the CHECK refuses a
  -- row with neither flag.)
  DELETE FROM whatsapp_channel_members
   WHERE config_id = p_config_id
     AND NOT via_team
     AND NOT (user_id = ANY (v_ids));

  UPDATE whatsapp_channel_members
     SET direct = FALSE
   WHERE config_id = p_config_id
     AND direct
     AND NOT (user_id = ANY (v_ids));

  INSERT INTO whatsapp_channel_members (config_id, user_id, account_id, direct)
  SELECT p_config_id, u.id, v_account, TRUE
    FROM (SELECT DISTINCT id FROM unnest(v_ids) AS x(id)) u
  ON CONFLICT (config_id, user_id) DO UPDATE
     SET direct = TRUE
   WHERE NOT whatsapp_channel_members.direct;
END;
$$;

REVOKE ALL ON FUNCTION public.set_channel_members(UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_channel_members(UUID, UUID[]) TO authenticated;

-- ============================================================
-- 6 + 7. Replace a number's teams / a team's numbers, atomically
-- ============================================================

-- SECURITY INVOKER, like set_channel_members: whatsapp_channel_teams'
-- admin-only RLS still decides every write, and the triggers above do
-- the derivation with their own rights. These only make the change
-- atomic and serialise concurrent edits on the row being edited.

CREATE OR REPLACE FUNCTION public.set_channel_teams(
  p_config_id UUID,
  p_team_ids  UUID[]
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_account UUID := current_account_id();
  v_ids     UUID[] := COALESCE(p_team_ids, '{}');
BEGIN
  -- The account's sync lock first, then the row (see the header).
  IF v_account IS NULL OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'WhatsApp number not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(channel_access_lock_key(v_account));
  PERFORM 1 FROM whatsapp_config
   WHERE id = p_config_id AND account_id = v_account
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WhatsApp number not found' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(v_ids) AS u(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM teams t WHERE t.id = u.id AND t.account_id = v_account
    )
  ) THEN
    RAISE EXCEPTION 'Every allocated team must belong to this account'
      USING ERRCODE = '22023', HINT = 'team_not_in_account';
  END IF;

  DELETE FROM whatsapp_channel_teams
   WHERE config_id = p_config_id
     AND NOT (team_id = ANY (v_ids));

  INSERT INTO whatsapp_channel_teams (config_id, team_id, account_id)
  SELECT p_config_id, u.id, v_account
    FROM (SELECT DISTINCT id FROM unnest(v_ids) AS x(id)) u
  ON CONFLICT (config_id, team_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.set_channel_teams(UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_channel_teams(UUID, UUID[]) TO authenticated;

COMMENT ON FUNCTION public.set_channel_teams(UUID, UUID[]) IS
  'Replaces the teams allocated to one WhatsApp number. Admin only. P0002 = number not found in the caller''s account; 22023 = a team outside it. See migration 071.';

CREATE OR REPLACE FUNCTION public.set_team_channels(
  p_team_id    UUID,
  p_config_ids UUID[]
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_account UUID := current_account_id();
  v_ids     UUID[] := COALESCE(p_config_ids, '{}');
BEGIN
  IF v_account IS NULL OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'Team not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(channel_access_lock_key(v_account));
  PERFORM 1 FROM teams
   WHERE id = p_team_id AND account_id = v_account
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Team not found' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(v_ids) AS u(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM whatsapp_config w WHERE w.id = u.id AND w.account_id = v_account
    )
  ) THEN
    RAISE EXCEPTION 'Every allocated number must belong to this account'
      USING ERRCODE = '22023', HINT = 'number_not_in_account';
  END IF;

  DELETE FROM whatsapp_channel_teams
   WHERE team_id = p_team_id
     AND NOT (config_id = ANY (v_ids));

  INSERT INTO whatsapp_channel_teams (config_id, team_id, account_id)
  SELECT u.id, p_team_id, v_account
    FROM (SELECT DISTINCT id FROM unnest(v_ids) AS x(id)) u
  ON CONFLICT (config_id, team_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.set_team_channels(UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_team_channels(UUID, UUID[]) TO authenticated;

COMMENT ON FUNCTION public.set_team_channels(UUID, UUID[]) IS
  'Replaces the WhatsApp numbers allocated to one team. Admin only. P0002 = team not found in the caller''s account; 22023 = a number outside it. See migration 071.';

-- ============================================================
-- 8. set_team_members: replace a team's people, atomically
-- ============================================================

-- The team screen used to delete the members and then insert the new
-- list as two requests. When the insert failed (most often: someone
-- already in another team), the team was left EMPTY, which since this
-- migration also strips the team-derived access of every member and,
-- for a number allocated only to that team, makes it shared with
-- everyone. Here a refusal changes nothing.
CREATE OR REPLACE FUNCTION public.set_team_members(
  p_team_id  UUID,
  p_user_ids UUID[]
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_account UUID := current_account_id();
  v_ids     UUID[] := COALESCE(p_user_ids, '{}');
BEGIN
  IF v_account IS NULL OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'Team not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(channel_access_lock_key(v_account));
  PERFORM 1 FROM teams
   WHERE id = p_team_id AND account_id = v_account
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Team not found' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(v_ids) AS u(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM profiles p WHERE p.user_id = u.id AND p.account_id = v_account
    )
  ) THEN
    RAISE EXCEPTION 'Every team member must be a member of this account'
      USING ERRCODE = '22023', HINT = 'member_not_in_account';
  END IF;

  -- One team per person (044's idx_team_members_one_team_per_user).
  -- Checked under the lock so the refusal names the rule; the index
  -- still backs it against a writer that bypasses these RPCs.
  IF EXISTS (
    SELECT 1 FROM team_members tm
     WHERE tm.account_id = v_account
       AND tm.team_id <> p_team_id
       AND tm.user_id = ANY (v_ids)
  ) THEN
    RAISE EXCEPTION 'Someone selected is already in another team. A person can only belong to one team.'
      USING ERRCODE = '23505', HINT = 'member_in_other_team';
  END IF;

  DELETE FROM team_members
   WHERE team_id = p_team_id
     AND NOT (user_id = ANY (v_ids));

  INSERT INTO team_members (team_id, user_id, account_id)
  SELECT p_team_id, u.id, v_account
    FROM (SELECT DISTINCT id FROM unnest(v_ids) AS x(id)) u
  ON CONFLICT (team_id, user_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.set_team_members(UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_team_members(UUID, UUID[]) TO authenticated;

COMMENT ON FUNCTION public.set_team_members(UUID, UUID[]) IS
  'Replaces the members of one team. Admin only; all or nothing. P0002 = team not found in the caller''s account; 22023 = a person outside it; 23505 (hint member_in_other_team) = someone already in another team. See migration 071.';

-- ============================================================
-- 9. update_team: everything the team form saves, in one transaction
-- ============================================================

-- NULL leaves a field alone, except the leader, where NULL means "no
-- leader" and p_set_leader says whether to write it. Name rules (trim,
-- length) stay in the route; this owns what needs the database.
CREATE OR REPLACE FUNCTION public.update_team(
  p_team_id        UUID,
  p_name           TEXT    DEFAULT NULL,
  p_set_leader     BOOLEAN DEFAULT FALSE,
  p_leader_user_id UUID    DEFAULT NULL,
  p_member_ids     UUID[]  DEFAULT NULL,
  p_config_ids     UUID[]  DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_account UUID := current_account_id();
BEGIN
  IF v_account IS NULL OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'Team not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(channel_access_lock_key(v_account));
  PERFORM 1 FROM teams
   WHERE id = p_team_id AND account_id = v_account
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Team not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_set_leader AND p_leader_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM profiles p
     WHERE p.user_id = p_leader_user_id AND p.account_id = v_account
  ) THEN
    RAISE EXCEPTION 'The team leader must be a member of this account'
      USING ERRCODE = '22023', HINT = 'leader_not_in_account';
  END IF;

  BEGIN
    UPDATE teams
       SET name = COALESCE(p_name, name),
           leader_user_id = CASE WHEN p_set_leader THEN p_leader_user_id
                                 ELSE leader_user_id END,
           updated_at = NOW()
     WHERE id = p_team_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'A team with that name already exists'
      USING ERRCODE = '23505', HINT = 'team_name_taken';
  END;

  IF p_member_ids IS NOT NULL THEN
    PERFORM set_team_members(p_team_id, p_member_ids);
  END IF;
  IF p_config_ids IS NOT NULL THEN
    PERFORM set_team_channels(p_team_id, p_config_ids);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_team(UUID, TEXT, BOOLEAN, UUID, UUID[], UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_team(UUID, TEXT, BOOLEAN, UUID, UUID[], UUID[]) TO authenticated;

COMMENT ON FUNCTION public.update_team(UUID, TEXT, BOOLEAN, UUID, UUID[], UUID[]) IS
  'Saves a team''s name, leader, members and numbers in one transaction. Admin only; NULL leaves a field alone (the leader is written only when p_set_leader). Errors as set_team_members / set_team_channels, plus 23505 hint team_name_taken and 22023 hint leader_not_in_account. See migration 071.';

-- ============================================================
-- 10. set_channel_access: a number's people and teams together
-- ============================================================

-- The numbers screen saves both lists at once. As two requests, a
-- failure on the second left the first applied — clearing the people
-- while the teams were refused could make a number shared. NULL leaves
-- that list unchanged. Same checks and errors as the two RPCs it calls.
CREATE OR REPLACE FUNCTION public.set_channel_access(
  p_config_id UUID,
  p_user_ids  UUID[],
  p_team_ids  UUID[]
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_account UUID := current_account_id();
BEGIN
  IF v_account IS NULL OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'WhatsApp number not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(channel_access_lock_key(v_account));
  PERFORM 1 FROM whatsapp_config
   WHERE id = p_config_id AND account_id = v_account
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WhatsApp number not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_user_ids IS NOT NULL THEN
    PERFORM set_channel_members(p_config_id, p_user_ids);
  END IF;
  IF p_team_ids IS NOT NULL THEN
    PERFORM set_channel_teams(p_config_id, p_team_ids);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_channel_access(UUID, UUID[], UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_channel_access(UUID, UUID[], UUID[]) TO authenticated;

COMMENT ON FUNCTION public.set_channel_access(UUID, UUID[], UUID[]) IS
  'Replaces a WhatsApp number''s direct people and/or teams in one transaction (NULL = leave that list). Admin only. P0002 = number not found; 22023 hint member_not_in_account / team_not_in_account. See migration 071.';
