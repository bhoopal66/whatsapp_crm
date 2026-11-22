/** Shapes the voice-library routes answer with (no server imports). */
import type {
  TtsVoice,
  VoiceBuiltinSubject,
  VoiceLanguage,
  VoiceSource,
} from './constants';
import type { TtsUnavailableReason } from './tts-reasons';

export interface VoiceSubjectRow {
  id: string;
  label: string;
  created_by: string | null;
}

export interface VoiceEntryRow {
  id: string;
  builtin_subject: VoiceBuiltinSubject | null;
  subject_id: string | null;
  language: VoiceLanguage;
  title: string;
  source: VoiceSource;
  script: string | null;
  personalised: boolean;
  voice: TtsVoice | null;
  media_url: string | null;
  duration_ms: number | null;
  created_by: string | null;
  created_at: string;
}

export interface VoiceLibraryPayload {
  subjects: VoiceSubjectRow[];
  entries: VoiceEntryRow[];
  tts: { available: true } | { available: false; reason: TtsUnavailableReason };
}

/** A subject's key in the picker: `builtin:<key>` or the subject row id. */
export type SubjectKey = `builtin:${VoiceBuiltinSubject}` | string;

export function entrySubjectKey(e: VoiceEntryRow): SubjectKey {
  return e.builtin_subject ? `builtin:${e.builtin_subject}` : e.subject_id!;
}

export const ENTRY_COLUMNS =
  'id, builtin_subject, subject_id, language, title, source, script, personalised, voice, media_url, duration_ms, created_by, created_at';
