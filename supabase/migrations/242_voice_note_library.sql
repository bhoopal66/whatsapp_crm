-- 242_voice_note_library.sql — a workspace library of ready voice notes
--
-- Staff keep short voice notes per subject and language (a welcome, the
-- documents a bank needs, a missing-documents reminder, a status update)
-- and send one from the composer's More menu as an ordinary voice
-- message, through the normal send path (team-activity limits, opt-out
-- and the Meta window apply as for any send).
--
--   * Four built-in subjects live in code AND in this file's CHECK
--     (`VOICE_BUILTIN_SUBJECTS`, src/lib/voice-library/constants.ts;
--     constants.test.ts reads this file). Staff (agent and up) add more
--     as rows of voice_note_subjects.
--   * Four languages, fixed: en, hi, ar, ur (`VOICE_LANGUAGES`, pinned
--     the same way).
--   * An entry is a browser recording, or AI text-to-speech from a
--     script. A fixed entry stores its audio at
--       chat-media/account-<account id>/voice-library/<uuid>.ogg
--     (023's RLS matches only the first segment; 155's staged sweep
--     looks only under staged/, so library audio is never swept). A
--     personalised TTS entry stores the script only ({name}, {company})
--     and is spoken afresh for each send.
--   * Everyone in the workspace reads (bank guests nothing:
--     is_account_member ignores guest rows); agents and up add; the
--     author or an admin deletes. Entries are never edited: no UPDATE
--     grant.
--
-- Re-runnable; no BEGIN/COMMIT. Verify: supabase/ci/verify-voice-note-library.sql.

-- ------------------------------------------------------------------
-- 1. Staff-added subjects
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.voice_note_subjects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  label       text NOT NULL,
  created_by  uuid DEFAULT auth.uid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT voice_note_subjects_label_check
    CHECK (char_length(label) BETWEEN 1 AND 60 AND label !~ '^[[:space:]]*$'),
  CONSTRAINT voice_note_subjects_id_account_key UNIQUE (id, account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS voice_note_subjects_label_uniq
  ON public.voice_note_subjects (account_id, lower(btrim(label)));

COMMENT ON TABLE public.voice_note_subjects IS
  'Voice-note library subjects added by staff (the four built-in ones live in code and in voice_note_entries.builtin_subject). Migration 242.';

-- ------------------------------------------------------------------
-- 2. Entries
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.voice_note_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  builtin_subject  text,
  subject_id       uuid,
  language         text NOT NULL,
  title            text NOT NULL,
  source           text NOT NULL,
  script           text,
  personalised     boolean NOT NULL DEFAULT false,
  voice            text,
  storage_path     text,
  media_url        text,
  duration_ms      integer,
  created_by       uuid DEFAULT auth.uid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT voice_note_entries_subject_fkey
    FOREIGN KEY (subject_id, account_id)
    REFERENCES public.voice_note_subjects (id, account_id) ON DELETE RESTRICT,
  CONSTRAINT voice_note_entries_builtin_subject_check
    CHECK (builtin_subject IS NULL OR builtin_subject IN
      ('welcome', 'documents_required', 'missing_documents', 'status_update')),
  CONSTRAINT voice_note_entries_one_subject_check
    CHECK ((builtin_subject IS NULL) <> (subject_id IS NULL)),
  CONSTRAINT voice_note_entries_language_check
    CHECK (language IN ('en', 'hi', 'ar', 'ur')),
  CONSTRAINT voice_note_entries_title_check
    CHECK (char_length(title) BETWEEN 1 AND 80 AND title !~ '^[[:space:]]*$'),
  CONSTRAINT voice_note_entries_source_check
    CHECK (source IN ('recording', 'tts')),
  CONSTRAINT voice_note_entries_script_check
    CHECK (
      (source = 'recording' AND script IS NULL)
      OR (source = 'tts' AND script IS NOT NULL
          AND char_length(script) BETWEEN 1 AND 1500
          AND script !~ '^[[:space:]]*$')
    ),
  CONSTRAINT voice_note_entries_personalised_check
    CHECK (NOT personalised OR source = 'tts'),
  -- A fixed entry has its audio; a personalised one is spoken per send.
  CONSTRAINT voice_note_entries_audio_check
    CHECK (
      (personalised AND storage_path IS NULL AND media_url IS NULL)
      OR (NOT personalised AND storage_path IS NOT NULL AND media_url IS NOT NULL
          AND storage_path LIKE 'account-' || account_id::text || '/voice-library/%'
          AND char_length(media_url) <= 2048)
    ),
  CONSTRAINT voice_note_entries_voice_check
    CHECK (voice IS NULL OR voice ~ '^[a-z]{1,20}$'),
  CONSTRAINT voice_note_entries_duration_check
    CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 3600000)
);

CREATE INDEX IF NOT EXISTS voice_note_entries_account_idx
  ON public.voice_note_entries (account_id, language, created_at DESC);
CREATE INDEX IF NOT EXISTS voice_note_entries_subject_idx
  ON public.voice_note_entries (subject_id) WHERE subject_id IS NOT NULL;

COMMENT ON TABLE public.voice_note_entries IS
  'Voice-note library: staff recordings and AI-spoken scripts per subject and language, shared with the whole workspace. Migration 242.';

-- ------------------------------------------------------------------
-- 3. RLS
-- ------------------------------------------------------------------
ALTER TABLE public.voice_note_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_note_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS voice_note_subjects_select ON public.voice_note_subjects;
CREATE POLICY voice_note_subjects_select ON public.voice_note_subjects
  FOR SELECT TO authenticated
  USING (public.is_account_member(account_id, 'viewer'));

DROP POLICY IF EXISTS voice_note_subjects_insert ON public.voice_note_subjects;
CREATE POLICY voice_note_subjects_insert ON public.voice_note_subjects
  FOR INSERT TO authenticated
  WITH CHECK (public.is_account_member(account_id, 'agent')
              AND created_by = auth.uid());

-- An unused subject only (the entries FK restricts).
DROP POLICY IF EXISTS voice_note_subjects_delete ON public.voice_note_subjects;
CREATE POLICY voice_note_subjects_delete ON public.voice_note_subjects
  FOR DELETE TO authenticated
  USING (public.is_account_member(account_id, 'admin')
         OR (created_by = auth.uid() AND public.is_account_member(account_id, 'agent')));

DROP POLICY IF EXISTS voice_note_entries_select ON public.voice_note_entries;
CREATE POLICY voice_note_entries_select ON public.voice_note_entries
  FOR SELECT TO authenticated
  USING (public.is_account_member(account_id, 'viewer'));

DROP POLICY IF EXISTS voice_note_entries_insert ON public.voice_note_entries;
CREATE POLICY voice_note_entries_insert ON public.voice_note_entries
  FOR INSERT TO authenticated
  WITH CHECK (public.is_account_member(account_id, 'agent')
              AND created_by = auth.uid());

DROP POLICY IF EXISTS voice_note_entries_delete ON public.voice_note_entries;
CREATE POLICY voice_note_entries_delete ON public.voice_note_entries
  FOR DELETE TO authenticated
  USING (public.is_account_member(account_id, 'admin')
         OR (created_by = auth.uid() AND public.is_account_member(account_id, 'agent')));

REVOKE ALL ON public.voice_note_subjects, public.voice_note_entries FROM PUBLIC, anon;
REVOKE UPDATE ON public.voice_note_subjects, public.voice_note_entries FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.voice_note_subjects, public.voice_note_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_note_subjects, public.voice_note_entries TO service_role;
