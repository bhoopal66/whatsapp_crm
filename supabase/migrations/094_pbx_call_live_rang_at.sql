-- ============================================================
-- 094 — when a screen pop's call first rang (module 015).
--
-- The incoming-call card counted the ring from its own first render,
-- so a reload restarted the count at 0:00. call_live.rang_at is the
-- database's time of the call's first frame:
--
--   * The processor upserts call_live on (connection_id, pbx_call_id)
--     with a payload that leaves rang_at out. PostgREST's
--     ON CONFLICT DO UPDATE sets only the payload's columns, so the
--     default stamps the first frame and every later frame keeps it.
--     Never put rang_at in that payload.
--   * The row is deleted when the call ends (30012, or every member
--     BYE), so a number that rings again is a new row and a new stamp.
--   * An answered call that rings again keeps its row: a blind
--     transfer, or a leg dropped back to the queue, sets answered_by
--     back to NULL. call_live_rang_at_restamp stamps rang_at again
--     then, so whoever it rings now does not see the first ring plus
--     the whole talk ("5:xx" for a ring that just started).
--   * The card (ringElapsedMs, src/lib/pbx/call-ui.ts) counts on the
--     server's clocks (updated_at − rang_at, plus the browser's time
--     since that frame arrived), never less than since it first showed
--     the call, and falls back to that when rang_at is missing (before
--     this migration) or older than any ring.
--
-- 089's table-level SELECT grant and its supabase_realtime entry (no
-- column list) cover the new column: the provider's select('*') and
-- the realtime row both carry it. Re-runnable. Needs only 089.
-- ============================================================

ALTER TABLE public.call_live
  ADD COLUMN IF NOT EXISTS rang_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.call_live.rang_at IS
  'When the call last started ringing: stamped by the default on the first frame, kept by later upserts (their payload leaves it out), stamped again when answered_by goes back to NULL (call_live_rang_at_restamp). The ring timer of the incoming-call card. Migration 094.';

CREATE OR REPLACE FUNCTION public.call_live_rang_at_restamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.rang_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS call_live_rang_at_restamp ON public.call_live;
CREATE TRIGGER call_live_rang_at_restamp
  BEFORE UPDATE ON public.call_live
  FOR EACH ROW
  WHEN (OLD.answered_by IS NOT NULL AND NEW.answered_by IS NULL)
  EXECUTE FUNCTION public.call_live_rang_at_restamp();
