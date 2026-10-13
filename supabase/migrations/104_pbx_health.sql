-- ============================================================
-- 104_pbx_health.sql — phone system link health (module 015)
--
-- Settings → Phone system shows how events reach the CRM, and owners
-- and admins hear about a link that went quiet (docs/yeastar.md):
--
-- 1. pbx_connections gains
--    - last_event_via: which path carried the latest event, 'webhook'
--      (Yeastar's push) or 'gateway' (the WebSocket gateway, its
--      call-record backfill included). NULL until an event says.
--    - last_backfill_at / last_backfill: when the gateway last filled a
--      gap from call records, and what it found ({from, to, records,
--      ingested, duplicates, failed}). NULL on a webhook-only install.
--    - silence_alerted_at: set when the silence alert went out, cleared
--      when events resume. The state that makes each alert ring once.
-- 2. last_event_at only moves forward. The retry sweep re-runs an old
--    frame with its own (older) received_at, and two deliveries can
--    finish out of order; an earlier stamp is ignored, and so is the
--    path it names (last_event_via stays the one that carried the
--    latest event), so a retry never makes a live link look silent.
--    NULL (a deliberate reset) is kept.
-- 3. notifications_type_check gains 'pbx_connection_silent' and
--    'pbx_connection_restored' (097 is the last list; every type it
--    names is kept).
-- 4. pbx_connection_silence(): the PBX cron's one write per connection.
--    p_silent = true stamps silence_alerted_at only while it is NULL and
--    the latest event is at least p_quiet_minutes old; false clears it
--    only once an event arrived after the alert. Either way the owners
--    and admins of the connection's workspace (live profiles) get one
--    bell, in the same statement. A second call, or an overlapping
--    sweep, finds the state already moved and rings nothing. Working
--    hours are the caller's decision (lib/pbx/health.ts). The bell text
--    is English, as every bell written in SQL is (097's
--    call_outcome_due): the bell page shows a row's title as stored.
--
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
ALTER TABLE public.pbx_connections
  ADD COLUMN IF NOT EXISTS silence_alerted_at timestamptz NULL;

COMMENT ON COLUMN public.pbx_connections.last_event_via IS
  'Which path carried the latest event: webhook (Yeastar''s push) or gateway (the WebSocket gateway and its backfill). Migration 104.';
COMMENT ON COLUMN public.pbx_connections.last_backfill_at IS
  'When the gateway last filled a gap from call records (POST /api/pbx/gateway/backfill). NULL on a webhook-only install. Migration 104.';
COMMENT ON COLUMN public.pbx_connections.last_backfill IS
  'That backfill''s window and counts: {from, to, records, ingested, duplicates, failed}. Migration 104.';
COMMENT ON COLUMN public.pbx_connections.silence_alerted_at IS
  'Set by pbx_connection_silence when owners and admins were told the link went quiet; cleared when events resume. Migration 104.';

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

-- ---------- 3. The bell types ----------
ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned',
    'channel_disconnected',
    'channel_reconnected',
    'team_activity_alert',
    'ai_handoff',
    'task_assigned',
    'task_due',
    'chat_mention',
    'chat_dm',
    'chat_thread_reply',
    'chat_broadcast',
    'call_missed',
    'callback_requested',
    'deal_room_join_request',
    'deal_room_update',
    'call_outcome_due',
    'pbx_connection_silent',
    'pbx_connection_restored'
  ));

-- ---------- 4. The alert ----------
CREATE OR REPLACE FUNCTION public.pbx_connection_silence(
  p_connection_id uuid,
  p_silent boolean,
  p_quiet_minutes integer DEFAULT 15
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rung integer;
BEGIN
  IF p_silent THEN
    WITH moved AS (
      UPDATE pbx_connections c
         SET silence_alerted_at = now()
       WHERE c.id = p_connection_id
         AND c.silence_alerted_at IS NULL
         AND c.last_event_at IS NOT NULL
         AND c.last_event_at <= now() - make_interval(mins => GREATEST(COALESCE(p_quiet_minutes, 15), 1))
      RETURNING c.id, c.account_id, c.label, c.last_event_at,
                floor(extract(epoch FROM now() - c.last_event_at) / 60)::bigint AS quiet
    )
    INSERT INTO notifications (account_id, user_id, type, title, body, meta)
    SELECT m.account_id, p.user_id, 'pbx_connection_silent',
           'No phone system events for '
             || CASE WHEN m.quiet < 120 THEN m.quiet || ' minutes'
                     WHEN m.quiet < 2880 THEN (m.quiet / 60) || ' hours'
                     ELSE (m.quiet / 1440) || ' days' END,
           'Nothing has arrived from ' || m.label || ' during working hours, so calls may be '
             || 'missing from the CRM. Check that Yeastar still pushes events to the webhook, '
             || 'or that the gateway is running, under Settings → Phone system.',
           jsonb_build_object('connection_id', m.id, 'last_event_at', m.last_event_at)
      FROM moved m
      JOIN profiles p ON p.account_id = m.account_id
     WHERE p.account_role IN ('owner', 'admin')
       AND p.deactivated_at IS NULL;
  ELSE
    WITH moved AS (
      UPDATE pbx_connections c
         SET silence_alerted_at = NULL
       WHERE c.id = p_connection_id
         AND c.silence_alerted_at IS NOT NULL
         AND c.last_event_at > c.silence_alerted_at
      RETURNING c.id, c.account_id, c.label, c.last_event_at
    )
    INSERT INTO notifications (account_id, user_id, type, title, body, meta)
    SELECT m.account_id, p.user_id, 'pbx_connection_restored',
           'Phone system events are arriving again',
           m.label || ' is sending events again.',
           jsonb_build_object('connection_id', m.id, 'last_event_at', m.last_event_at)
      FROM moved m
      JOIN profiles p ON p.account_id = m.account_id
     WHERE p.account_role IN ('owner', 'admin')
       AND p.deactivated_at IS NULL;
  END IF;
  GET DIAGNOSTICS v_rung = ROW_COUNT;
  RETURN v_rung;
END;
$$;
COMMENT ON FUNCTION public.pbx_connection_silence(uuid, boolean, integer) IS
  'PBX cron: p_silent stamps silence_alerted_at once the latest event is p_quiet_minutes old and rings pbx_connection_silent; false clears it once an event arrived after the alert and rings pbx_connection_restored. Owners and admins of the connection''s workspace, once per transition. Service role only. Migration 104.';

REVOKE ALL ON FUNCTION public.pbx_connection_silence(uuid, boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pbx_connection_silence(uuid, boolean, integer) TO service_role;
