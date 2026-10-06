-- ============================================================
-- 055_message_forwarding.sql — remember which messages were forwarded.
--
-- Two sources set the flag, and the inbox renders both the same way
-- (a "Forwarded" label above the bubble):
--
--   1. INBOUND — the customer forwarded something to us. Both gateways
--      say so on the payload (Whapi `context.forwarded`, Meta
--      `context.forwarded` / `frequently_forwarded`); the normalisers
--      lift it into `NormalizedInboundMessage.forwarded`. It used to be
--      dropped, so an agent could not tell a customer's own words from
--      a chain message they were passing along.
--
--   2. OUTBOUND — an agent forwarded a message from one chat into
--      another (`POST /api/whatsapp/forward`). Neither gateway has a
--      cross-chat forward that works for both providers, so the content
--      is re-sent; this column is what records that it was a forward.
--      The recipient's WhatsApp does NOT show a "Forwarded" label.
--
-- NOT NULL DEFAULT false, so every existing row reads as "not
-- forwarded" and the inserts that predate this migration need no change.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS is_forwarded boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN messages.is_forwarded IS
  'True when the customer forwarded this message to us, or an agent forwarded it into this chat from another (migration 055).';
