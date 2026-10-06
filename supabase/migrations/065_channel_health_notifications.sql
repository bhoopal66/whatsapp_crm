-- ============================================================
-- 065_channel_health_notifications
--
-- Lets the channel health monitor (GET /api/whatsapp/health/cron,
-- lib/whatsapp/channel-health.ts) tell admins when a Whapi number
-- drops off WhatsApp and when it comes back.
--
-- Until now nothing watched a Whapi channel: whatsapp_config.status was
-- written once at connect time and stayed 'connected' through a
-- logged-out (QR) session, while every reply from that number failed.
-- The monitor now flips that column and inserts one notification per
-- owner/admin on each transition — which needs these two types.
--
-- The alerts carry no conversation (conversation_id NULL); the column
-- was already nullable. No new columns: whatsapp_config.status already
-- holds the previous state, and a per-tick "last checked" column would
-- fire the updated_at trigger every few minutes.
--
-- Idempotent — safe to re-run.
-- ============================================================

SET lock_timeout = '5s';

-- 027 declared the check inline, so Postgres named it
-- notifications_type_check. Keep every value it allowed.
ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned',
    'channel_disconnected',
    'channel_reconnected'
  ));

RESET lock_timeout;
