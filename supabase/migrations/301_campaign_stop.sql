-- ============================================================
-- 301_campaign_stop.sql: a running or scheduled campaign can be stopped.
--
-- Until now the only way out of a campaign was deleting it, which erases
-- who received it, and a campaign being sent could not even be deleted.
--
--   1. broadcasts.status may be 'stopped'. Its recipients stay pending,
--      so Resume can send the rest. No sender picks it up: the cron reads
--      'scheduled' and 'sending' only.
--   2. broadcast_recipients_stopped_guard: the write-ahead mark (see
--      src/lib/broadcasts/unconfirmed-send.ts, SEND_UNCONFIRMED_REASON;
--      the text below is the same) is written before every send. Written
--      while the campaign is not 'sending' it changes nothing, so a stop
--      also holds for a pass that is already running, whichever build it
--      runs on. The stamp after a send does not change the reason, so it
--      is never held back.
--   3. broadcast_stop(): the caller's rights, so admins, like resume and
--      delete (broadcasts_update, migration 135).
--   4. broadcasts.skip_recent_days: the frequency cap, for the check the
--      delivery makes before each send. NULL: none. Until now it was only
--      in audience_filter, read when the campaign was built.
--
-- Re-runnable.
-- ============================================================

SET lock_timeout = '5s';

ALTER TABLE public.broadcasts DROP CONSTRAINT IF EXISTS broadcasts_status_check;
ALTER TABLE public.broadcasts ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'stopped'));

CREATE OR REPLACE FUNCTION public.broadcast_recipients_stopped_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.broadcasts b
              WHERE b.id = NEW.broadcast_id AND b.status = 'sending') THEN
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.broadcast_recipients_stopped_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS broadcast_recipients_stopped_guard ON public.broadcast_recipients;
CREATE TRIGGER broadcast_recipients_stopped_guard
  BEFORE UPDATE OF error_message ON public.broadcast_recipients
  FOR EACH ROW
  WHEN (NEW.error_message = 'May have been sent - WhatsApp did not confirm it so it is not sent again'
        AND OLD.error_message IS DISTINCT FROM NEW.error_message
        AND NEW.status = OLD.status)
  EXECUTE FUNCTION public.broadcast_recipients_stopped_guard();

CREATE OR REPLACE FUNCTION public.broadcast_stop(p_broadcast uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  UPDATE public.broadcasts
     SET status = 'stopped', updated_at = now()
   WHERE id = p_broadcast AND status IN ('sending', 'scheduled');
  IF NOT FOUND THEN
    SELECT status INTO v_status FROM public.broadcasts WHERE id = p_broadcast;
    IF v_status IS NULL THEN
      RAISE EXCEPTION 'Campaign not found' USING ERRCODE = 'P0002';
    ELSIF v_status IN ('sending', 'scheduled') THEN
      RAISE EXCEPTION 'Only an admin can stop a campaign' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'This campaign is not being sent or scheduled' USING ERRCODE = '55000';
  END IF;
  -- A marked row is the message being sent now: it is not left to send.
  RETURN (SELECT jsonb_build_object(
      'sent', count(*) FILTER (WHERE status IN ('sent', 'delivered', 'read', 'replied')),
      'remaining', count(*) FILTER (WHERE status = 'pending' AND error_message IS DISTINCT FROM
        'May have been sent - WhatsApp did not confirm it so it is not sent again'))
    FROM public.broadcast_recipients WHERE broadcast_id = p_broadcast);
END;
$$;
REVOKE ALL ON FUNCTION public.broadcast_stop(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broadcast_stop(uuid) TO authenticated, service_role;

ALTER TABLE public.broadcasts
  ADD COLUMN IF NOT EXISTS skip_recent_days integer CHECK (skip_recent_days > 0);

RESET lock_timeout;
