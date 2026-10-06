-- ============================================================
-- 069: deactivate a member without removing them
--
-- Removing a member (018) moves them to a fresh personal account: their
-- login survives and they can still sign in, just to an empty CRM. That
-- is the wrong tool for "this person has left / is suspended". This adds
-- a reversible switch: a deactivated member stays on the roster, keeps
-- their role, their assignments and their history, and cannot use the
-- application at all.
--
-- Enforcement is in three places, because each one alone has a gap:
--
--   1. Supabase Auth ban (set by the API route, not here). Refuses the
--      password sign-in and every refresh-token grant. It does NOT
--      invalidate an access token already issued — those stay valid
--      until they expire (GOTRUE_JWT_EXP, 1 hour by default).
--
--   2. This file. The three helpers every RLS policy funnels through —
--      is_account_member (044), current_account_id and
--      current_role_rank (059) — stop recognising a deactivated
--      profile, so a still-valid access token reads and writes nothing.
--      Realtime replays the same RLS, so subscriptions go quiet too.
--
--   3. The profile guard trigger refuses any profiles write made on
--      behalf of a deactivated caller. Every member/ownership RPC
--      (set_member_role, remove_account_member, transfer, this file's
--      set_member_active) writes profiles, and they read the caller's
--      role straight from the table rather than through
--      is_account_member — so without this a deactivated admin's
--      leftover token could still change roles for up to an hour.
--
-- What is deliberately NOT gated here: the few storage policies (057)
-- that join profiles on auth.uid() directly. They expire with the
-- access token, as in (1).
--
-- The owner can never be deactivated (an account must keep someone who
-- can turn people back on), and nobody can deactivate themselves.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE / DROP … IF
-- EXISTS.
-- ============================================================


-- ---------- schema ----------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deactivated_by UUID
    REFERENCES auth.users(id) ON DELETE SET NULL;


-- ---------- the RLS choke points ----------

-- Body as 044, plus the deactivation test.
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
      AND p.deactivated_at IS NULL
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

-- Bodies as 059. NULL / 0 for a deactivated caller, which every policy
-- built on them already treats as "no profile": nothing matches.
CREATE OR REPLACE FUNCTION public.current_account_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT account_id FROM profiles
  WHERE user_id = auth.uid() AND deactivated_at IS NULL
$$;

CREATE OR REPLACE FUNCTION public.current_role_rank()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE((
    SELECT CASE account_role
             WHEN 'owner'       THEN 5
             WHEN 'admin'       THEN 4
             WHEN 'team_leader' THEN 3
             WHEN 'agent'       THEN 2
             WHEN 'viewer'      THEN 1
             ELSE 0
           END
    FROM profiles
    WHERE user_id = auth.uid() AND deactivated_at IS NULL
  ), 0)
$$;


-- ---------- profile guard ----------

-- Body as 057, plus: the deactivation columns are RPC-only like the
-- role, and a deactivated caller may not write any profile row (see
-- the header, point 3). auth.uid() reads the request's JWT, not
-- current_user, so the second check also fires inside SECURITY DEFINER
-- RPCs. The service role carries no `sub`, so server-side jobs pass.
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user = 'authenticated' AND (
       TG_OP = 'INSERT'
       OR NEW.account_role IS DISTINCT FROM OLD.account_role
       OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.deactivated_at IS DISTINCT FROM OLD.deactivated_at
       OR NEW.deactivated_by IS DISTINCT FROM OLD.deactivated_by
     )
  THEN
    RAISE EXCEPTION
      'account_role, account_id and deactivation cannot be changed directly; use the account member/invitation RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF auth.uid() IS NOT NULL AND EXISTS (
       SELECT 1 FROM profiles
       WHERE user_id = auth.uid() AND deactivated_at IS NOT NULL
     )
  THEN
    RAISE EXCEPTION 'Your access to this account has been deactivated'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_profile_privilege_columns() OWNER TO postgres;


-- ---------- set_member_active ----------
--
-- Admin+ deactivates or reactivates another member of their own
-- account. Same caller/target rules and SQLSTATE contract as
-- set_member_role (018): 42501 forbidden, 22023 bad input. Idempotent —
-- deactivating an already-deactivated member keeps the original
-- timestamp and author.

CREATE OR REPLACE FUNCTION public.set_member_active(
  p_user_id UUID,
  p_active BOOLEAN
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_caller_deactivated TIMESTAMPTZ;
  v_target_account_id UUID;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role, deactivated_at
  INTO v_caller_account_id, v_caller_role, v_caller_deactivated
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_deactivated IS NOT NULL THEN
    RAISE EXCEPTION 'Your access to this account has been deactivated'
      USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_active IS NULL THEN
    RAISE EXCEPTION 'p_active is required' USING ERRCODE = '22023';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot deactivate or reactivate yourself'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
  INTO v_target_account_id, v_target_role
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'The account owner cannot be deactivated'
      USING ERRCODE = '22023';
  END IF;

  IF p_active THEN
    UPDATE profiles
    SET deactivated_at = NULL, deactivated_by = NULL
    WHERE user_id = p_user_id;
  ELSE
    UPDATE profiles
    SET deactivated_at = COALESCE(deactivated_at, NOW()),
        deactivated_by = COALESCE(deactivated_by, auth.uid())
    WHERE user_id = p_user_id;
  END IF;
END;
$$;

ALTER FUNCTION public.set_member_active(UUID, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_active(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_active(UUID, BOOLEAN) TO authenticated;
