-- ============================================================
-- 079: the AI bot answers on every connected number
--
-- Until now the bot answered only on the number its `ai_reply` route
-- resolves to (migration 046; `resolveAiReplyChannel`), so an account
-- with a Whapi and a Cloud API number had the bot on one of them and
-- the other fully human. ai_configs.reply_on_all_numbers lets an admin
-- put it on all of them: each chat is answered on the number the
-- customer wrote to — the inbox's "follow the customer" rule, which on
-- Meta is also the 24-hour window the customer just opened. A chat a
-- person pinned to another number (061, send_channel_id) is left alone.
--
-- Default false: an account that never touches the switch keeps the
-- routed-number behaviour exactly. The column is written by the admin's
-- own client through the existing ai_configs policies, like every other
-- switch on the row.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS.
-- ============================================================

ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS reply_on_all_numbers BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.ai_configs.reply_on_all_numbers IS
  'Answer on every connected number (the one the customer wrote to) instead of only the ai_reply route. Migration 079.';
