/**
 * The voice-note library's fixed lists (migration 242). Dependency-free:
 * the picker (a client component), the routes and the tests all import
 * it. `constants.test.ts` reads 242 and fails when these drift from its
 * CHECKs: change both together.
 */

/** The four built-in subjects every workspace has. */
export const VOICE_BUILTIN_SUBJECTS = [
  'welcome',
  'documents_required',
  'missing_documents',
  'status_update',
] as const;
export type VoiceBuiltinSubject = (typeof VOICE_BUILTIN_SUBJECTS)[number];

/** The fixed language list: English, Hindi, Arabic, Urdu. */
export const VOICE_LANGUAGES = ['en', 'hi', 'ar', 'ur'] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

/** English names, used in the TTS instructions (not shown to staff). */
export const VOICE_LANGUAGE_NAMES: Record<VoiceLanguage, string> = {
  en: 'English',
  hi: 'Hindi',
  ar: 'Arabic',
  ur: 'Urdu',
};

/** Right-to-left scripts, for the script box's direction. */
export const RTL_LANGUAGES: readonly VoiceLanguage[] = ['ar', 'ur'];

export const VOICE_SOURCES = ['recording', 'tts'] as const;
export type VoiceSource = (typeof VOICE_SOURCES)[number];

/** OpenAI TTS voices offered (each works on gpt-4o-mini-tts and tts-1). */
export const TTS_VOICES = [
  'alloy',
  'coral',
  'echo',
  'nova',
  'onyx',
  'sage',
  'shimmer',
] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];
export const DEFAULT_TTS_VOICE: TtsVoice = 'coral';

/** Limits, equal to 242's CHECKs. */
export const SUBJECT_LABEL_MAX = 60;
export const ENTRY_TITLE_MAX = 80;
export const SCRIPT_MAX = 1500;

/** One voice note, 16 MB (the chat-media bucket and Meta's audio cap). */
export const VOICE_MAX_BYTES = 16 * 1024 * 1024;

/** Subfolder of `account-<id>` in chat-media that holds library audio. */
export const VOICE_LIBRARY_SUBFOLDER = 'voice-library';

/**
 * Content type the audio is stored and sent as: Ogg/Opus, which WhatsApp
 * plays as a voice note on Whapi, OpenWA and the Cloud API (Meta accepts
 * audio/ogg with the opus codec only). The bucket's allow-list (023)
 * names `audio/ogg` bare, so no codecs parameter, as the composer's own
 * recorder uploads it.
 */
export const VOICE_CONTENT_TYPE = 'audio/ogg';

export function isVoiceLanguage(value: unknown): value is VoiceLanguage {
  return (
    typeof value === 'string' &&
    (VOICE_LANGUAGES as readonly string[]).includes(value)
  );
}

export function isBuiltinSubject(value: unknown): value is VoiceBuiltinSubject {
  return (
    typeof value === 'string' &&
    (VOICE_BUILTIN_SUBJECTS as readonly string[]).includes(value)
  );
}

export function isTtsVoice(value: unknown): value is TtsVoice {
  return (
    typeof value === 'string' &&
    (TTS_VOICES as readonly string[]).includes(value)
  );
}

/** `account-<id>/voice-library/<entry id>.ogg`, 242's path CHECK. */
export function voiceLibraryPath(accountId: string, entryId: string): string {
  return `account-${accountId}/${VOICE_LIBRARY_SUBFOLDER}/${entryId}.ogg`;
}
