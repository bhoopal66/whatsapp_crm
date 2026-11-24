-- ============================================================
-- 292: why a message failed, on the message
--
-- WhatsApp accepts a message and says later that it failed, with a
-- reason (Meta's `errors[0]`). The reason was kept for campaign
-- recipients only (066): in a chat staff saw a red mark and no word of
-- why, so nobody could tell "this person is not on WhatsApp" from "the
-- account's payment failed".
--
--   1. `messages.failure_reason`: one line, written by the webhook with
--      the status (src/lib/whatsapp/inbound-pipeline.ts) and cleared when
--      a later delivery corrects it (291). Never by a session.
--   2. `describe_meta_failure` (066) names more of Meta's codes. Mirrored
--      by src/lib/whatsapp/meta-failure.ts; meta-failure.test.ts compares.
--   3. The last 60 days' failures get their reason from the cost ledger,
--      which keeps every receipt.
--
-- After 291. Re-running 066 or 284 puts their older functions back:
-- apply in order, then this one again. Re-runnable.
-- ============================================================

SET lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. The column
-- ------------------------------------------------------------
-- In one block: a guard that reads the column without the column would
-- refuse every send's record after WhatsApp took the message, and a plain
-- `psql -f` goes on after a lock timeout.
DO $col$ BEGIN
  ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS failure_reason text;

  COMMENT ON COLUMN public.messages.failure_reason IS
    'Why WhatsApp failed a message it had accepted (292). Service role only; null when the gateway gave no reason.';

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.messages'::regclass
       AND conname = 'messages_failure_reason_length'
  ) THEN
    -- NOT VALID: no scan under the lock. The column is new, so nothing
    -- older can break it.
    ALTER TABLE public.messages
      ADD CONSTRAINT messages_failure_reason_length
      CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 300)
      NOT VALID;
  END IF;

  -- 284's body, plus the last line of the list: a session never says why a
  -- message failed.
  CREATE OR REPLACE FUNCTION public.messages_session_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = ''
  AS $$
  BEGIN
    IF current_user NOT IN ('authenticated', 'anon') THEN
      RETURN NEW;
    END IF;
    IF NEW.sender_type IS DISTINCT FROM 'agent'
       OR NEW.sender_id IS NULL
       OR NEW.sender_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'You can only record a message you sent yourself'
        USING ERRCODE = '42501';
    END IF;
    -- The rest of the row is what lib/whatsapp/send-message.ts writes;
    -- these columns and values it never does.
    IF NEW.status IS DISTINCT FROM 'sent'
       OR NEW.created_at IS DISTINCT FROM now()
       OR NEW.ai_generated
       OR NEW.interactive_reply_id IS NOT NULL
       OR NEW.media_type IS NOT NULL
       OR NEW.contact_cards IS NOT NULL
       OR NEW.failure_reason IS NOT NULL
       OR NEW.content_type NOT IN ('text', 'template', 'interactive',
                                   'image', 'video', 'document', 'audio') THEN
      RAISE EXCEPTION 'This message has details a person''s send does not carry'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END;
  $$;
END $col$;
REVOKE ALL ON FUNCTION public.messages_session_guard() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Meta's codes in words (066's body, more codes)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.describe_meta_failure(
  p_code    text,
  p_title   text,
  p_details text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE nullif(btrim(p_code), '')
    WHEN '131049' THEN 'Meta is limiting marketing messages to this person to keep engagement healthy. Do not retry soon. (Meta 131049)'
    WHEN '131026' THEN 'Undeliverable: the number is not on WhatsApp, runs an old app version, or has not accepted the latest terms. (Meta 131026)'
    WHEN '130472' THEN 'Not delivered: the person is in a Meta marketing experiment that holds back some messages. (Meta 130472)'
    WHEN '131047' THEN 'The 24-hour service window is closed. Send an approved template instead. (Meta 131047)'
    WHEN '131031' THEN 'The WhatsApp Business Account is locked. Check WhatsApp Manager for restrictions or pending verification. (Meta 131031)'
    WHEN '131042' THEN 'Meta could not charge for this message. The account owner must check the payment method in Meta Business settings. (Meta 131042)'
    WHEN '131048' THEN 'Meta is limiting this number because people blocked or reported earlier messages. Check its quality in WhatsApp Manager. (Meta 131048)'
    WHEN '131050' THEN 'This person chose to stop receiving marketing messages from this business. Do not retry. (Meta 131050)'
    WHEN '131053' THEN 'WhatsApp could not use the picture or file of this message. (Meta 131053)'
    WHEN '131056' THEN 'Too many messages to this person in a short time. Wait a few minutes. (Meta 131056)'
    WHEN '130429' THEN 'Too many messages from this number in a short time. Try again later. (Meta 130429)'
    WHEN '132015' THEN 'Meta paused this template because of low quality. Use another one. (Meta 132015)'
    WHEN '132016' THEN 'Meta disabled this template for good. Use another one. (Meta 132016)'
    WHEN '368' THEN 'Meta has blocked this WhatsApp Business Account for a policy violation. Check WhatsApp Manager. (Meta 368)'
    ELSE CASE
      WHEN nullif(btrim(p_code), '') IS NOT NULL
       AND coalesce(nullif(btrim(p_title), ''), nullif(btrim(p_details), '')) IS NOT NULL
        THEN format('Meta %s: %s', btrim(p_code),
                    coalesce(nullif(btrim(p_title), ''), nullif(btrim(p_details), '')))
      WHEN nullif(btrim(p_code), '') IS NOT NULL
        THEN 'Meta ' || btrim(p_code)
      WHEN coalesce(nullif(btrim(p_title), ''), nullif(btrim(p_details), '')) IS NOT NULL
        THEN 'Meta: ' || coalesce(nullif(btrim(p_title), ''), nullif(btrim(p_details), ''))
      ELSE 'Meta reported the message as failed without giving a reason.'
    END
  END
$$;
ALTER FUNCTION public.describe_meta_failure(text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.describe_meta_failure(text, text, text) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. The failures already there
-- A message id is only as unique as the gateway that minted it (009), so
-- the account must match too. A function, so that the check file runs the
-- very statement; kept for a second run after an outage.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backfill_message_failure_reasons(
  p_since interval DEFAULT interval '60 days'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.messages m
     SET failure_reason = left(r.reason, 300)
    FROM (
      SELECT DISTINCT ON (c.account_id, c.message_id)
             c.account_id, c.message_id,
             public.describe_meta_failure(
               c.raw_status #>> '{errors,0,code}',
               c.raw_status #>> '{errors,0,title}',
               c.raw_status #>> '{errors,0,error_data,details}') AS reason
        FROM public.whatsapp_message_costs c
       WHERE c.status = 'failed'
         AND c.created_at > now() - p_since
       ORDER BY c.account_id, c.message_id, c.created_at DESC
    ) r, public.conversations cv
   WHERE m.message_id = r.message_id
     AND cv.id = m.conversation_id
     AND cv.account_id = r.account_id
     AND m.status = 'failed'
     AND m.failure_reason IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
ALTER FUNCTION public.backfill_message_failure_reasons(interval) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.backfill_message_failure_reasons(interval)
  FROM PUBLIC, anon, authenticated, service_role;

SELECT public.backfill_message_failure_reasons();
