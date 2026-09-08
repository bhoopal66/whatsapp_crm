-- ============================================================
-- 046_multi_channel_whatsapp
--
-- Lets one account connect BOTH a Whapi channel and a Meta Cloud API
-- number at the same time, and choose per surface which one sends.
--
-- ─── Why both, and why they must be different numbers ─────────────
--
-- A Whapi channel is a WhatsApp account paired to the gateway as a
-- LINKED DEVICE — the number still lives in the WhatsApp app on a
-- phone. Registering a number on Meta's Cloud API DEREGISTERS it from
-- the app. So a single number can be on one or the other, never both,
-- and "use both" necessarily means two numbers:
--
--   * the conversational number, on Whapi — free-form replies, no
--     24-hour window, no template review;
--   * the marketing number, on Meta Cloud API — approved templates,
--     the official business platform, subject to the service window.
--
-- ─── What changes ─────────────────────────────────────────────────
--
--   1. `whatsapp_config` becomes multi-row per account, keyed by
--      provider. Migration 017 predicted this exact change and
--      prescribed the shape: "drop the unique and add a primary
--      boolean". That is what happens below.
--   2. `messages.provider` records which channel carried each message,
--      so a reply can go back out the number the customer used.
--      Conversations stay ONE PER CONTACT — the contact dedup, the
--      flow_runs one-active-run index, and the team-visibility rules
--      in 042/043/044 all key on the contact, and splitting threads
--      per channel would fork every one of them.
--   3. `whatsapp_routes` maps a surface (inbox, broadcast, automation,
--      flow, ai_reply, api) to the channel that should send it. This
--      is the admin-level selector; an absent row falls back to the
--      account's primary channel.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. whatsapp_config: one row per (account, provider)
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'whapi';

-- Guarded separately from ADD COLUMN: re-running must not fail on an
-- already-present constraint, and PostgreSQL has no ADD CONSTRAINT IF
-- NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_config_provider_check'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_check
      CHECK (provider IN ('whapi', 'meta'));
  END IF;
END $$;

-- Operator-facing name for the number, so the routing selector reads
-- "Marketing (+91 …)" rather than an opaque channel id.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS label TEXT;

-- The fallback channel for any surface with no explicit route, and the
-- channel a brand-new conversation replies through. Existing installs
-- have exactly one row, which becomes the primary by the DEFAULT.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT TRUE;

-- Meta signs every webhook POST with an HMAC of the raw body keyed on
-- the APP secret (not the access token), so it has to be stored to
-- authenticate inbound callbacks. AES-256-GCM encrypted like every
-- other credential here. NULL for Whapi rows, and NULL for a Meta row
-- on a deployment that supplies META_APP_SECRET by environment instead.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS app_secret TEXT;

-- ---- swap UNIQUE(account_id) for UNIQUE(account_id, provider) ------
--
-- One Whapi channel and one Meta number per account. A second channel
-- of the SAME provider is out of scope: the routing selector picks a
-- provider per surface, and two Whapi channels would make "which one"
-- ambiguous everywhere without adding a capability anyone asked for.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_config_account_provider_key'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_account_provider_key UNIQUE (account_id, provider);
  END IF;
END $$;

-- Exactly one primary per account. A partial unique index is the only
-- way to say "at most one row where is_primary" in Postgres.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_one_primary
  ON whatsapp_config(account_id)
  WHERE is_primary;

-- An account that somehow ended up with several rows and no primary
-- (or more than one) would break the fallback. Normalise: the oldest
-- row wins. Runs before the index above would be violated on re-run
-- because the index creation is IF NOT EXISTS and this is idempotent.
UPDATE whatsapp_config c
   SET is_primary = FALSE
 WHERE c.is_primary
   AND EXISTS (
     SELECT 1 FROM whatsapp_config o
      WHERE o.account_id = c.account_id
        AND o.is_primary
        AND (o.created_at, o.id) < (c.created_at, c.id)
   );

COMMENT ON COLUMN whatsapp_config.provider IS
  'Which gateway this row is credentials for: whapi (linked-device channel) or meta (Cloud API number). Determines how every other column is interpreted.';

COMMENT ON COLUMN whatsapp_config.label IS
  'Operator-facing name for this number, shown in the routing selector. NULL falls back to the phone number.';

COMMENT ON COLUMN whatsapp_config.is_primary IS
  'The account fallback channel: used by any surface with no whatsapp_routes row, and by a new conversation with no inbound history. Exactly one per account (partial unique index).';

COMMENT ON COLUMN whatsapp_config.app_secret IS
  'Meta only. App secret for X-Hub-Signature-256 verification, AES-256-GCM encrypted. NULL for Whapi rows, or when the deployment sets META_APP_SECRET instead.';

-- The Meta-era column meanings come back for provider='meta' rows, so
-- the 040 comments (which describe the Whapi reading) are no longer
-- true for every row. Restate them as provider-dependent.
COMMENT ON COLUMN whatsapp_config.phone_number_id IS
  'provider=whapi: Whapi channel id (e.g. MANTIS-M72HC), or the connected phone number when none was supplied. provider=meta: Meta phone number id. UNIQUE either way — both inbound webhooks route on it.';

COMMENT ON COLUMN whatsapp_config.access_token IS
  'provider=whapi: Whapi channel token. provider=meta: Meta permanent access token. AES-256-GCM encrypted with ENCRYPTION_KEY.';

COMMENT ON COLUMN whatsapp_config.verify_token IS
  'provider=whapi: shared secret presented as ?secret= on the callback URL. provider=meta: the hub.verify_token echoed during Meta''s GET handshake. AES-256-GCM encrypted.';

COMMENT ON COLUMN whatsapp_config.waba_id IS
  'provider=whapi: the connected phone number, display only (Whapi has no WABA). provider=meta: the real WhatsApp Business Account id, used for template submission.';

COMMENT ON COLUMN whatsapp_config.subscribed_apps_at IS
  'provider=meta: when POST /{waba_id}/subscribed_apps last succeeded. Was deprecated by 040 under Whapi-only; live again for Meta rows.';

-- ============================================================
-- 2. messages.provider — which channel carried this message
-- ============================================================
--
-- Conversations remain one-per-contact, so the thread itself is
-- channel-agnostic and this is what lets an outbound reply follow the
-- customer back to the number they actually wrote to.
--
-- Backfilled to 'whapi' rather than left NULL so every read path can
-- assume a value. Rows predating migration 040 were in truth carried
-- by Meta, but this column is routing metadata, not an audit record,
-- and those conversations are long cold.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS provider TEXT;

UPDATE messages SET provider = 'whapi' WHERE provider IS NULL;

COMMENT ON COLUMN messages.provider IS
  'Gateway that carried this message (whapi | meta). Drives which channel an agent reply goes back out on. Backfilled to whapi for rows predating migration 046.';

-- Reply routing asks "what did this contact last write in on?", which
-- is a descending scan of one conversation's customer messages.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_provider
  ON messages(conversation_id, created_at DESC)
  WHERE sender_type = 'customer';

-- ============================================================
-- 3. whatsapp_routes — the admin-level per-surface selector
-- ============================================================
--
-- One row per surface an account has explicitly routed. No row means
-- "use the primary channel", so an install that never opens the
-- selector behaves exactly as it did before this migration.
CREATE TABLE IF NOT EXISTS whatsapp_routes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Kept as a CHECK rather than an enum type so adding a surface is a
  -- one-line constraint swap, not a CREATE TYPE + rewrite.
  surface TEXT NOT NULL CHECK (surface IN (
    'inbox',      -- the agent composer in the dashboard
    'broadcast',  -- campaigns
    'automation', -- the stateless trigger -> steps engine
    'flow',       -- the stateful conversational runner
    'ai_reply',   -- AI auto-reply
    'api'         -- public /api/v1/messages
  )),
  config_id UUID NOT NULL REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (account_id, surface)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_routes_account ON whatsapp_routes(account_id);

ALTER TABLE whatsapp_routes ENABLE ROW LEVEL SECURITY;

-- Readable by any member (the composer needs to know which number it
-- is sending from), writable by admins — same ladder as the channel
-- credentials themselves in 017.
DROP POLICY IF EXISTS whatsapp_routes_select ON whatsapp_routes;
CREATE POLICY whatsapp_routes_select ON whatsapp_routes FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS whatsapp_routes_insert ON whatsapp_routes;
CREATE POLICY whatsapp_routes_insert ON whatsapp_routes FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_routes_update ON whatsapp_routes;
CREATE POLICY whatsapp_routes_update ON whatsapp_routes FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_routes_delete ON whatsapp_routes;
CREATE POLICY whatsapp_routes_delete ON whatsapp_routes FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_routes;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_routes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE whatsapp_routes IS
  'Per-surface channel selection. A missing row means the surface uses the account primary channel (whatsapp_config.is_primary).';

-- ============================================================
-- 4. message_templates: the Meta review lifecycle comes back
-- ============================================================
--
-- 040 marked these DEPRECATED because Whapi has no template registry.
-- With a Meta number connected they are live again — but ONLY for
-- templates sent through it. A template sent over Whapi is still
-- rendered locally and needs no approval, which is why status stays
-- advisory rather than becoming a send-time gate for both providers.
COMMENT ON COLUMN message_templates.meta_template_id IS
  'Meta template id once submitted, used as hsm_id on edit/delete. NULL for local-only templates and for every template on a Whapi-only install.';

COMMENT ON COLUMN message_templates.status IS
  'Meta review state. Enforced only when sending through a provider=meta channel; Whapi renders any template locally and ignores it.';

COMMENT ON COLUMN message_templates.submission_error IS
  'Last 4xx from Meta on submit. NULL for local-only templates.';

COMMENT ON COLUMN message_templates.rejection_reason IS
  'Meta review rejection reason, surfaced from the template webhook.';

COMMENT ON COLUMN message_templates.header_handle IS
  'Meta Resumable Upload handle for media headers. Whapi sends media headers by plain URL (header_media_url).';
