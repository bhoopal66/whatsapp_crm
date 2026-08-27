-- ============================================================
-- Switch the WhatsApp transport from Meta Cloud API to Whapi.Cloud
--
-- The application no longer talks to graph.facebook.com. It talks to
-- gate.whapi.cloud, where the unit of connection is a *channel*: one
-- token that identifies both the gateway account and the WhatsApp
-- number paired to it.
--
-- ─── Why no columns are renamed ─────────────────────────────────
--
-- `whatsapp_config` was shaped around Meta's credential triple, but
-- every Whapi concept lands cleanly on an existing column — including
-- the constraints that actually matter:
--
--   phone_number_id → Whapi CHANNEL ID.
--                     Already UNIQUE (migration 013), which is exactly
--                     the "one channel belongs to one account" property
--                     the inbound router depends on. Renaming would
--                     have meant rebuilding that constraint and its
--                     index for no functional gain.
--
--   access_token    → Whapi CHANNEL TOKEN, AES-256-GCM encrypted.
--
--   verify_token    → WEBHOOK SHARED SECRET, AES-256-GCM encrypted.
--                     Meta used this column for the `hub.challenge`
--                     handshake. Whapi has no handshake and cannot
--                     attach a custom header to a callback, so the
--                     secret travels in the callback URL's query
--                     string and this column stores what we compare
--                     against. Same purpose — proving the caller is
--                     who they claim — different mechanism.
--
--   waba_id         → the connected WhatsApp PHONE NUMBER (display
--                     only). Whapi has no WhatsApp Business Account
--                     equivalent.
--
--   registered_at   → when our callback URL was last registered on
--                     the channel via `PATCH /settings`. The Whapi
--                     analogue of Meta's POST /{phone_number_id}/register.
--
-- Renaming them would have touched ~20 query sites for a cosmetic win
-- and left a fork mid-migration if any were missed. COMMENTs make the
-- mapping discoverable from `\d+ whatsapp_config` instead.
--
-- Idempotent — safe to re-run.
-- ============================================================

COMMENT ON TABLE whatsapp_config IS
  'One connected WhatsApp channel per account, via Whapi.Cloud. Column names predate the provider switch — see the per-column comments for what each now holds.';

COMMENT ON COLUMN whatsapp_config.phone_number_id IS
  'Whapi channel id (e.g. MANTIS-M72HC), or the connected phone number when the operator did not supply one. UNIQUE: the inbound webhook routes on this.';

COMMENT ON COLUMN whatsapp_config.access_token IS
  'Whapi channel token, AES-256-GCM encrypted with ENCRYPTION_KEY.';

COMMENT ON COLUMN whatsapp_config.verify_token IS
  'Shared secret authenticating inbound Whapi callbacks, AES-256-GCM encrypted. Presented as the ?secret= query parameter on the registered callback URL.';

COMMENT ON COLUMN whatsapp_config.waba_id IS
  'Connected WhatsApp phone number, digits only. Display purposes only — Whapi has no WABA concept.';

COMMENT ON COLUMN whatsapp_config.registered_at IS
  'When this deployment''s callback URL was last registered on the channel (PATCH /settings). NULL means inbound messages are not being delivered.';

COMMENT ON COLUMN whatsapp_config.last_registration_error IS
  'Why the most recent webhook registration failed, surfaced verbatim in Settings. NULL when the last attempt succeeded.';

-- Meta subscribed the whole WhatsApp Business Account to an app as a
-- separate step; Whapi has no such call, so this column can never be
-- written again. It is kept (not dropped) so an install migrating from
-- a Meta-era deployment does not lose its audit trail.
COMMENT ON COLUMN whatsapp_config.subscribed_apps_at IS
  'DEPRECATED. Meta-era: when the WABA was subscribed to the app. Never written under Whapi; retained for historical rows.';

-- ============================================================
-- message_templates
--
-- Whapi channels have no template registry: there is no submission,
-- no review, and no approval gate. A template row is now simply a
-- reusable message definition that the app renders locally and sends
-- as an ordinary WhatsApp message.
--
-- `status` keeps its existing CHECK constraint and its existing
-- values. New and edited rows are written as 'APPROVED', which the
-- constraint already allows and which every consumer (the composer's
-- template picker, broadcasts, automations) already gates on. It
-- accurately describes the only state that now exists: sendable.
--
-- Rows left over from a Meta deployment are migrated below so an
-- operator's PENDING/REJECTED backlog does not silently become
-- unusable after the provider switch. A REJECTED row was rejected by a
-- reviewer that no longer exists, so its content is fine to send.
-- ============================================================

UPDATE message_templates
   SET status = 'APPROVED'
 WHERE status IN ('PENDING', 'REJECTED', 'PAUSED', 'IN_APPEAL', 'PENDING_DELETION');

COMMENT ON COLUMN message_templates.status IS
  'Sendability gate. Under Whapi the only reachable value is APPROVED — there is no review step. Other values exist for rows created before the provider switch.';

COMMENT ON COLUMN message_templates.meta_template_id IS
  'DEPRECATED. Meta-era template id. Always NULL under Whapi; retained for historical rows.';

COMMENT ON COLUMN message_templates.header_handle IS
  'DEPRECATED. Meta-era Resumable-Upload handle for image headers. Whapi sends media headers by plain URL (header_media_url).';

COMMENT ON COLUMN message_templates.submission_error IS
  'DEPRECATED. Meta-era submission failure. Always NULL under Whapi — saving a template cannot fail remotely.';

COMMENT ON COLUMN message_templates.rejection_reason IS
  'DEPRECATED. Meta-era review rejection reason. Always NULL under Whapi.';
