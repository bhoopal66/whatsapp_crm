// Browser writes that say how many rows they changed.
//
// RLS filters an UPDATE or DELETE instead of refusing it: with no access
// any more, or the row already gone, the write changes 0 rows and
// PostgREST answers success. So these writes ask for the changed rows
// back (`.select('id')`) and callers treat `none` as "not saved". The
// filter on `id` already needs the SELECT policy, so asking for `id`
// back refuses nothing that worked before.

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';

export type RowWriter = Pick<SupabaseClient, 'from'>;

export type RowWrite =
  | { kind: 'changed'; ids: string[] }
  /** The write was accepted and changed nothing. */
  | { kind: 'none' }
  | { kind: 'failed'; error: PostgrestError };

/** Reads one write's answer, asked for with `.select('id')`. */
export function rowWrite(res: {
  data: unknown;
  error: PostgrestError | null;
}): RowWrite {
  if (res.error) return { kind: 'failed', error: res.error };
  const ids = (Array.isArray(res.data) ? res.data : []).map(
    (r: { id: string }) => r.id
  );
  return ids.length > 0 ? { kind: 'changed', ids } : { kind: 'none' };
}

export async function updateRow(
  sb: RowWriter,
  table: string,
  id: string,
  patch: Record<string, unknown>
): Promise<RowWrite> {
  return rowWrite(await sb.from(table).update(patch).eq('id', id).select('id'));
}

export async function deleteRows(
  sb: RowWriter,
  table: string,
  ids: string[]
): Promise<RowWrite> {
  return rowWrite(await sb.from(table).delete().in('id', ids).select('id'));
}

export type BulkAnswer =
  | { kind: 'all'; count: number }
  | { kind: 'some'; count: number; total: number }
  | { kind: 'none' };

/** How many of the rows asked for a bulk write really changed. */
export function bulkAnswer(asked: number, changed: number): BulkAnswer {
  if (changed === 0) return { kind: 'none' };
  return changed < asked
    ? { kind: 'some', count: changed, total: asked }
    : { kind: 'all', count: changed };
}
