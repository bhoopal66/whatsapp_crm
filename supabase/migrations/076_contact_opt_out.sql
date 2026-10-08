-- ============================================================
-- 076: a contact's opt-out is a column, not a contact tag
--
-- When a customer asks not to be messaged ("stop", "unsubscribe"),
-- the AI bot and the TypeSafe opt-out watch record it by tagging the
-- contact `opted-out`. Nothing reads that tag: a broadcast whose
-- audience happens to include the contact still messages them. And
-- the contact tags (`tags` / `contact_tags`) are being retired in
-- favour of chat tags (migration 075), so the request needs a home
-- that outlives them.
--
-- contacts.opted_out_at records when the customer asked. NULL means
-- they never did. Every broadcast skips a contact with a stamp, and
-- the bot and the watch write the stamp instead of the tag.
--
-- Backfill, once: a contact already carrying a tag named `opted-out`
-- (any case — the tag was created by name, and an admin may have
-- made one by hand) gets the time that tag was first attached, or now()
-- when the join has no timestamp. Only NULL stamps are filled, so a
-- re-run changes nothing and never moves an existing stamp.
--
-- `tags` and `contact_tags` are left exactly as they are; a later
-- migration retires them.
--
-- Re-runnable: ADD COLUMN / CREATE INDEX IF NOT EXISTS, and the
-- backfill only touches rows still NULL.
-- ============================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS opted_out_at timestamptz NULL;

COMMENT ON COLUMN public.contacts.opted_out_at IS
  'When the customer asked not to be messaged; every broadcast skips them. NULL = never asked (migration 076).';

-- The tag lives in the contact's own account: tags.account_id
-- (migration 017) is matched, so one account's `opted-out` tag can
-- never stamp another account's contact.
UPDATE public.contacts c
SET opted_out_at = o.first_tagged_at
FROM (
  SELECT ct.contact_id,
         COALESCE(min(ct.created_at), now()) AS first_tagged_at
  FROM public.contact_tags ct
  JOIN public.tags t ON t.id = ct.tag_id
  JOIN public.contacts c2 ON c2.id = ct.contact_id
  WHERE lower(t.name) = 'opted-out'
    AND t.account_id = c2.account_id
  GROUP BY ct.contact_id
) o
WHERE c.id = o.contact_id
  AND c.opted_out_at IS NULL;

-- Broadcast audiences subtract an account's opted-out contacts; the
-- set is small, so a partial index keeps that lookup cheap.
CREATE INDEX IF NOT EXISTS idx_contacts_opted_out
  ON public.contacts (account_id)
  WHERE opted_out_at IS NOT NULL;
