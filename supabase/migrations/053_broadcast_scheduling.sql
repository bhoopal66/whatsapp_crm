-- ============================================================
-- 053_broadcast_scheduling.sql — scheduled sends, quiet hours, and
-- everything a server-side pass needs that the wizard used to keep in
-- the browser tab.
--
-- `broadcasts.scheduled_at` and the 'scheduled' status have existed
-- since 001, but nothing ever read them: the wizard's only options were
-- "send now" (from the tab) and "save draft". A scheduled campaign is
-- delivered by `GET /api/whatsapp/broadcast/cron`, which reuses the
-- resume machinery from migration 038 — claim the delivery lock, plan
-- from the frozen `broadcast_recipients.template_params`, fan out. Two
-- things that pass needs which the tab supplied per request:
--
--   1. header_media_url — the media header the admin chose in the
--      wizard. Without it a scheduled (or resumed) send of an image /
--      video / document template falls back to the template's stored
--      URL, which is usually the sample Meta approved, not the
--      campaign's asset.
--   2. quiet_hours — a per-campaign "do not send between HH:MM and
--      HH:MM" window with its IANA time zone. The cron defers a due
--      campaign to the end of the window instead of sending; the
--      wizard turns a "send now" inside the window into a schedule.
--      Stored as jsonb {start, end, tz} rather than three columns so a
--      campaign without one is a single NULL.
--
-- The frequency cap ("skip contacts messaged in the last N days") is
-- an audience option and lives in the existing `audience_filter` jsonb
-- (`skipRecentDays`); it needs no column.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- ============================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS header_media_url text;

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS quiet_hours jsonb;

-- The cron's only query: "which scheduled campaigns are due". Partial,
-- because almost every row is sent/draft.
CREATE INDEX IF NOT EXISTS idx_broadcasts_scheduled_due
  ON broadcasts (scheduled_at)
  WHERE status = 'scheduled';

COMMENT ON COLUMN broadcasts.quiet_hours IS
  'Optional {start: "HH:MM", end: "HH:MM", tz: IANA} window during which this campaign must not go out. Enforced by the broadcast cron and the wizard; see lib/broadcasts/quiet-hours.ts.';
