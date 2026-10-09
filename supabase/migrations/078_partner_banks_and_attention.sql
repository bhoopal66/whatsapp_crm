-- ============================================================
-- 078: partner banks per account, and chats that need a person
--
-- The TypeSafe partner-bank list is hardcoded (PARTNER_BANK_CODES in
-- lib/typesafe/banks.ts: Mashreq, RAKBANK, NBF, Wio, Ruya, UBL). Every
-- other bank counts as a non-partner, so the guardrail holds any reply
-- that names a bank the business does in fact work with — and an
-- account that works with FAB has no way to say so.
-- ts_account_settings.partner_banks is that account's own list:
--
--   {"codes": ["MASHREQ", "FAB", …],
--    "custom": [{"name": "Some Bank", "aliases": ["SB"]}]}
--
-- `codes` names banks the built-in catalogue already knows; `custom`
-- adds banks it does not, with the spellings customers use. NULL means
-- the built-in list, so an account that never saved one behaves
-- exactly as before. The CHECK holds the envelope only (an object with
-- a `codes` array, and `custom` absent or an array); the entries are
-- parsed tolerantly by parsePartnerBanks in lib/typesafe/admin-types.ts,
-- which drops what it cannot use. The column is written the way every
-- other switch is: the admin's own client through the 064 policies
-- (rank >= 4, own account), version-checked on updated_at, which the
-- stamp trigger renews. The table-level UPDATE grant covers the new
-- column; there is no column guard to widen.
--
-- conversations.ai_attention_at marks a chat the bot handed to a
-- person that no person has acted on yet; the inbox pins these on top
-- with a red "Important" label. The app stamps it at hand-off. It
-- clears itself when a person replies: 077's messages trigger function
-- ai_pause_on_agent_reply() now also nulls it, on every agent message
-- with a sender_id — whatever the account's AI config says, because a
-- hand-off can outlive the config that made it (the bot switched off
-- since, or pause_on_agent_reply turned off). Its pause behaviour is
-- otherwise unchanged. Nothing guards the column: the assignment guard
-- (042/044) only looks at assigned_agent_id, and the channel (062),
-- send-channel (061/062), human-engaged (067) and chat-tag (075)
-- guards fire on columns this does not touch — so the service role
-- and an agent under the existing update policy may both write it.
--
-- Chats handed off before this migration are flagged once, when the
-- column is first added: a hand-off pause whose newest message is the
-- customer's is still waiting for a person. A re-run never re-flags a
-- chat someone has since dealt with.
--
-- Apply without -1: ALTER TABLE takes each table's exclusive lock, and
-- in one transaction it would be held through the backfill.
--
-- Re-runnable: ADD COLUMN / CREATE INDEX IF NOT EXISTS, a guarded
-- constraint, CREATE OR REPLACE. The backfill runs only when the
-- column did not exist.
-- ============================================================

SET lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. ts_account_settings.partner_banks
-- ------------------------------------------------------------

ALTER TABLE public.ts_account_settings
  ADD COLUMN IF NOT EXISTS partner_banks jsonb NULL;

-- coalesce: jsonb_typeof of a missing key is NULL, and a CHECK that
-- evaluates to NULL passes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ts_account_settings_partner_banks_shape'
  ) THEN
    ALTER TABLE public.ts_account_settings
      ADD CONSTRAINT ts_account_settings_partner_banks_shape
      CHECK (
        partner_banks IS NULL
        OR (
          jsonb_typeof(partner_banks) = 'object'
          AND coalesce(jsonb_typeof(partner_banks -> 'codes'), '') = 'array'
          AND (NOT (partner_banks ? 'custom')
               OR coalesce(jsonb_typeof(partner_banks -> 'custom'), '') = 'array')
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN public.ts_account_settings.partner_banks IS
  'The account''s partner banks: {"codes": [catalogue codes], "custom": [{"name", "aliases"}]}. NULL = the built-in list (PARTNER_BANK_CODES). Parsed by parsePartnerBanks in lib/typesafe/admin-types.ts. Migration 078.';

-- ------------------------------------------------------------
-- 2. conversations.ai_attention_at, flagged once for open hand-offs
-- ------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'conversations'
       AND column_name = 'ai_attention_at'
  ) THEN
    ALTER TABLE public.conversations ADD COLUMN ai_attention_at timestamptz NULL;
    UPDATE public.conversations c
       SET ai_attention_at = coalesce(c.ai_paused_at, now())
     WHERE c.ai_autoreply_disabled
       AND c.ai_paused_reason = 'handoff'
       AND c.ai_attention_at IS NULL
       AND (SELECT m.sender_type
              FROM public.messages m
             WHERE m.conversation_id = c.id
             ORDER BY m.created_at DESC, m.id DESC
             LIMIT 1) = 'customer';
  END IF;
END $$;

COMMENT ON COLUMN public.conversations.ai_attention_at IS
  'The bot handed this chat to a person and nobody has acted yet; the inbox pins it as Important. Cleared by a person''s reply (ai_pause_on_agent_reply). Migration 078.';

CREATE INDEX IF NOT EXISTS idx_conversations_ai_attention
  ON public.conversations (account_id, ai_attention_at DESC)
  WHERE ai_attention_at IS NOT NULL;

RESET lock_timeout;

-- ------------------------------------------------------------
-- 3. A person's reply clears the flag
-- ------------------------------------------------------------

-- 077's function, with the clear added ahead of the pause. The clear
-- has its own exception block so a failure in either half cannot skip
-- the other, and neither can fail the message insert (see 077: a lost
-- message costs the conversation). The trigger itself
-- (messages_ai_pause_on_agent_reply, AFTER INSERT, sender_type 'agent'
-- with a sender_id) is unchanged and not recreated.
CREATE OR REPLACE FUNCTION public.ai_pause_on_agent_reply()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- A person has acted on the chat: it no longer needs attention.
  -- Unconditional on the AI config, unlike the pause below.
  BEGIN
    UPDATE conversations
       SET ai_attention_at = NULL
     WHERE id = NEW.conversation_id
       AND ai_attention_at IS NOT NULL;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Could not clear needs-attention on conversation %: %',
      NEW.conversation_id, SQLERRM;
  END;

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
