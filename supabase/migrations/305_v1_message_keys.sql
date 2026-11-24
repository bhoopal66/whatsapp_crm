-- ============================================================
-- 305_v1_message_keys.sql: Idempotency-Key on POST /api/v1/messages.
--
-- A caller whose answer was lost sent the customer the message again: the
-- endpoint had no key to recognise the second request by. One row per
-- (account, API key, key), written by src/lib/api/v1/message-keys.ts
-- before anything is sent:
--
--   claimed      a request is sending it now; two minutes later its
--                process is taken for dead and the row is unconfirmed
--   sent         the gateway took it; `response` answers every repeat
--   failed       certainly not sent; the same key may try again
--   unconfirmed  may have reached the customer; never sent again
--
-- The text is never stored: request_hash (SHA-256) recognises another
-- body, `response` holds ids. Service role only. Rows go with their
-- contact or message, on a PDPL erase (privacy_extensions), and after 30
-- days (the automations cron).
--
-- Re-runnable. Needs 229 (privacy_extensions).
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.privacy_extensions') IS NULL THEN
    RAISE EXCEPTION '305: apply 229_desk_customer_contacts.sql first (privacy_extensions)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.v1_message_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  api_key_id   uuid NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,
  key          text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state        text NOT NULL DEFAULT 'claimed'
                 CHECK (state IN ('claimed', 'sent', 'failed', 'unconfirmed')),
  -- The request that holds the claim; every later write names it.
  claim_token  uuid NOT NULL DEFAULT gen_random_uuid(),
  claimed_at   timestamptz NOT NULL DEFAULT now(),
  contact_id   uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  message_id   uuid REFERENCES public.messages(id) ON DELETE CASCADE,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT v1_message_keys_key_once UNIQUE (account_id, api_key_id, key),
  CONSTRAINT v1_message_keys_sent_answers CHECK (state <> 'sent' OR response IS NOT NULL)
);
-- The cascades and the sweep.
CREATE INDEX IF NOT EXISTS v1_message_keys_api_key_idx ON public.v1_message_keys (api_key_id);
CREATE INDEX IF NOT EXISTS v1_message_keys_contact_idx
  ON public.v1_message_keys (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS v1_message_keys_message_idx
  ON public.v1_message_keys (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS v1_message_keys_created_idx ON public.v1_message_keys (created_at);

ALTER TABLE public.v1_message_keys ENABLE ROW LEVEL SECURITY;  -- no policy: no client row, ever
REVOKE ALL ON public.v1_message_keys FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.v1_message_keys TO service_role;

-- ---------- PDPL: export and erase through privacy_extensions ----------

CREATE OR REPLACE FUNCTION public.privacy_v1_message_keys_export(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key', k.key, 'state', k.state, 'message_id', k.message_id,
           'created_at', k.created_at) ORDER BY k.created_at), '[]'::jsonb)
    FROM public.v1_message_keys k
   WHERE k.account_id = p_account AND k.contact_id = p_contact
$$;

CREATE OR REPLACE FUNCTION public.privacy_v1_message_keys_erase(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM public.v1_message_keys k
   WHERE k.account_id = p_account AND k.contact_id = p_contact;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('counts', jsonb_build_object('v1_message_keys', v_n), 'objects', '[]'::jsonb);
END;
$$;

INSERT INTO public.privacy_extensions (name, export_fn, erase_fn, added_in)
VALUES ('v1_message_keys', 'privacy_v1_message_keys_export', 'privacy_v1_message_keys_erase', '305')
ON CONFLICT (name) DO UPDATE SET export_fn = excluded.export_fn, erase_fn = excluded.erase_fn;

REVOKE ALL ON FUNCTION public.privacy_v1_message_keys_export(uuid, uuid),
  public.privacy_v1_message_keys_erase(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
