/**
 * OpenAI text-to-speech for the voice-note library. Server-only: it is
 * handed the workspace's decrypted key, which never reaches a browser.
 *
 * `response_format: 'opus'` returns Ogg/Opus, which WhatsApp plays as a
 * voice note on every provider, so the bytes are stored and sent as they
 * come back (no transcode).
 *
 * Every call goes through `assertAiTransfer` first (migration 224): the
 * script is text leaving for a provider abroad, and a personalised one
 * carries a customer's name and company.
 */
import {
  assertAiTransfer,
  type TransferCheck,
} from '@/lib/privacy/ai-transfer';
import { AiError, type AiConfig } from '@/lib/ai/types';

import {
  VOICE_LANGUAGE_NAMES,
  VOICE_MAX_BYTES,
  type TtsVoice,
  type VoiceLanguage,
} from './constants';
import type { TtsUnavailableReason } from './tts-reasons';

export type { TtsUnavailableReason } from './tts-reasons';

export const TTS_URL = 'https://api.openai.com/v1/audio/speech';
/** Takes `instructions`, so the language and tone can be asked for. */
export const TTS_MODEL = 'gpt-4o-mini-tts';
/** The `ai_transfer_log.purpose` of these calls. */
export const TTS_PURPOSE = 'voice_note_tts';
const TIMEOUT_MS = 45_000;

export type TtsKey =
  { ok: true; apiKey: string } | { ok: false; reason: TtsUnavailableReason };

/**
 * The OpenAI key speech uses: the assistant's own key when the workspace
 * runs on OpenAI, else its OpenAI embeddings key. An Anthropic-only
 * workspace has none. `config` null means no assistant set up or its
 * master switch off.
 */
export function resolveTtsKey(config: AiConfig | null): TtsKey {
  if (!config) return { ok: false, reason: 'not_configured' };
  if (config.provider === 'openai' && config.apiKey)
    return { ok: true, apiKey: config.apiKey };
  if (config.embeddingsApiKey)
    return { ok: true, apiKey: config.embeddingsApiKey };
  return { ok: false, reason: 'no_openai_key' };
}

export interface SpeakInput {
  accountId: string;
  apiKey: string;
  text: string;
  voice: TtsVoice;
  language: VoiceLanguage;
  fetchImpl?: typeof fetch;
  transferCheck?: TransferCheck;
}

/** Ogg/Opus bytes for `text`. Throws AiError with a code on failure. */
export async function synthesizeSpeech(input: SpeakInput): Promise<Uint8Array> {
  const { accountId, apiKey, text, voice, language } = input;
  await assertAiTransfer(
    { accountId, provider: 'openai' },
    TTS_PURPOSE,
    TTS_MODEL,
    text.length,
    input.transferCheck
  );

  const doFetch = input.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice,
        input: text,
        instructions: `Speak in ${VOICE_LANGUAGE_NAMES[language]}, clearly, warmly and at a natural pace, like a friendly customer-service agent leaving a WhatsApp voice note.`,
        response_format: 'opus',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new AiError('The speech service could not be reached.', {
      code: 'tts_unreachable',
      status: 502,
    });
  }

  if (!res.ok) {
    // Never echo the provider body: it can quote the request.
    const auth = res.status === 401 || res.status === 403;
    throw new AiError(
      auth
        ? 'The workspace OpenAI key was refused.'
        : res.status === 429
          ? 'The OpenAI key is over its limit. Try again in a minute.'
          : `The speech service answered ${res.status}.`,
      {
        code: auth ? 'tts_key_refused' : 'tts_failed',
        status: res.status === 429 ? 429 : 502,
      }
    );
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new AiError('The speech service returned no audio.', {
      code: 'tts_failed',
      status: 502,
    });
  }
  if (bytes.byteLength > VOICE_MAX_BYTES) {
    throw new AiError('The spoken note is too long.', {
      code: 'tts_too_long',
      status: 400,
    });
  }
  return bytes;
}
