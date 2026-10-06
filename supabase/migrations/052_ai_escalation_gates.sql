-- ============================================================
-- 052_ai_escalation_gates.sql — deterministic gates in front of the
-- AI auto-reply bot.
--
-- Until now the only thing standing between an inbound message and the
-- LLM was the prompt: the model was *asked* to hand off when a customer
-- complains or when the knowledge base doesn't cover the question, and
-- an LLM error simply logged and left the thread unanswered. For a
-- business that sells regulated financial products that is the wrong
-- default. This migration adds the columns behind three gates that run
-- BEFORE any token is spent, plus the records they leave behind:
--
--   1. ai_configs.escalation_keywords — words/phrases (any language)
--      that send the thread straight to a human. Matched on the latest
--      customer message with word boundaries; a trailing `*` matches a
--      prefix (`refund*` → refunded, refunding).
--   2. ai_configs.retrieval_min_score — cosine similarity (0–1) the best
--      knowledge-base chunk must reach, else the bot hands off instead
--      of answering. NULL = gate off (existing installs unchanged).
--      Only meaningful with an embeddings key; on lexical-only installs
--      the gate passes on any full-text hit.
--   3. ai_configs.strict_grounding — when on, the prompt tells the
--      model the knowledge base is its ONLY source of facts, not just
--      the preferred one.
--   4. ai_configs.handoff_message — what the customer is told when a
--      gate (not the model) hands off, so they are not left in silence
--      until an agent picks the thread up. NULL = say nothing.
--   5. conversations.ai_handoff_reason — which gate handed off, so the
--      weekly review can count keyword / no-knowledge / model / error
--      without parsing the free-text summary.
--   6. ai_knowledge_gaps — every question the retrieval gate rejected,
--      for the KB maintenance loop ("what are customers asking that we
--      have no document for?"). Written by the service role from the
--      bot; admin-only read/delete from the dashboard.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS /
-- DROP POLICY IF EXISTS.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS escalation_keywords text[] NOT NULL DEFAULT '{}';

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS retrieval_min_score real;

-- Guarded separately: ADD CONSTRAINT has no IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_configs_retrieval_min_score_range'
  ) THEN
    ALTER TABLE ai_configs
      ADD CONSTRAINT ai_configs_retrieval_min_score_range
      CHECK (retrieval_min_score IS NULL OR (retrieval_min_score >= 0 AND retrieval_min_score <= 1));
  END IF;
END $$;

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS strict_grounding boolean NOT NULL DEFAULT false;

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS handoff_message text;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_handoff_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_ai_handoff_reason_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_ai_handoff_reason_check
      CHECK (ai_handoff_reason IS NULL OR ai_handoff_reason IN ('keyword', 'no_knowledge', 'model', 'error'));
  END IF;
END $$;

COMMENT ON COLUMN conversations.ai_handoff_reason IS
  'Which AI gate handed this thread to a human: keyword (escalation list), no_knowledge (retrieval below threshold), model (the LLM asked), error (provider failure). Mirrors AiHandoffReason in lib/ai/handoff.ts.';

-- ============================================================
-- Knowledge gaps — questions the retrieval gate could not ground.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_knowledge_gaps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  question        text NOT NULL,
  -- Best cosine similarity seen, NULL when retrieval was lexical-only
  -- and simply found nothing.
  best_score      real,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_knowledge_gaps_account_created
  ON ai_knowledge_gaps(account_id, created_at DESC);

ALTER TABLE ai_knowledge_gaps ENABLE ROW LEVEL SECURITY;

-- Customer questions are conversation content; the review is a
-- settings-class task, so admin+ like the rest of the AI setup.
DROP POLICY IF EXISTS ai_knowledge_gaps_select ON ai_knowledge_gaps;
CREATE POLICY ai_knowledge_gaps_select ON ai_knowledge_gaps FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_knowledge_gaps_delete ON ai_knowledge_gaps;
CREATE POLICY ai_knowledge_gaps_delete ON ai_knowledge_gaps FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- No INSERT/UPDATE policy for `authenticated`: rows are written only
-- by the service-role bot.
