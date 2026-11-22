/**
 * The add-entry form, checked once on the server (and reused by the
 * dialog to say what is missing). Pure: no file bytes, only fields.
 */
import {
  DEFAULT_TTS_VOICE,
  isBuiltinSubject,
  isTtsVoice,
  isVoiceLanguage,
  type TtsVoice,
  type VoiceBuiltinSubject,
  type VoiceLanguage,
} from './constants';
import { cleanTitle, scriptProblem, type ScriptProblem } from './script';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EntrySubject =
  | { builtin: VoiceBuiltinSubject; subjectId: null }
  | { builtin: null; subjectId: string };

/** `builtin:<key>` or a subject row id. */
export function parseSubjectKey(value: unknown): EntrySubject | null {
  if (typeof value !== 'string') return null;
  if (value.startsWith('builtin:')) {
    const key = value.slice('builtin:'.length);
    return isBuiltinSubject(key) ? { builtin: key, subjectId: null } : null;
  }
  return UUID.test(value) ? { builtin: null, subjectId: value } : null;
}

export type EntryInput =
  | {
      source: 'recording';
      subject: EntrySubject;
      language: VoiceLanguage;
      title: string;
      durationMs: number | null;
    }
  | {
      source: 'tts';
      subject: EntrySubject;
      language: VoiceLanguage;
      title: string;
      script: string;
      personalised: boolean;
      voice: TtsVoice;
    };

export type EntryInputError =
  'subject' | 'language' | 'title' | 'source' | ScriptProblem;

/** Read the form fields (strings as FormData gives them). */
export function parseEntryInput(
  get: (name: string) => unknown
): { ok: true; value: EntryInput } | { ok: false; error: EntryInputError } {
  const subject = parseSubjectKey(get('subject'));
  if (!subject) return { ok: false, error: 'subject' };
  const language = get('language');
  if (!isVoiceLanguage(language)) return { ok: false, error: 'language' };
  const title = cleanTitle(get('title'));
  if (!title) return { ok: false, error: 'title' };

  const source = get('source');
  if (source === 'recording') {
    const raw = Number(get('duration_ms'));
    const durationMs =
      Number.isInteger(raw) && raw >= 0 && raw <= 3_600_000 ? raw : null;
    return {
      ok: true,
      value: { source, subject, language, title, durationMs },
    };
  }
  if (source === 'tts') {
    const script =
      typeof get('script') === 'string' ? (get('script') as string) : '';
    const personalised = get('personalised') === 'true';
    const problem = scriptProblem(script, personalised);
    if (problem) return { ok: false, error: problem };
    const voiceRaw = get('voice');
    const voice = isTtsVoice(voiceRaw) ? voiceRaw : DEFAULT_TTS_VOICE;
    return {
      ok: true,
      value: {
        source,
        subject,
        language,
        title,
        script: script.trim(),
        personalised,
        voice,
      },
    };
  }
  return { ok: false, error: 'source' };
}
