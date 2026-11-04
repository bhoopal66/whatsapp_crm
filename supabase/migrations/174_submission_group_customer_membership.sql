-- ============================================================
-- 174_submission_group_customer_membership.sql — whether the customer
-- is actually in their submission group.
--
-- WhatsApp sometimes refuses to add a customer; they get an invite link
-- and nothing recorded whether they ever joined, so staff could not see
-- a group the customer never entered.
--
--  * submission_groups.customer_membership: 'unknown' (nobody has
--    looked yet, or the look failed), 'joined', 'absent'.
--    customer_checked_at: when the app last asked WhatsApp. Written only
--    by the two functions here and the backfill.
--  * submission_groups_guard needs no change. It names the frozen
--    columns of an ACTIVE row and these are not among them; an ENDED
--    row is compared whole through to_jsonb, so they are frozen with the
--    rest of the archive. That is why every write below is confined to
--    ACTIVE, the backfill included: touching an ENDED row raises.
--  * sg_note_customer_membership(group, state): the app's report of one
--    check, always stamping customer_checked_at. 'unknown' (the check
--    could not tell) stamps only and never overwrites a known state.
--    'joined' and 'absent' replace each other: a customer can leave.
--  * sg_membership_due(account, limit): the ACTIVE real groups to look
--    at next, never checked first, then oldest check first, each at
--    most once in 6 hours. 'joined' is settled and not looked at again;
--    'absent' and 'unknown' keep being looked at.
--  * submission_group_messages_customer_joined: a customer who wrote is
--    in the group, whatever a check said. AFTER INSERT, so it runs under
--    the FOR NO KEY UPDATE the BEFORE guard (115, 170) already took on
--    the group row for an 'in' row. The UPDATE needs that same lock, so
--    there is nothing to upgrade and nothing to wait for on the inbound
--    path; lock_timeout is there as in 173. A failure is a WARNING and
--    never loses the message.
--  * sg_backfill_customer_membership(), run here: an ACTIVE group still
--    'unknown' with a customer message becomes 'joined'. Only 'unknown':
--    a re-run must not undo an 'absent' a later check recorded. A
--    function, as 173's backfill, so the verify file runs this UPDATE
--    and not a copy of it. It runs after the trigger exists, so a
--    message arriving during the apply is caught by one or the other.
--    Everything else stays 'unknown': the app checks those.
--
-- The SECURITY DEFINER functions write an RLS-forced table, so, as in
-- 115, this must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE with the same
-- signatures, DROP … IF EXISTS. Asserted by
-- supabase/ci/verify-submission-group-membership.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '174 must be applied by a superuser or BYPASSRLS role (the functions write RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. The columns ----------

ALTER TABLE public.submission_groups
  ADD COLUMN IF NOT EXISTS customer_membership text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS customer_checked_at timestamptz NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'submission_groups_customer_membership_check'
       AND conrelid = 'public.submission_groups'::regclass
  ) THEN
    ALTER TABLE public.submission_groups
      ADD CONSTRAINT submission_groups_customer_membership_check
      CHECK (customer_membership IN ('unknown', 'joined', 'absent'));
  END IF;
END $$;

COMMENT ON COLUMN public.submission_groups.customer_membership IS
  'Is the customer in the WhatsApp group: unknown, joined or absent. Written by sg_note_customer_membership and the customer-message trigger, ACTIVE groups only. Migration 174.';
COMMENT ON COLUMN public.submission_groups.customer_checked_at IS
  'When the app last asked WhatsApp about the customer, whatever the answer. NULL: never. Migration 174.';

-- ---------- 2. sg_note_customer_membership ----------

-- False when the group is not ACTIVE (nothing is written).
CREATE OR REPLACE FUNCTION public.sg_note_customer_membership(p_group uuid, p_state text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('unknown', 'joined', 'absent') THEN
    RAISE EXCEPTION 'submission group membership: % is not a state', coalesce(p_state, 'NULL')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.submission_groups
     SET customer_membership = CASE WHEN p_state = 'unknown' THEN customer_membership ELSE p_state END,
         customer_checked_at = now()
   WHERE id = p_group AND status = 'ACTIVE';
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.sg_note_customer_membership(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sg_note_customer_membership(uuid, text)
  TO service_role;

-- ---------- 3. sg_membership_due ----------

-- greatest() skips a NULL, so a NULL or negative limit returns nothing
-- rather than every group or an error.
CREATE OR REPLACE FUNCTION public.sg_membership_due(p_account uuid, p_limit integer)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT g.id
    FROM public.submission_groups g
   WHERE g.account_id = p_account
     AND g.status = 'ACTIVE'
     AND g.wa_mode = 'group'
     AND g.wa_group_id IS NOT NULL
     AND g.channel_id IS NOT NULL
     AND g.customer_membership <> 'joined'
     AND (g.customer_checked_at IS NULL OR g.customer_checked_at < now() - interval '6 hours')
   ORDER BY g.customer_checked_at ASC NULLS FIRST, g.created_at, g.id
   LIMIT greatest(p_limit, 0)
$$;

REVOKE ALL ON FUNCTION public.sg_membership_due(uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sg_membership_due(uuid, integer)
  TO service_role;

-- ---------- 4. A customer who wrote has joined ----------

-- lock_timeout: as sg_ring_customer_message (173), query_canceled is
-- outside WHEN OTHERS and a lock timeout (55P03) is not. ACTIVE only:
-- the guard refuses an ENDED row, and that refusal would be a WARNING
-- on every late message.
CREATE OR REPLACE FUNCTION public.sg_customer_wrote()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '1s'
AS $$
BEGIN
  IF NEW.direction IS DISTINCT FROM 'in' OR NEW.sender_kind IS DISTINCT FROM 'customer' THEN
    RETURN NULL;
  END IF;
  BEGIN
    UPDATE public.submission_groups
       SET customer_membership = 'joined'
     WHERE id = NEW.group_id AND status = 'ACTIVE' AND customer_membership <> 'joined';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'sg_customer_wrote: group %: % (%)', NEW.group_id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.sg_customer_wrote() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.sg_customer_wrote() IS
  'AFTER INSERT on submission_group_messages: a customer''s message marks an ACTIVE group''s customer_membership joined. A failure is a WARNING. Migration 174.';

DROP TRIGGER IF EXISTS submission_group_messages_customer_joined ON public.submission_group_messages;
CREATE TRIGGER submission_group_messages_customer_joined
  AFTER INSERT ON public.submission_group_messages
  FOR EACH ROW
  WHEN (NEW.direction = 'in' AND NEW.sender_kind = 'customer')
  EXECUTE FUNCTION public.sg_customer_wrote();

-- ---------- 5. Backfill ----------

CREATE OR REPLACE FUNCTION public.sg_backfill_customer_membership()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE public.submission_groups g
     SET customer_membership = 'joined'
   WHERE g.status = 'ACTIVE'
     AND g.customer_membership = 'unknown'
     AND EXISTS (
       SELECT 1 FROM public.submission_group_messages m
        WHERE m.group_id = g.id AND m.direction = 'in' AND m.sender_kind = 'customer');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.sg_backfill_customer_membership()
  FROM PUBLIC, anon, authenticated, service_role;

SELECT public.sg_backfill_customer_membership();

RESET lock_timeout;
