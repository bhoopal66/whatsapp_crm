/**
 * Removing chat-files objects with the service role (087): chat-files has
 * no DELETE policy, so a browser remove() would quietly delete nothing.
 * Used by POST /api/chat/messages/[id]/delete and by the cron's orphan
 * sweep. Never throws: the rows are gone by the time a path gets here,
 * so a path that cannot be removed is returned for the caller to log.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { chunked } from './admin-tools';
import { CHAT_FILES_BUCKET } from './uploads';

/** Storage removes take a bounded list. */
export const CHAT_FILE_BATCH = 100;

/** Removes `paths` in batches of 100, retrying a failed batch once. */
export async function removeChatFiles(
  admin: Pick<SupabaseClient, 'storage'>,
  paths: readonly string[]
): Promise<{ deleted: number; failed: string[] }> {
  const storage = admin.storage.from(CHAT_FILES_BUCKET);
  const failed: string[] = [];
  let deleted = 0;
  for (const batch of chunked(paths, CHAT_FILE_BATCH)) {
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
  return { deleted, failed };
}

/** At most this many orphans per sweep; the next run takes the rest. */
export const CHAT_ORPHAN_SWEEP_LIMIT = 500;

/**
 * One pass of the orphan sweep: chat_orphan_files() lists objects no live
 * message carries (older than its 24-hour upload window), and they are
 * removed. A failed listing throws; failed removes are returned.
 */
export async function runChatFileSweep(
  admin: Pick<SupabaseClient, 'rpc' | 'storage'>
): Promise<{ found: number; deleted: number; failed: string[] }> {
  const { data, error } = await admin.rpc('chat_orphan_files', {
    p_limit: CHAT_ORPHAN_SWEEP_LIMIT,
  });
  if (error) throw new Error(error.message);
  const names = (Array.isArray(data) ? data : []).filter(
    (n): n is string => typeof n === 'string' && n !== ''
  );
  if (names.length === 0) return { found: 0, deleted: 0, failed: [] };
  return { found: names.length, ...(await removeChatFiles(admin, names)) };
}
