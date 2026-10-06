-- ============================================================
-- 050_contact_card_messages.sql — shared contact cards as their own
-- message type.
--
-- A customer sharing a contact from WhatsApp used to land as a text
-- message reading "[contact] Name": the numbers on the card were thrown
-- away at the webhook, and the inbox showed a bare label. Both
-- normalisers now keep the card (name, phones, emails, organisation),
-- the pipeline stores it here, and the thread renders it as a card
-- with a "save to contacts" action.
--
-- `content_type` gains 'contacts' (the CHECK is dropped and re-added
-- the same way migration 010 did for 'interactive'); `contact_cards`
-- holds the parsed card(s) as JSON — an array, since WhatsApp lets a
-- customer share several at once.
--
-- Re-runnable: DROP IF EXISTS / ADD; ADD COLUMN IF NOT EXISTS.
-- ============================================================

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_content_type_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_content_type_check
  CHECK (content_type IN (
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive', 'contacts'
  ));

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS contact_cards jsonb
    CHECK (contact_cards IS NULL OR jsonb_typeof(contact_cards) = 'array');
