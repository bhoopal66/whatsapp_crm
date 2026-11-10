-- 179: case notes written by the system (no person as author).
--
-- Why. The case document files module (021) and the case automation
-- rules module (020c) need the database itself to leave a note on a case
-- ("@<coordinator uuid> the latest upload of the trade licence failed its
-- checks"). Until now a note always had a person: case_notes.author_id
-- was NOT NULL and case_note_add (123) requires an actor who may write
-- the case. Nothing calls the new function yet; this only makes room.
--
-- What changes.
--   * case_notes.author_id becomes nullable, and a new system_author
--     ('system:files' | 'system:rules') names the writer of a system
--     note. A CHECK holds exactly one of the two, so a staff note keeps
--     its author and a system note can never pass for anyone's.
--     Existing rows all carry author_id and pass both CHECKs.
--   * case_note_add_system(case, system, body, now) adds a system note:
--     the same refusals (CASE_NOT_FOUND, NOTE_EMPTY, NOTE_TOO_LONG, plus
--     SYSTEM_AUTHOR_INVALID) and the same @<uuid> mention resolution as
--     case_note_add (stored only for people case_can_write allows).
--     case_note_add has no closed-case refusal, so neither has this.
--     SECURITY DEFINER and executable by no API role, the service role
--     included: only other definer functions (021, 020c) call it.
--
-- Readers of author_id, checked for a NULL author:
--   * case_notes is append-only for every writer (123's case_append_only
--     trigger) and no API role may write it, so there is no author-only
--     edit or delete rule a NULL could widen.
--   * case_notes_select / case_note_mentions_select read the case, never
--     the author.
--   * case_timeline (124) returns the note with actor NULL, which the
--     timeline already shows for system rows.
--   * case_inbox (162) may take a system note as the last touch with
--     last_touched_by NULL; that is a value it already returns for a case
--     with no activity, and no code writes a system note yet.
--
-- Re-runnable: every statement is guarded or replaces in place.

SET lock_timeout = '5s';

-- ---------- 1. Columns and CHECKs ----------

ALTER TABLE public.case_notes ALTER COLUMN author_id DROP NOT NULL;
ALTER TABLE public.case_notes ADD COLUMN IF NOT EXISTS system_author text NULL;

ALTER TABLE public.case_notes DROP CONSTRAINT IF EXISTS case_notes_system_author_check;
ALTER TABLE public.case_notes ADD CONSTRAINT case_notes_system_author_check
  CHECK (system_author IN ('system:files', 'system:rules'));

ALTER TABLE public.case_notes DROP CONSTRAINT IF EXISTS case_notes_one_author_check;
ALTER TABLE public.case_notes ADD CONSTRAINT case_notes_one_author_check
  CHECK (num_nonnulls(author_id, system_author) = 1);

COMMENT ON COLUMN public.case_notes.author_id IS
  'The person who wrote the note; NULL for a system note (system_author set). Migration 179.';
COMMENT ON COLUMN public.case_notes.system_author IS
  'The system writer of a note (system:files, system:rules); NULL for a person''s note. Exactly one of author_id and system_author is set. Migration 179.';

-- ---------- 2. case_note_add_system ----------

-- Adds a system-authored internal note (1..10000 chars, not blank).
-- Mentions are resolved exactly as case_note_add resolves them: @<uuid>
-- in canonical lowercase form, stored only for users who pass
-- case_can_write; every other handle is ignored. Returns the note id.
CREATE OR REPLACE FUNCTION public.case_note_add_system(p_case uuid, p_system text, p_body text,
  p_now timestamptz DEFAULT now())
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c         public.cases%ROWTYPE;
  v_id      uuid;
  v_handles text[];
  v_ok      uuid[];
BEGIN
  -- case_tools_lock_for_write's lock and refusal, without the actor.
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  IF p_system IS NULL OR p_system NOT IN ('system:files', 'system:rules') THEN
    RAISE EXCEPTION 'system author % is not system:files or system:rules', p_system
      USING ERRCODE = 'check_violation', HINT = 'SYSTEM_AUTHOR_INVALID';
  END IF;
  IF p_body IS NULL OR p_body ~ '^[[:space:]]*$' THEN
    RAISE EXCEPTION 'note is empty' USING ERRCODE = 'check_violation', HINT = 'NOTE_EMPTY';
  END IF;
  IF char_length(p_body) > 10000 THEN
    RAISE EXCEPTION 'note is longer than 10000 characters' USING ERRCODE = 'check_violation', HINT = 'NOTE_TOO_LONG';
  END IF;
  INSERT INTO public.case_notes (case_id, account_id, author_id, system_author, body, created_at)
  VALUES (p_case, c.account_id, NULL, p_system, p_body, coalesce(p_now, now()))
  RETURNING id INTO v_id;
  -- 123's mention resolution, unchanged: trailing '.' / '-' are sentence
  -- punctuation, and only a canonical uuid of someone who may act on the
  -- case is stored.
  SELECT coalesce(array_agg(DISTINCT h), '{}'::text[]) INTO v_handles
    FROM (SELECT regexp_replace(m[1], '[.-]+$', '') AS h
            FROM regexp_matches(p_body, '@([A-Za-z0-9_.-]+)', 'g') AS m) x
   WHERE h <> '';
  SELECT coalesce(array_agg(h::uuid ORDER BY h), '{}'::uuid[]) INTO v_ok
    FROM unnest(v_handles) AS h
   WHERE h ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND public.case_can_write(p_case, h::uuid);
  INSERT INTO public.case_note_mentions (note_id, case_id, account_id, user_id)
  SELECT v_id, p_case, c.account_id, u FROM unnest(v_ok) AS u;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.case_note_add_system(uuid, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.case_note_add_system(uuid, text, text, timestamptz) IS
  'Adds a system-authored case note (system:files / system:rules) with case_note_add''s validation and mention rules. Executable by no API role; called from other SECURITY DEFINER functions only. Migration 179.';

RESET lock_timeout;
