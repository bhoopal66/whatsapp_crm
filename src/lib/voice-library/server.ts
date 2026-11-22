/**
 * Server-only helpers for the voice-library routes: the workspace's TTS
 * key and storing audio in chat-media.
 *
 * Library audio (`account-<id>/voice-library/`) is written and removed
 * with the service role only: 242's RESTRICTIVE storage policies refuse
 * the folder to `authenticated`, because 023 would otherwise let any
 * member (viewers included) overwrite or delete it. Callers pass
 * `supabaseAdmin()` only AFTER their own role, author and active-account
 * checks. A personalised render goes under `staged/` with the caller's
 * own client, like any composer attachment.
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

/**
 * Best-effort removal with the service role; a leftover object is only
 * wasted space. Only for an object no message points at: the entries
 * POST's own just-stored audio, or through removeLibraryAudioIfUnused.
 */
export async function removeVoiceAudio(path: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin()
      .storage.from(CHAT_MEDIA_BUCKET)
      .remove([path]);
    if (error) console.error('[voice-library] remove failed:', error.message);
  } catch (err) {
    console.error('[voice-library] remove threw:', err);
  }
}

/**
 * After a library entry's row is deleted: remove its audio unless a
 * message of the account still points at it (a fixed entry is sent
 * with its library URL, which messages.media_url keeps). 242's
 * `voice_library_audio_in_use` compares on the URL path, as 155 does.
 * When the check cannot run the object is kept: a leftover is only
 * space, a removed one is a dead voice note in every chat it was sent.
 * Returns what happened, for the route's tests and logs.
 */
export async function removeLibraryAudioIfUnused(
  accountId: string,
  path: string
): Promise<'removed' | 'in_use' | 'kept'> {
  try {
    const admin = supabaseAdmin();
    const { data, error } = await admin.rpc('voice_library_audio_in_use', {
      p_account: accountId,
      p_path: path,
    });
    if (error || typeof data !== 'boolean') {
      console.error(
        '[voice-library] in-use check failed:',
        error?.message ?? 'no answer'
      );
      return 'kept';
    }
    if (data) return 'in_use';
    await removeVoiceAudio(path);
    return 'removed';
  } catch (err) {
    console.error('[voice-library] in-use check threw:', err);
    return 'kept';
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
