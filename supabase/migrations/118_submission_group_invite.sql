-- ============================================================
-- 118_submission_group_invite.sql — record the 1:1 invite link
--
-- When WhatsApp refuses to add the customer to a submission group
-- (their privacy settings), POST /api/v1/submission-groups sends them
-- the group's invite link 1:1 from the hosting number. Until now that
-- send left no trace: the API answered `invite_sent` once and the CRM
-- could not tell staff whether the customer had been invited. This
-- records the outcome on the group:
--
--  * submission_groups.invite_sent_at — when the invite link last went
--    out (NULL: never sent);
--  * submission_groups.invite_send_error — why the last attempt failed,
--    cleared by a later success. Capped at 500 characters.
--  The message text is not stored: it is the invite link, already on
--  the row as invite_link.
--
--  * sg_note_invite(p_group, p_sent, p_error) is the only writer
--    (115: the service role writes no table directly). It records on an
--    ACTIVE group only and returns false otherwise: an ENDED group stays
--    frozen except its close bookkeeping (115's submission_groups_guard,
--    unchanged here — its ACTIVE branch already lets non-identity
--    columns change).
--
-- The function writes an RLS-forced table, so, as 115, this must be
-- applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS, a guarded constraint,
-- CREATE OR REPLACE.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '118 must be applied by a superuser or BYPASSRLS role (sg_note_invite writes an RLS-forced table)';
  END IF;
END $$;

ALTER TABLE public.submission_groups
  ADD COLUMN IF NOT EXISTS invite_sent_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS invite_send_error text NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'submission_groups_invite_send_error_check'
       AND conrelid = 'public.submission_groups'::regclass
  ) THEN
    ALTER TABLE public.submission_groups
      ADD CONSTRAINT submission_groups_invite_send_error_check CHECK (
        invite_send_error IS NULL OR char_length(invite_send_error) BETWEEN 1 AND 500);
  END IF;
END $$;

-- The outcome of one 1:1 invite send. p_sent: stamp invite_sent_at and
-- clear the error. Otherwise: record p_error (trimmed to the cap; a
-- blank one becomes 'unknown error') and leave invite_sent_at alone —
-- an earlier invite still reached the customer. False when the group is
-- not ACTIVE (nothing is written).
CREATE OR REPLACE FUNCTION public.sg_note_invite(p_group uuid, p_sent boolean, p_error text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_sent THEN
    UPDATE public.submission_groups
       SET invite_sent_at = now(), invite_send_error = NULL
     WHERE id = p_group AND status = 'ACTIVE';
  ELSE
    UPDATE public.submission_groups
       SET invite_send_error = left(coalesce(nullif(btrim(p_error), ''), 'unknown error'), 500)
     WHERE id = p_group AND status = 'ACTIVE';
  END IF;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.sg_note_invite(uuid, boolean, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sg_note_invite(uuid, boolean, text)
  TO service_role;

RESET lock_timeout;
