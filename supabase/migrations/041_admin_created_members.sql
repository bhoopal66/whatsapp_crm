-- ============================================================
-- 041: admin-created members
--
-- Self-service signup is gone: nobody creates their own login any
-- more. An admin provisions each teammate from Settings -> Members,
-- choosing their role up front.
--
-- The wrinkle is `handle_new_user()` (migration 001), which fires on
-- every auth.users INSERT and gives the new user their OWN account,
-- owning it. That is right for a signup and wrong for a provisioned
-- teammate, who must land in the admin's account with the admin's
-- chosen role. Rather than special-case the trigger — which would
-- mean the trigger needing to know why the row appeared — this
-- function undoes it: move the profile, drop the orphan account.
--
-- It is the same manoeuvre `redeem_invitation` performs, minus the
-- invitation. Kept as a SECURITY DEFINER function rather than three
-- statements in the API route so the move is atomic: a failure
-- halfway through would otherwise strand the new user as the owner
-- of a private account, invisible in the roster they were meant to
-- join.
-- ============================================================

CREATE OR REPLACE FUNCTION public.provision_account_member(
  p_user_id    UUID,
  p_account_id UUID,
  p_role       account_role_enum
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_old_account_id UUID;
  v_old_owner      UUID;
BEGIN
  -- An owner can only be the account's owner, and there is exactly
  -- one of those. Promoting to owner is `transfer_ownership`, which
  -- also demotes the incumbent; minting a second one here would
  -- leave the account with two.
  IF p_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot provision a member as owner; transfer ownership instead'
      USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = p_user_id;

  IF v_old_account_id IS NULL THEN
    -- handle_new_user() swallows its own failures with a WARNING, so
    -- a missing profile here means the bootstrap silently failed.
    RAISE EXCEPTION 'No profile for user %; account bootstrap failed', p_user_id
      USING ERRCODE = '22023';
  END IF;

  IF v_old_account_id = p_account_id THEN
    RAISE EXCEPTION 'User is already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  -- This function is only ever called with a user created seconds
  -- ago by the members API, so the account it is about to discard
  -- should be that user's own empty one. Refuse if it is anything
  -- else: silently deleting an account with members or data would be
  -- catastrophic and unrecoverable.
  IF v_old_owner <> p_user_id THEN
    RAISE EXCEPTION 'Refusing to move a user who does not own their current account'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM profiles
    WHERE account_id = v_old_account_id AND user_id <> p_user_id
  ) THEN
    RAISE EXCEPTION 'Refusing to delete an account that has other members'
      USING ERRCODE = '42501';
  END IF;

  -- Move the profile BEFORE dropping the account, so the account's
  -- ON DELETE CASCADE doesn't take the profile with it.
  UPDATE profiles
  SET account_id   = p_account_id,
      account_role = p_role
  WHERE user_id = p_user_id;

  DELETE FROM accounts WHERE id = v_old_account_id;
END;
$$;

-- Callable only by the service role: the members API authenticates
-- and authorises the admin before it ever gets here, and nothing
-- client-side has any business moving a profile between accounts.
REVOKE ALL ON FUNCTION public.provision_account_member(UUID, UUID, account_role_enum) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.provision_account_member(UUID, UUID, account_role_enum) FROM anon, authenticated;

COMMENT ON FUNCTION public.provision_account_member(UUID, UUID, account_role_enum) IS
  'Move a just-created user out of the personal account handle_new_user() gave them and into p_account_id with p_role. Service-role only; see migration 041.';
