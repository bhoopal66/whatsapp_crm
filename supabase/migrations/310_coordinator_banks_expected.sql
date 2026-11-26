-- 310: setting a coordinator's banks compares with what the page showed.
--
-- set_coordinator_banks (133) replaces the whole set. An admin whose
-- Members screen was read before a colleague added a bank removed it again
-- without a word, and the coordinator lost that bank's cases, shared chats
-- and submission groups.
--
-- The overload's third argument is REQUIRED, so a call naming two fits
-- only 133's function and one naming three only this one: the old build
-- keeps working. It compares under 133's own row lock and then calls it.
-- Refusal: 22023 with the hint banks_changed.
--
-- Apply before the build that sends it; safe to run twice.
-- supabase/ci/verify-coordinator-banks-expected.sql asserts it.

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.set_coordinator_banks(p_user_id uuid, p_bank_codes text[], p_expected text[])
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct   uuid := public.current_account_id();
  v_stored text[];
  v_shown  text[];
BEGIN
  IF auth.uid() IS NULL OR v_acct IS NULL OR public.current_role_rank() < 4 THEN
    RAISE EXCEPTION 'Only an owner or admin can assign coordinator banks'
      USING ERRCODE = '42501';
  END IF;
  IF p_expected IS NULL THEN
    RAISE EXCEPTION 'The banks the page showed are required' USING ERRCODE = '22023';
  END IF;

  -- 133's lock, held to the end of the transaction.
  PERFORM 1 FROM public.profiles p
    WHERE p.user_id = p_user_id AND p.account_id = v_acct
    FOR UPDATE;

  SELECT coalesce(array_agg(b.bank_code ORDER BY b.bank_code), '{}') INTO v_stored
    FROM public.coordinator_banks b
   WHERE b.account_id = v_acct AND b.user_id = p_user_id;
  SELECT coalesce(array_agg(DISTINCT c ORDER BY c), '{}') INTO v_shown
    FROM unnest(p_expected) AS c
   WHERE c IS NOT NULL;
  IF v_stored <> v_shown THEN
    RAISE EXCEPTION 'The banks of this person were changed meanwhile'
      USING ERRCODE = '22023', HINT = 'banks_changed';
  END IF;

  RETURN public.set_coordinator_banks(p_user_id, p_bank_codes);
END;
$$;

REVOKE ALL ON FUNCTION public.set_coordinator_banks(uuid, text[], text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_coordinator_banks(uuid, text[], text[]) TO authenticated;

COMMENT ON FUNCTION public.set_coordinator_banks(uuid, text[], text[]) IS
  'set_coordinator_banks(uuid, text[]) that refuses (22023, banks_changed) when the stored banks are not the ones the page showed. Migration 310.';

RESET lock_timeout;
NOTIFY pgrst, 'reload schema';
