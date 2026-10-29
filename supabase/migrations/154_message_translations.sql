-- ============================================================
-- 154_message_translations.sql — cached inbox translations
--
-- The inbox gains a "Translate" link under an Arabic customer
-- message. POST /api/ai/translate/message translates it to English
-- with the account's own LLM key and caches the result here, one row
-- per (message, target language), so a second click — by anyone — is
-- answered from the cache and spends no tokens.
--
--  * ai_usage_log.mode gains 'translate', so that spend is logged on
--    the same ledger as the bot's and the drafts'. 033 declared the
--    CHECK inline, so Postgres named it ai_usage_log_mode_check; it is
--    dropped and re-added with the new value.
--
--  * message_translations: lang is 'en' only (inbound → English is the
--    one direction cached). source_hash is the sha256 hex of the text
--    the translation was made from; the route re-translates when the
--    message's text no longer hashes to it. account_id and
--    conversation_id are derived from the message by a BEFORE trigger,
--    never taken from the writer, and message_id is immutable, so a
--    row can never point at a chat of another account. Deleting the
--    message or its conversation deletes the row.
--
--  * Service role only: RLS on with no policy, and every grant to
--    anon / authenticated revoked (Supabase grants new public tables to
--    both by default). The browser never reads the cache directly; the
--    route checks the caller can see the conversation first.
--
-- Additive and re-runnable: IF NOT EXISTS, DROP … IF EXISTS before
-- the constraint and the trigger, CREATE OR REPLACE.
-- ============================================================

-- ---------- 1. ai_usage_log.mode gains 'translate' ----------

ALTER TABLE public.ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;
ALTER TABLE public.ai_usage_log
  ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply', 'draft', 'translate'));

-- ---------- 2. The cache ----------

CREATE TABLE IF NOT EXISTS public.message_translations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Both derived by message_translations_derive(), never trusted.
  account_id      uuid NOT NULL,
  conversation_id uuid NOT NULL,
  message_id      uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  lang            text NOT NULL CHECK (lang IN ('en')),
  source_hash     text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  translated_text text NOT NULL CHECK (
    char_length(translated_text) <= 20000
    AND translated_text !~ '^[[:space:]]*$'
  ),
  provider        text NOT NULL CHECK (provider IN ('openai', 'anthropic')),
  model           text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, lang),
  FOREIGN KEY (conversation_id, account_id)
    REFERENCES public.conversations (id, account_id) ON DELETE CASCADE
);

-- A conversation delete cascades through the composite FK; without
-- this index every such delete scans the table.
CREATE INDEX IF NOT EXISTS idx_message_translations_conversation
  ON public.message_translations (conversation_id, account_id);

-- ---------- 3. Derive the tenancy from the message ----------

CREATE OR REPLACE FUNCTION public.message_translations_derive()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_conversation uuid;
  v_account      uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.message_id IS DISTINCT FROM OLD.message_id THEN
    RAISE EXCEPTION 'message_translations.message_id cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT m.conversation_id, c.account_id
    INTO v_conversation, v_account
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
   WHERE m.id = NEW.message_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'message_translations: message % does not exist', NEW.message_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  NEW.conversation_id := v_conversation;
  NEW.account_id      := v_account;

  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
  END IF;

  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.message_translations_derive() FROM PUBLIC;

DROP TRIGGER IF EXISTS message_translations_derive ON public.message_translations;
CREATE TRIGGER message_translations_derive
  BEFORE INSERT OR UPDATE ON public.message_translations
  FOR EACH ROW EXECUTE FUNCTION public.message_translations_derive();

-- ---------- 4. Service role only ----------

ALTER TABLE public.message_translations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.message_translations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.message_translations TO service_role;

COMMENT ON TABLE public.message_translations IS
  'Cached English translations of inbound messages, one per (message, lang). '
  'Written and read only by POST /api/ai/translate/message on the service '
  'role: RLS on with no policy, no grant to anon or authenticated. '
  'account_id and conversation_id are derived from the message by a trigger.';
