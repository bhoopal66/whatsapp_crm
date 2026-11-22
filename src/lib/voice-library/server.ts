/**
 * Server-only helpers for the voice-library routes: the workspace's TTS
 * key and storing audio in chat-media. Storage writes go through the
 * caller's own client: 023's policies let a member write under their
 * `account-<id>` prefix, so no service role is needed for the bytes.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/ai/admin-client';
import { loadAiConfig } from '@/lib/ai/config';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { toPublicSupabaseUrl } from '@/lib/supabase/urls';

import { VOICE_CONTENT_TYPE } from './constants';
import { resolveTtsKey, type TtsKey } from './tts';

export const CHAT_MEDIA_BUCKET = 'chat-media';

/**
 * The OpenAI key speech may use, or why there is none. Read with the
 * service role (ai_configs is admin-only), like the translate route, and
 * with the assistant's master switch honoured.
 */
export async function loadTtsKey(accountId: string): Promise<TtsKey> {
  try {
    return resolveTtsKey(await loadAiConfig(supabaseAdmin(), accountId));
  } catch (err) {
    console.error(
      '[voice-library] AI config unreadable:',
      err instanceof Error ? err.message : 'unknown'
    );
    return { ok: false, reason: 'key_unreadable' };
  }
}

/** Upload Ogg/Opus bytes to `path` and return its public URL. */
export async function storeVoiceAudio(
  db: SupabaseClient,
  path: string,
  bytes: Uint8Array
): Promise<string> {
  const { error } = await db.storage
    .from(CHAT_MEDIA_BUCKET)
    .upload(path, bytes, { contentType: VOICE_CONTENT_TYPE, upsert: false });
  if (error) throw new Error(`upload failed: ${error.message}`);
  const {
    data: { publicUrl },
  } = db.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path);
  // Composed from the server's Supabase origin: rewrite to the one the
  // browser and the gateways reach.
  return toPublicSupabaseUrl(publicUrl);
}

/** Best-effort removal; a leftover object is only wasted space. */
export async function removeVoiceAudio(
  db: SupabaseClient,
  path: string
): Promise<void> {
  try {
    const { error } = await db.storage.from(CHAT_MEDIA_BUCKET).remove([path]);
    if (error) console.error('[voice-library] remove failed:', error.message);
  } catch (err) {
    console.error('[voice-library] remove threw:', err);
  }
}

/**
 * The per-user and per-account caps on AI speech (one shared BYO key),
 * checked right before a TTS call; a response when over, else null.
 */
export function voiceTtsLimited(userId: string, accountId: string) {
  const user = checkRateLimit(`voice-tts:${userId}`, RATE_LIMITS.voiceTts);
  if (!user.success) return rateLimitResponse(user);
  const acct = checkRateLimit(
    `voice-tts-acct:${accountId}`,
    RATE_LIMITS.voiceTtsAccount
  );
  if (!acct.success) return rateLimitResponse(acct);
  return null;
}
