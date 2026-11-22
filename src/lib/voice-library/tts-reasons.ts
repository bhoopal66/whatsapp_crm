/**
 * Why AI speech cannot be used in a workspace. Its own module so the
 * picker (a client component) can name the reason without importing the
 * server-only TTS client.
 */
export const TTS_UNAVAILABLE_REASONS = [
  'not_configured',
  'no_openai_key',
  'key_unreadable',
] as const;
export type TtsUnavailableReason = (typeof TTS_UNAVAILABLE_REASONS)[number];
