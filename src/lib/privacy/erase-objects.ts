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

/** The (bucket, path) of a stored object, or null for a URL that is not ours. */
export function objectPath(
  o: StoredObject
): { bucket: string; path: string } | null {
  if ('path' in o) return o.path ? { bucket: o.bucket, path: o.path } : null;
  const path = chatMediaObjectPath(o.url);
  return path ? { bucket: 'chat-media', path } : null;
}

export async function deleteErasedObjects(
  storage: RemoveStorage,
  objects: readonly StoredObject[]
): Promise<{ deleted: number; remaining: StoredObject[]; skipped: number }> {
  const byBucket = new Map<
    string,
    { paths: string[]; items: StoredObject[] }
  >();
  let skipped = 0;
  for (const o of objects) {
    const p = objectPath(o);
    if (!p) {
      // A URL outside our chat-media bucket (a gateway link): nothing of ours to delete.
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
