/**
 * Sweeping composer attachments that were never sent. The composer uploads
 * to chat-media the moment a file is attached (under
 * `account-<id>/staged/`), so an attachment that is never sent (tab closed,
 * draft abandoned, a parked draft never restored) stays in the bucket. A
 * browser remove() on tab close cannot be trusted to run, so the server
 * cleans up instead: chat_media_staged_orphans() (migration 155) lists
 * staged objects older than the minimum age that no message, template or
 * broadcast header references. The age (STAGED_MEDIA_MAX_AGE_DAYS) was 7
 * days, which a long-lived tab outlived: a parked draft, an attachment left
 * in an open composer or a failed send kept for Retry pointed at a deleted
 * file. It is now 30 days, and the client stops using a staged attachment
 * a day before that (isExpiredStagedMedia). Removal goes through the
 * Storage API with the service role, never by deleting storage.objects
 * rows. Never throws on a failed remove; a failed listing throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { STAGED_MEDIA_MAX_AGE_DAYS } from './staged-media';

// message-composer.tsx owns the same constant but is a client component.
const CHAT_MEDIA_BUCKET = 'chat-media';

/** Staged objects younger than this are left alone (SQL refuses < 1 day). */
export const STAGED_MEDIA_MIN_AGE = `${STAGED_MEDIA_MAX_AGE_DAYS} days`;

/** At most this many per sweep; the next run takes the rest. */
export const STAGED_MEDIA_SWEEP_LIMIT = 500;

/** Storage removes take a bounded list. */
const REMOVE_BATCH = 100;

export async function runStagedMediaSweep(
  admin: Pick<SupabaseClient, 'rpc' | 'storage'>
): Promise<{ found: number; deleted: number; failed: string[] }> {
  const { data, error } = await admin.rpc('chat_media_staged_orphans', {
    p_min_age: STAGED_MEDIA_MIN_AGE,
    p_limit: STAGED_MEDIA_SWEEP_LIMIT,
  });
  if (error) throw new Error(error.message);
  const names = (Array.isArray(data) ? data : []).filter(
    (n): n is string => typeof n === 'string' && n !== ''
  );
  if (names.length === 0) return { found: 0, deleted: 0, failed: [] };

  const storage = admin.storage.from(CHAT_MEDIA_BUCKET);
  const failed: string[] = [];
  let deleted = 0;
  for (let i = 0; i < names.length; i += REMOVE_BATCH) {
    const batch = names.slice(i, i + REMOVE_BATCH);
    try {
      // One retry: a storage blip should not leave files behind.
      let result = await storage.remove(batch);
      if (result.error) result = await storage.remove(batch);
      if (result.error) failed.push(...batch);
      else deleted += result.data?.length ?? 0;
    } catch {
      failed.push(...batch);
    }
  }
  return { found: names.length, deleted, failed };
}
