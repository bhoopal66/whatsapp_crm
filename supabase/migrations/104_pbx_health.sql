-- ============================================================
-- 104_pbx_health.sql — phone system link health (module 015)
--
-- Settings → Phone system shows how events reach the CRM
-- (docs/yeastar.md):
--
-- 1. pbx_connections gains
--    - last_event_via: which path carried the latest event, 'webhook'
--      (Yeastar's push) or 'gateway' (the WebSocket gateway, its
--      call-record backfill included). NULL until an event says.
--    - last_backfill_at / last_backfill: when the gateway last filled a
--      gap from call records, and what it found ({from, to, records,
--      ingested, duplicates, failed}). NULL on a webhook-only install.
-- 2. last_event_at only moves forward. The retry sweep re-runs an old
--    frame with its own (older) received_at, and two deliveries can
--    finish out of order; an earlier stamp is ignored, and so is the
--    path it names (last_event_via stays the one that carried the
--    latest event), so a retry never makes a live link look silent.
--    NULL (a deliberate reset) is kept.
-- Re-runnable.
-- ============================================================

-- ---------- 1. Columns ----------
ALTER TABLE public.pbx_connections
  ADD COLUMN IF NOT EXISTS last_event_via text NULL
    CHECK (last_event_via IN ('webhook', 'gateway'));
ALTER TABLE public.pbx_connections
  ADD COLUMN IF NOT EXISTS last_backfill_at timestamptz NULL;
ALTER TABLE public.pbx_connections
  ADD COLUMN IF NOT EXISTS last_backfill jsonb NULL;

COMMENT ON COLUMN public.pbx_connections.last_event_via IS
  'Which path carried the latest event: webhook (Yeastar''s push) or gateway (the WebSocket gateway and its backfill). Migration 104.';
COMMENT ON COLUMN public.pbx_connections.last_backfill_at IS
  'When the gateway last filled a gap from call records (POST /api/pbx/gateway/backfill). NULL on a webhook-only install. Migration 104.';
COMMENT ON COLUMN public.pbx_connections.last_backfill IS
  'That backfill''s window and counts: {from, to, records, ingested, duplicates, failed}. Migration 104.';


-- ---------- 2. last_event_at only moves forward ----------
CREATE OR REPLACE FUNCTION public.pbx_connections_event_clock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.last_event_at < OLD.last_event_at THEN
    NEW.last_event_at := OLD.last_event_at;
    NEW.last_event_via := OLD.last_event_via;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pbx_connections_event_clock ON public.pbx_connections;
CREATE TRIGGER pbx_connections_event_clock
  BEFORE UPDATE OF last_event_at, last_event_via ON public.pbx_connections
  FOR EACH ROW EXECUTE FUNCTION public.pbx_connections_event_clock();
