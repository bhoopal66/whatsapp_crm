/**
 * After privacy_subject_erase committed (migration 222): delete the
 * stored files whose rows it removed, bucket by bucket, and report what
 * is left so privacy_erase_objects_done can record it for a retry. Never
 * throws: a file that cannot be deleted stays in `remaining`.
 */
import { chatMediaObjectPath } from '@/lib/case-files/bytes';

import type { StoredObject } from './store';

export interface RemoveStorage {
  from(bucket: string): {
    remove(paths: string[]): Promise<{ error: unknown }>;
  };
}

const CASE_FILE_PATH = /^(cases|intake)\/[0-9a-f-]{36}\/[^/]+$/;

/**
 * The (bucket, path) of a stored object, or null for one that is not this
 * account's: a gateway link, or a path outside `account-<id>/` (262). The
 * SQL confines the list too; this is checked on its own because the remove
 * runs on the service role. Outside chat-media `<id>/` is accepted as well,
 * and case-files paths carry no account (`cases/<case id>/…`,
 * `intake/<item id>/…`): the SQL refuses another workspace's.
 */
export function objectPath(
  accountId: string,
  o: StoredObject
): { bucket: string; path: string } | null {
  const path = 'path' in o ? o.path : chatMediaObjectPath(o.url);
  if (!path || !accountId) return null;
  if (path.split('/').some((s) => s === '' || s === '.' || s === '..'))
    return null;
  const ours =
    path.startsWith(`account-${accountId}/`) ||
    (o.bucket !== 'chat-media' && path.startsWith(`${accountId}/`)) ||
    (o.bucket === 'case-files' && CASE_FILE_PATH.test(path));
  return ours ? { bucket: o.bucket, path } : null;
}

export async function deleteErasedObjects(
  storage: RemoveStorage,
  accountId: string,
  objects: readonly StoredObject[]
): Promise<{ deleted: number; remaining: StoredObject[]; skipped: number }> {
  const byBucket = new Map<
    string,
    { paths: string[]; items: StoredObject[] }
  >();
  let skipped = 0;
  for (const o of objects) {
    const p = objectPath(accountId, o);
    if (!p) {
      // Nothing of this account's to delete: never `remaining`, or it would
      // be retried for ever.
      skipped++;
      continue;
    }
    const g = byBucket.get(p.bucket) ?? { paths: [], items: [] };
    if (!g.paths.includes(p.path)) {
      g.paths.push(p.path);
      g.items.push(o);
    }
    byBucket.set(p.bucket, g);
  }
  const remaining: StoredObject[] = [];
  let deleted = 0;
  for (const [bucket, g] of byBucket) {
    for (let i = 0; i < g.paths.length; i += 100) {
      const paths = g.paths.slice(i, i + 100);
      try {
        const { error } = await storage.from(bucket).remove(paths);
        if (error) remaining.push(...g.items.slice(i, i + 100));
        else deleted += paths.length;
      } catch {
        remaining.push(...g.items.slice(i, i + 100));
      }
    }
  }
  return { deleted, remaining, skipped };
}

/** Requests per call: each one scans every table that may hold a path. */
const RETRY_PAGE = 5;

/**
 * The daily job's retry (262): erasures, and from 282 retention sweeps,
 * whose files are not recorded as deleted. The SQL leaves out a file used
 * again since. Takes page after page until `deadline`; a request that comes
 * back (its files still could not be deleted) waits for the next day. True
 * when the deadline left some untried. Never throws.
 */
export async function retryErasedObjects(
  db: RetryDb,
  deadline = Infinity,
  now: () => number = Date.now
): Promise<boolean> {
  const tried = new Set<number>();
  try {
    for (;;) {
      const { data, error } = await db.rpc('privacy_erase_objects_pending', {
        p_limit: RETRY_PAGE,
      });
      if (error) {
        console.error(
          `[privacy] erase files: list failed (${(error as { code?: string }).code ?? '-'})`
        );
        return false;
      }
      const page = (data as PendingErase[] | null) ?? [];
      const fresh = page.filter((row) => !tried.has(row.request_id));
      for (const row of fresh) {
        tried.add(row.request_id);
        const out = await deleteErasedObjects(
          db.storage,
          row.account_id,
          row.objects
        );
        const { error: e } = await db.rpc('privacy_erase_objects_settle', {
          p_request: row.request_id,
          p_remaining: out.remaining,
        });
        console.log(
          JSON.stringify({
            msg: 'privacy_erase_files',
            account: row.account_id,
            request: row.request_id,
            deleted: out.deleted,
            skipped: out.skipped,
            remaining: out.remaining.length,
            recorded: !e,
          })
        );
      }
      // Oldest first, and a retried one goes to the back: a page with a
      // request seen before has nothing new behind it.
      if (page.length < RETRY_PAGE || fresh.length < page.length) return false;
      if (now() >= deadline) return true;
    }
  } catch {
    console.error('[privacy] erase files: retry failed');
    return false;
  }
}

interface PendingErase {
  account_id: string;
  request_id: number;
  objects: StoredObject[];
}

export interface RetryDb {
  storage: RemoveStorage;
  rpc(
    fn: string,
    args?: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: unknown }>;
}
