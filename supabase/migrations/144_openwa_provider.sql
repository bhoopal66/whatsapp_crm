-- ============================================================
-- 144: OpenWA as a third WhatsApp provider
--
-- OpenWA is a self-hosted, linked-device gateway (like Whapi) that runs
-- beside the app. A `whatsapp_config` row with provider 'openwa' reads:
--
--   phone_number_id  OpenWA session id (each inbound webhook names it)
--   access_token     session-scoped OpenWA operator API key (encrypted)
--   verify_token     webhook HMAC secret (encrypted)
--   waba_id          connected phone number, for display
--   app_secret       unused
--
-- Only the provider CHECK changes. `messages.provider` and
-- `conversations.provider` carry no constraint, the at-most-one-Meta
-- index (060) only matches 'meta', and every channel predicate keys on
-- the row id, not the provider.
--
-- Re-runnable: the constraint is replaced only while its definition does
-- not already include 'openwa'.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'whatsapp_config_provider_check'
       AND conrelid = 'public.whatsapp_config'::regclass
       AND pg_get_constraintdef(oid) LIKE '%openwa%'
  ) THEN
    ALTER TABLE whatsapp_config
      DROP CONSTRAINT IF EXISTS whatsapp_config_provider_check;
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_check
      CHECK (provider IN ('whapi', 'meta', 'openwa'));
  END IF;
END $$;
