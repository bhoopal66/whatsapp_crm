-- ============================================================
-- 048_campaign_conversations.sql — remember which campaign a
-- conversation came from.
--
-- A broadcast send does not write into the thread (the template goes
-- straight to the gateway), so until now nothing on `conversations`
-- said "this customer is replying to campaign X". The inbound pipeline
-- already flips the customer's `broadcast_recipients` row to `replied`;
-- it now also stamps the conversation with that broadcast. Two things
-- read it:
--
--   * the Campaign inbox under Broadcasts — the conversations that came
--     from a campaign, filterable by campaign;
--   * the AI auto-reply, which is told which campaign message the
--     customer is answering so its first reply is about the right
--     product.
--
-- Re-stamped whenever a later campaign gets a reply, so the column is
-- always the most recent campaign the customer answered. RLS on
-- `conversations` is unchanged — this is one more column on rows the
-- viewer could already see.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS campaign_broadcast_id uuid
    REFERENCES broadcasts(id) ON DELETE SET NULL;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS campaign_replied_at timestamptz;

-- Partial: most conversations never came from a campaign.
CREATE INDEX IF NOT EXISTS idx_conversations_campaign
  ON conversations (account_id, campaign_broadcast_id)
  WHERE campaign_broadcast_id IS NOT NULL;
