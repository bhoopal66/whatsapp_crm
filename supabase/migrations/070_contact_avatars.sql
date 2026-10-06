-- ============================================================
-- 070: WhatsApp profile pictures for contacts
--
-- `contacts.avatar_url` has existed since 001 and the inbox already
-- renders it, but nothing ever wrote it, so every chat showed an
-- initial. The inbox now asks POST /api/whatsapp/contacts/avatars for
-- the contacts it has loaded, and the server fills the column from the
-- Whapi number's contact profile (`GET /contacts/{id}/profile`).
--
-- The picture Whapi links to is a WhatsApp CDN URL that expires, so
-- the bytes are copied into the `chat-media` bucket under
-- `account-<id>/avatars/` (023's RLS matches only the first segment)
-- and `avatar_url` holds that copy, never the CDN link.
--
-- This column is the throttle. It records when the profile was last
-- asked, whatever the answer:
--
--   * a picture        -> avatar_url set, avatar_checked_at = now()
--   * no picture       -> avatar_url NULL (they removed it, or their
--                         privacy hides it), avatar_checked_at = now()
--   * a failed attempt -> neither column moves, so the next inbox load
--                         tries again
--
-- A contact is asked again once the stamp is a week old, which is what
-- picks up a changed picture. NULL means never asked: every existing
-- contact is due on the first inbox load after this is applied.
--
-- Meta Cloud API has no profile-picture endpoint, so a contact who
-- only ever wrote to a Meta number keeps a NULL stamp and the initial.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS.
-- ============================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS avatar_checked_at timestamptz;

COMMENT ON COLUMN public.contacts.avatar_checked_at IS
  'When the WhatsApp profile picture was last looked up (070). NULL = never. Refreshed after 7 days.';
