import { randomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/ai/admin-client';
import { AiError } from '@/lib/ai/types';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isOggOpus } from '@/lib/voice-library/audio';
import {
  VOICE_MAX_BYTES,
  voiceLibraryPath,
} from '@/lib/voice-library/constants';
import { parseEntryInput } from '@/lib/voice-library/entry-input';
import {
  loadTtsKey,
  removeVoiceAudio,
  storeVoiceAudio,
  voiceTtsLimited,
} from '@/lib/voice-library/server';
import { synthesizeSpeech } from '@/lib/voice-library/tts';
import { ENTRY_COLUMNS } from '@/lib/voice-library/types';

export const maxDuration = 60;

const INPUT_ERRORS: Record<string, string> = {
  subject: 'Pick a subject.',
  language: 'Pick a language.',
  title: 'Give the voice note a title of up to 80 characters.',
  source: 'Record a voice note or write a script.',
  empty: 'Write the script to be spoken.',
  too_long: 'The script is too long (1,500 characters at most).',
  unknown_placeholder: 'Only {name} and {company} can be filled in.',
  placeholder_in_fixed:
    'A fixed script cannot use {name} or {company}. Turn on "Personalise" or remove them.',
  no_placeholder:
    'A personalised script needs {name} or {company}; otherwise save it as fixed.',
};

/**
 * POST /api/voice-library/entries  (agent and up)
 *
 * multipart/form-data: subject (`builtin:<key>` or a subject id),
 * language, title, source = recording | tts, and either `file` (the
 * composer recorder's Ogg/Opus) or `script` (+ `voice`, `personalised`).
 *
 * A recording and a fixed script are stored once at
 * chat-media/account-<id>/voice-library/<entry id>.ogg; a personalised
 * script stores no audio (it is spoken per send).
 *
 * Audio and row are both written with the service role: 242 gives
 * `authenticated` no INSERT on voice_note_entries and no write in the
 * voice-library/ folder, so a client cannot point an entry at a foreign
 * URL or a colleague's object. The checks that stand in for RLS are
 * here: agent and up (requireRole), the caller's ACTIVE account as the
 * row's account and path, the author stamped from the session, and a
 * custom subject resolved through the composite FK (subject_id,
 * account_id), so another workspace's subject is refused. The object is
 * removed again if the insert fails.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent');

    const form = await request.formData().catch(() => null);
    if (!form) {
      return NextResponse.json(
        { error: 'Send the voice note as a form.' },
        { status: 400 }
      );
    }
    const parsed = parseEntryInput((name) => form.get(name));
    if (!parsed.ok) {
      return NextResponse.json(
        { error: INPUT_ERRORS[parsed.error], code: parsed.error },
        { status: 400 }
      );
    }
    const input = parsed.value;
    const entryId = randomUUID();

    let bytes: Uint8Array | null = null;
    if (input.source === 'recording') {
      const file = form.get('file');
      if (!(file instanceof Blob) || file.size === 0) {
        return NextResponse.json(
          { error: 'The recording is missing.', code: 'file' },
          { status: 400 }
        );
      }
      if (file.size > VOICE_MAX_BYTES) {
        return NextResponse.json(
          { error: 'The recording is over 16 MB.', code: 'file' },
          { status: 400 }
        );
      }
      bytes = new Uint8Array(await file.arrayBuffer());
      if (!isOggOpus(bytes)) {
        return NextResponse.json(
          {
            error: 'The recording is not an Ogg/Opus voice note.',
            code: 'file',
          },
          { status: 400 }
        );
      }
    } else if (!input.personalised) {
      const limited = voiceTtsLimited(userId, accountId);
      if (limited) return limited;
      const key = await loadTtsKey(accountId);
      if (!key.ok) {
        return NextResponse.json(
          { error: 'AI speech is not available.', code: key.reason },
          { status: 400 }
        );
      }
      bytes = await synthesizeSpeech({
        accountId,
        apiKey: key.apiKey,
        text: input.script,
        voice: input.voice,
        language: input.language,
      });
    } else {
      // Spoken per send: still refuse now when it could never be.
      const key = await loadTtsKey(accountId);
      if (!key.ok) {
        return NextResponse.json(
          { error: 'AI speech is not available.', code: key.reason },
          { status: 400 }
        );
      }
    }

    let path: string | null = null;
    let mediaUrl: string | null = null;
    if (bytes) {
      path = voiceLibraryPath(accountId, entryId);
      mediaUrl = await storeVoiceAudio(supabaseAdmin(), path, bytes);
    }

    const { data, error } = await supabaseAdmin()
      .from('voice_note_entries')
      .insert({
        id: entryId,
        account_id: accountId,
        builtin_subject: input.subject.builtin,
        subject_id: input.subject.subjectId,
        language: input.language,
        title: input.title,
        source: input.source,
        script: input.source === 'tts' ? input.script : null,
        personalised: input.source === 'tts' && input.personalised,
        voice: input.source === 'tts' ? input.voice : null,
        storage_path: path,
        media_url: mediaUrl,
        duration_ms: input.source === 'recording' ? input.durationMs : null,
        created_by: userId,
      })
      .select(ENTRY_COLUMNS)
      .single();
    if (error) {
      if (path) await removeVoiceAudio(path);
      console.error('[voice-library] entry insert failed:', error.message);
      return NextResponse.json(
        { error: 'Could not save the voice note.' },
        { status: error.code === '23503' ? 400 : 500 }
      );
    }
    return NextResponse.json({ entry: data }, { status: 201 });
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    return toErrorResponse(err);
  }
}
