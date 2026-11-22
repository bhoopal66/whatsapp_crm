-- 252: broadcast drafts that really reopen (track D, U14).
--
-- A draft used to store only name, template and a thin audience_filter,
-- so "Save draft" could not be continued. `draft_state` holds the whole
-- wizard (template ref, full audience incl. the narrowing filters,
-- variables, header media, schedule, quiet hours, follow-up flow; a CSV
-- audience only when small). The shape is owned by
-- src/lib/broadcasts/draft-state.ts. NULL on every real campaign and on
-- drafts saved before this migration (those still list, but cannot be
-- reopened).
--
-- No policy change: broadcasts_insert/update/delete already allow
-- admins (135), which is who creates campaigns.
--
-- Guarded and re-runnable.

ALTER TABLE public.broadcasts
  ADD COLUMN IF NOT EXISTS draft_state jsonb NULL;

COMMENT ON COLUMN public.broadcasts.draft_state IS
  'Whole wizard state of a status=draft campaign (lib/broadcasts/draft-state.ts, version 1). May hold uploaded CSV rows (phones, names): personal data, deleted with the draft. Migration 252.';
