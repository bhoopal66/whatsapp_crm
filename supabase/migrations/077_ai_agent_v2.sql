-- ============================================================
-- 077: AI agent v2 — model tiers, pause on a person's reply, held
-- drafts, and a record of what the bot did
--
-- The auto-reply bot runs one model for every message. A greeting
-- costs what a complaint about a declined card costs, and the complaint
-- gets no stronger model than the greeting. ai_configs gains two more
-- tiers around the existing `model`, which stays the standard one:
--
--   * model_small — the cheap tier (greetings, small talk);
--   * model_large — the premium tier (complex, sensitive, high-value);
--   * model_routing — pick a tier per message. Off, every message uses
--     `model`, exactly as before.
--
-- NULL in either tier means "use `model`". Existing rows are filled
-- once, from the provider, when the column is first added: a re-run
-- never refills a tier an admin has cleared on purpose.
--
-- A person replying in a chat now pauses the bot there. Until now the
-- bot kept answering a chat an agent was typing in, unless someone
-- remembered the banner's take-over button. pause_on_agent_reply (on
-- by default) makes an agent's message pause it — the same "a person
-- sent it" rule as migration 067: sender_type = 'agent' with a
-- sender_id; bot sends and API-key sends (no sender_id) do not count.
-- auto_resume_minutes lets the bot pick a chat back up after that much
-- silence from the agents (NULL = never; the app does the resuming).
--
-- conversations.ai_paused_reason says why ai_autoreply_disabled is
-- set: take_over (a person pressed the button), agent_reply (this
-- trigger), handoff (the bot handed off). Only an agent_reply pause is
-- this trigger's to touch: a second agent message refreshes
-- ai_paused_at, so auto-resume counts from the LAST agent reply, and a
-- take-over or a hand-off is never overwritten. Existing paused chats
-- are classified once: a chat with a hand-off summary was handed off,
-- any other was taken over.
--
-- guardrail_retry: when TypeSafe holds a draft, rewrite it once with
-- the large model before a person has to look at it. A draft still
-- held waits on the conversation (ai_pending_draft / _at) for a person
-- to send, edit or discard.
--
-- ai_last_outcome / _detail / _at on the conversation and the
-- ai_reply_events table record what each auto-reply dispatch did
-- (replied, handed off, skipped and why), so "why didn't the bot
-- answer?" has an answer. Outcome values carry no CHECK: the
-- AiDispatchOutcome union in lib/ai/outcomes.ts is the source of
-- truth, and a new outcome should not need a migration. The events
-- table is admin-read and written only by the service-role bot.
--
-- notifications_type_check gains 'ai_handoff' (068 is the last list;
-- every value is kept).
--
-- Apply without -1: ALTER TABLE takes each table's exclusive lock, and
-- in one transaction it would be held through the backfills.
--
-- Re-runnable: ADD COLUMN / CREATE TABLE / CREATE INDEX IF NOT EXISTS,
-- guarded constraints, CREATE OR REPLACE / DROP … IF EXISTS. The
-- backfills only touch rows still NULL.
-- ============================================================

SET lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. ai_configs: tiers and the new switches
-- ------------------------------------------------------------

-- The tier columns are added and filled in one step, so the fill runs
-- exactly once: when the column did not exist yet.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ai_configs'
       AND column_name = 'model_small'
  ) THEN
    ALTER TABLE public.ai_configs ADD COLUMN model_small text NULL;
    UPDATE public.ai_configs
       SET model_small = CASE provider
             WHEN 'openai' THEN 'gpt-5.4-nano'
             WHEN 'anthropic' THEN 'claude-haiku-5-5'
           END
     WHERE model_small IS NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ai_configs'
       AND column_name = 'model_large'
  ) THEN
    ALTER TABLE public.ai_configs ADD COLUMN model_large text NULL;
    UPDATE public.ai_configs
       SET model_large = CASE provider
             WHEN 'openai' THEN 'gpt-5.5'
             WHEN 'anthropic' THEN 'claude-opus-5-5'
           END
     WHERE model_large IS NULL;
  END IF;
END $$;

ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS model_routing boolean NOT NULL DEFAULT true;
ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS pause_on_agent_reply boolean NOT NULL DEFAULT true;
ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS auto_resume_minutes integer NULL;
ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS guardrail_retry boolean NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_configs_auto_resume_minutes_range'
  ) THEN
    ALTER TABLE public.ai_configs
      ADD CONSTRAINT ai_configs_auto_resume_minutes_range
      CHECK (auto_resume_minutes IS NULL
             OR auto_resume_minutes BETWEEN 5 AND 10080);
  END IF;
END $$;

COMMENT ON COLUMN public.ai_configs.model_small IS
  'Cheap tier for greetings and small talk. NULL = use model. Migration 077.';
COMMENT ON COLUMN public.ai_configs.model_large IS
  'Premium tier for complex, sensitive or high-value messages. NULL = use model. Migration 077.';
COMMENT ON COLUMN public.ai_configs.model_routing IS
  'Pick a model tier per message; off = every message uses model. Migration 077.';
COMMENT ON COLUMN public.ai_configs.pause_on_agent_reply IS
  'A person''s message in a chat pauses the bot there (messages_ai_pause_on_agent_reply). Migration 077.';
COMMENT ON COLUMN public.ai_configs.auto_resume_minutes IS
  'Minutes after the last agent reply before an agent_reply pause lifts; NULL = never. Migration 077.';
COMMENT ON COLUMN public.ai_configs.guardrail_retry IS
  'When TypeSafe holds a draft, rewrite it once with the large model before a person reviews it. Migration 077.';

-- ------------------------------------------------------------
-- 2. conversations: why the bot is paused, a held draft, the last
--    dispatch outcome
-- ------------------------------------------------------------

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS ai_paused_reason text NULL;
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS ai_paused_at timestamptz NULL;
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS ai_pending_draft text NULL;
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS ai_pending_draft_at timestamptz NULL;
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS ai_last_outcome text NULL;
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS ai_last_outcome_detail text NULL;
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS ai_last_outcome_at timestamptz NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_ai_paused_reason_check'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_ai_paused_reason_check
      CHECK (ai_paused_reason IS NULL
             OR ai_paused_reason IN ('take_over', 'agent_reply', 'handoff'));
  END IF;
END $$;

COMMENT ON COLUMN public.conversations.ai_paused_reason IS
  'Why ai_autoreply_disabled is set: take_over (a person pressed take over), agent_reply (a person replied, migration 077 trigger), handoff (the bot handed off). Mirrors AiPausedReason in lib/ai/outcomes.ts.';
COMMENT ON COLUMN public.conversations.ai_paused_at IS
  'When the bot was paused; for agent_reply, the last agent reply. Auto-resume counts from it. Migration 077.';
COMMENT ON COLUMN public.conversations.ai_pending_draft IS
  'A bot draft TypeSafe held, waiting for a person to send, edit or discard. Migration 077.';
COMMENT ON COLUMN public.conversations.ai_last_outcome IS
  'Last auto-reply dispatch result; values are AiDispatchOutcome in lib/ai/outcomes.ts (no CHECK on purpose). Migration 077.';

-- ------------------------------------------------------------
-- 3. ai_reply_events: one row per auto-reply dispatch
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ai_reply_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE CASCADE,
  outcome         text NOT NULL,
  detail          text,
  tier            text CHECK (tier IS NULL OR tier IN ('small', 'standard', 'large')),
  model           text,
  route_source    text CHECK (route_source IS NULL OR route_source IN ('jev', 'heuristic', 'fixed')),
  escalated       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_reply_events_account_created
  ON public.ai_reply_events (account_id, created_at DESC);

ALTER TABLE public.ai_reply_events ENABLE ROW LEVEL SECURITY;

-- What the bot did with customers' messages is a settings-class
-- review, admin+ like the rest of the AI setup (ai_knowledge_gaps).
DROP POLICY IF EXISTS ai_reply_events_select ON public.ai_reply_events;
CREATE POLICY ai_reply_events_select ON public.ai_reply_events
  FOR SELECT TO authenticated
  USING (public.is_account_member(account_id, 'admin'));

-- No INSERT/UPDATE/DELETE policy: rows are written only by the
-- service-role bot.
REVOKE ALL ON public.ai_reply_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.ai_reply_events TO authenticated;
GRANT SELECT, INSERT ON public.ai_reply_events TO service_role;

-- ------------------------------------------------------------
-- 4. The bell alert type. 068 is the last list; keep every value.
-- ------------------------------------------------------------
ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned',
    'channel_disconnected',
    'channel_reconnected',
    'team_activity_alert',
    'ai_handoff'
  ));

RESET lock_timeout;

-- ------------------------------------------------------------
-- 5. A person's reply pauses the bot
-- ------------------------------------------------------------

-- SECURITY DEFINER for the reason 067's stamp is: this is bookkeeping
-- on a conversation the sender could already write to, and the
-- sender's RLS should not get a say — a refusal here would fail the
-- message insert after WhatsApp had already accepted the send. For the
-- same reason any error is logged and swallowed: a missed pause costs
-- one bot reply; a lost message costs the conversation.
--
-- Only the pause columns change, so none of the conversations guards
-- fire: the assignment guard (042/044) passes an unchanged
-- assigned_agent_id, and the channel (062), send-channel (061/062) and
-- chat-tag (075) guards are UPDATE OF columns this does not write.
CREATE OR REPLACE FUNCTION public.ai_pause_on_agent_reply()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Pause a running bot, or refresh an agent_reply pause so
  -- auto-resume counts from the last reply. A take-over, a hand-off,
  -- or a pause with no recorded reason is left alone.
  UPDATE conversations c
     SET ai_autoreply_disabled = true,
         ai_paused_reason = 'agent_reply',
         ai_paused_at = now()
   WHERE c.id = NEW.conversation_id
     AND (NOT c.ai_autoreply_disabled
          OR c.ai_paused_reason = 'agent_reply')
     AND EXISTS (
       SELECT 1
         FROM ai_configs a
        WHERE a.account_id = c.account_id
          AND a.is_active
          AND a.auto_reply_enabled
          AND a.pause_on_agent_reply
     );
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Could not pause the AI bot on conversation %: %',
    NEW.conversation_id, SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.ai_pause_on_agent_reply() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS messages_ai_pause_on_agent_reply ON public.messages;
CREATE TRIGGER messages_ai_pause_on_agent_reply
  AFTER INSERT ON public.messages
  FOR EACH ROW
  WHEN (NEW.sender_type = 'agent' AND NEW.sender_id IS NOT NULL)
  EXECUTE FUNCTION public.ai_pause_on_agent_reply();

-- ------------------------------------------------------------
-- 6. Chats already paused
-- ------------------------------------------------------------

-- Once, and only where no reason is recorded: a hand-off leaves a
-- summary; any other pause was a person taking over.
UPDATE public.conversations
   SET ai_paused_reason = CASE
         WHEN ai_handoff_summary IS NOT NULL THEN 'handoff'
         ELSE 'take_over'
       END
 WHERE ai_autoreply_disabled
   AND ai_paused_reason IS NULL;
