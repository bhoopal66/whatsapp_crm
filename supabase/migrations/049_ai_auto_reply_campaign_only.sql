-- ============================================================
-- 049_ai_auto_reply_campaign_only.sql — let the bot answer only
-- campaign replies.
--
-- With auto-reply on, the bot answered every inbound on its number,
-- which for a business that runs marketing campaigns from one number
-- and takes ordinary customer chat on the same one is too broad: the
-- team wants the bot to work the campaign responses (migration 048
-- stamps those) and stay out of everything else. Off by default, so
-- existing installs behave as before.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS auto_reply_campaign_only boolean NOT NULL DEFAULT false;
