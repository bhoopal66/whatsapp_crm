-- 308: a customer who left a submission group under a hidden number.
--
-- A hidden (@lid) member leaving may be the customer. 174 wrote nothing for
-- it, so 'joined' stayed for good: the membership cron skips 'joined' and
-- Resend refuses it. The webhook now reports 'left_unsure'.
-- Apply before the build that sends it.

SET lock_timeout = '5s';

-- 174's body plus 'left_unsure' (never stored): only 'joined' is touched, it
-- becomes 'unknown' and, with no check on record, is first in line for the
-- cron's next read (sg_membership_due). Any other state keeps its stamp.
CREATE OR REPLACE FUNCTION public.sg_note_customer_membership(p_group uuid, p_state text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('unknown', 'unsure', 'left_unsure', 'joined', 'absent') THEN
    RAISE EXCEPTION 'submission group membership: % is not a state', coalesce(p_state, 'NULL')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_state = 'left_unsure' THEN
    UPDATE public.submission_groups
       SET customer_membership = 'unknown', customer_checked_at = NULL
     WHERE id = p_group AND status = 'ACTIVE' AND customer_membership = 'joined';
    RETURN FOUND;
  END IF;
  UPDATE public.submission_groups
     SET customer_membership = CASE
           WHEN p_state = 'unknown' THEN customer_membership
           WHEN p_state = 'unsure' AND customer_membership <> 'absent' THEN customer_membership
           WHEN p_state = 'unsure' THEN 'unknown'
           ELSE p_state
         END,
         customer_checked_at = now()
   WHERE id = p_group AND status = 'ACTIVE';
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.sg_note_customer_membership(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sg_note_customer_membership(uuid, text)
  TO service_role;

RESET lock_timeout;
