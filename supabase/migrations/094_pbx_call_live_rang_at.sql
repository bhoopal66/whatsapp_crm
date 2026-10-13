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
--   * The card (ringElapsedMs, src/lib/pbx/call-ui.ts) never counts
--     less than since it first showed the call, and falls back to that
--     when rang_at is missing (before this migration), ahead of the
--     browser's clock or older than any ring.
--
-- 089's table-level SELECT grant and its supabase_realtime entry (no
-- column list) cover the new column: the provider's select('*') and
-- the realtime row both carry it. Re-runnable. Needs only 089.
-- ============================================================

ALTER TABLE public.call_live
  ADD COLUMN IF NOT EXISTS rang_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.call_live.rang_at IS
  'When the call first rang: stamped by the default on the first frame, kept by later upserts (their payload leaves it out). The ring timer of the incoming-call card. Migration 094.';
