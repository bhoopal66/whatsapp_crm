-- ============================================================
-- 054_campaign_flow_continuation.sql — a campaign that keeps going.
--
-- A broadcast used to end at the send: the template went out, replies
-- landed in the Campaign inbox, and whatever happened next was up to
-- whoever was watching. Three things change that:
--
--   1. broadcasts.follow_up_flow_id — the Flow that picks the customer
--      up when they answer the campaign (button tap or typed text). The
--      inbound pipeline starts it on the FIRST reply to that campaign,
--      ahead of the keyword / first-inbound entry triggers, with the
--      reply seeded into the run's vars (`campaign_reply`,
--      `campaign_reply_id`) so the flow can branch on which template
--      button was tapped without asking again. A `manual`-trigger flow
--      is the natural fit: it never auto-starts from inbound, so the
--      campaign is its only door.
--
--   2. flow_runs.broadcast_id — which campaign started the run. Audit
--      only; the engine keys nothing on it.
--
--   3. conversations.ai_handoff_reason gains 'cap'. The bot now hands
--      a thread to a human when its per-conversation reply cap is
--      reached instead of going silent — a customer mid-conversation
--      must always end up with someone, bot or human.
--
-- The AI side of "the conversation never stops" needs no schema:
-- `flows.fallback_policy.on_unknown_reply` is JSONB and gains the value
-- 'ai' (answer the off-script message with the AI agent, keep the run
-- where it is), resolved in lib/flows/fallback.ts.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS / guarded constraint swap.
-- ============================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS follow_up_flow_id uuid
    REFERENCES flows(id) ON DELETE SET NULL;

COMMENT ON COLUMN broadcasts.follow_up_flow_id IS
  'Flow started for a recipient on their first reply to this campaign (migration 054). NULL = replies go to automations / the AI agent as before.';

ALTER TABLE flow_runs
  ADD COLUMN IF NOT EXISTS broadcast_id uuid
    REFERENCES broadcasts(id) ON DELETE SET NULL;

-- Runs viewer: "which runs did this campaign start". Partial — most
-- runs start from an inbound trigger, not a campaign.
CREATE INDEX IF NOT EXISTS idx_flow_runs_broadcast
  ON flow_runs (broadcast_id)
  WHERE broadcast_id IS NOT NULL;

-- Widen the handoff-reason CHECK (052). Drop-and-recreate is the only
-- way to change a CHECK; both statements are guarded so a re-run is a
-- no-op once the new definition is in place.
DO $$
DECLARE
  current_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO current_def
    FROM pg_constraint
   WHERE conname = 'conversations_ai_handoff_reason_check';
  IF current_def IS NOT NULL AND current_def NOT LIKE '%''cap''%' THEN
    ALTER TABLE conversations
      DROP CONSTRAINT conversations_ai_handoff_reason_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_ai_handoff_reason_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_ai_handoff_reason_check
      CHECK (ai_handoff_reason IS NULL OR ai_handoff_reason IN (
        'keyword', 'no_knowledge', 'model', 'error', 'cap'
      ));
  END IF;
END $$;

COMMENT ON COLUMN conversations.ai_handoff_reason IS
  'Which AI gate handed this thread to a human: keyword (escalation list), no_knowledge (retrieval below threshold), model (the LLM asked), error (provider failure), cap (per-conversation reply cap reached). Mirrors AiHandoffReason in lib/ai/handoff.ts.';
