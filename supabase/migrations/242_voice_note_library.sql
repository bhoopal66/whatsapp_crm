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
--     is_account_member ignores guest rows); agents and up add, through
--     the route only; the author or an admin deletes. Entries are never
--     edited: no UPDATE grant.
--   * Entries are written by the service role only (POST
--     /api/voice-library/entries, after its role and tenancy checks):
--     a client insert could point media_url at any URL, or storage_path
--     at a colleague's object that deleting the fake entry would then
--     remove. The path is pinned to the entry's own id and the URL to
--     the path (CHECKs below), so even the service role cannot store a
--     foreign one.
--   * Library audio is written and removed by the service role only:
--     023's policies let any member (viewers included) write or delete
--     under their account prefix, so RESTRICTIVE policies below take
--     voice-library/ out of that for `authenticated`. Every other
--     folder (staged/, inbound/, ...) is unchanged.
--   * Deleting an entry keeps its audio while any message of the
--     workspace still points at it (a sent fixed entry's message stores
--     the library URL): voice_library_audio_in_use(), compared on the
--     URL path as 155 does, because the public origin changes.
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

-- The audio's path is the entry's own and its URL points at that path
-- (whatever the origin). Restated drop-and-add so a re-run over an
-- older 242 converges.
ALTER TABLE public.voice_note_entries
  DROP CONSTRAINT IF EXISTS voice_note_entries_own_audio_check;
ALTER TABLE public.voice_note_entries
  ADD CONSTRAINT voice_note_entries_own_audio_check
    CHECK (
      storage_path IS NULL
      OR (storage_path = 'account-' || account_id::text || '/voice-library/' || id::text || '.ogg'
          AND media_url LIKE '%/chat-media/' || storage_path)
    );

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

-- No client INSERT (service role only, see the header): an older 242
-- had a policy and a grant, both dropped here.
DROP POLICY IF EXISTS voice_note_entries_insert ON public.voice_note_entries;

DROP POLICY IF EXISTS voice_note_entries_delete ON public.voice_note_entries;
CREATE POLICY voice_note_entries_delete ON public.voice_note_entries
  FOR DELETE TO authenticated
  USING (public.is_account_member(account_id, 'admin')
         OR (created_by = auth.uid() AND public.is_account_member(account_id, 'agent')));

REVOKE ALL ON public.voice_note_subjects, public.voice_note_entries FROM PUBLIC, anon;
REVOKE ALL ON public.voice_note_subjects, public.voice_note_entries FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.voice_note_subjects TO authenticated;
GRANT SELECT, DELETE ON public.voice_note_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_note_subjects, public.voice_note_entries TO service_role;

-- ------------------------------------------------------------------
-- 4. Library audio in chat-media: service role only
--
-- 023's permissive policies let any member of the account (viewers
-- included) insert, overwrite or delete anything under
-- account-<id>/. These RESTRICTIVE policies are AND-ed with them for
-- `authenticated`, taking the voice-library/ folder out; the service
-- role bypasses RLS and is the folder's only writer. Reads stay public
-- (the bucket is public so the gateways can fetch the audio).
-- ------------------------------------------------------------------
DROP POLICY IF EXISTS "Voice library audio is server-written (insert)" ON storage.objects;
CREATE POLICY "Voice library audio is server-written (insert)"
  ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT (bucket_id = 'chat-media'
                   AND coalesce((storage.foldername(name))[2] = 'voice-library', false)));

DROP POLICY IF EXISTS "Voice library audio is server-written (update)" ON storage.objects;
CREATE POLICY "Voice library audio is server-written (update)"
  ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT (bucket_id = 'chat-media'
              AND coalesce((storage.foldername(name))[2] = 'voice-library', false)))
  WITH CHECK (NOT (bucket_id = 'chat-media'
                   AND coalesce((storage.foldername(name))[2] = 'voice-library', false)));

DROP POLICY IF EXISTS "Voice library audio is server-written (delete)" ON storage.objects;
CREATE POLICY "Voice library audio is server-written (delete)"
  ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT (bucket_id = 'chat-media'
              AND coalesce((storage.foldername(name))[2] = 'voice-library', false)));

-- ------------------------------------------------------------------
-- 5. Is a library object still in a sent message?
--
-- True when any message of the account has a media_url whose path after
-- /chat-media/ (no ?query, #fragment) is p_path. A path not of the
-- library's own shape answers true, so a caller never removes something
-- it cannot reason about. Service role only (the delete route).
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.voice_library_audio_in_use(
  p_account uuid,
  p_path    text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_account IS NULL OR p_path IS NULL
     OR p_path !~ ('^account-' || p_account::text
                   || '/voice-library/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.ogg$') THEN
    RETURN true;
  END IF;
  -- The shape check above leaves no LIKE wildcard in p_path.
  RETURN EXISTS (
    SELECT 1
      FROM public.messages m
      JOIN public.conversations c ON c.id = m.conversation_id
     WHERE c.account_id = p_account
       AND m.media_url LIKE '%/chat-media/' || p_path || '%'
       AND substring(m.media_url FROM '/chat-media/([^?#]+)') = p_path
  );
END
$$;

COMMENT ON FUNCTION public.voice_library_audio_in_use(uuid, text) IS
  'Whether a message of the account still points at this voice-library object (compared on the URL path). '
  'Unknown path shapes answer true. Service role only. Migration 242.';

REVOKE ALL ON FUNCTION public.voice_library_audio_in_use(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_library_audio_in_use(uuid, text) TO service_role;
