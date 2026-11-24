import { mapRecycleRow } from './rows';
import type { RecycleRow, RecycleRpcRow } from './types';

export interface RecyclePageArgs {
  /** 0-based. */
  page: number;
  pageSize: number;
  days: number | null;
  search: string | null;
}

export type RecyclePageAnswer =
  | { kind: 'rows'; rows: RecycleRow[]; total: number }
  /** The list no longer reaches this page: go back to the first. */
  | { kind: 'past_end' }
  | { kind: 'failed' }
  /** A later read was asked for meanwhile: not to be shown. */
  | { kind: 'stale' };

interface RecycleRpcArgs {
  p_days: number | null;
  p_limit: number;
  p_offset: number;
  p_search: string | null;
}

/**
 * Reads pages of the recycle list; only the answer to the last read
 * asked for counts. The total travels on the rows, so an empty page
 * above the first says nothing about it.
 */
export function recyclePager(
  read: (args: RecycleRpcArgs) => PromiseLike<{ data: unknown; error: unknown }>
): (args: RecyclePageArgs) => Promise<RecyclePageAnswer> {
  let latest = 0;
  return async ({ page, pageSize, days, search }) => {
    const mine = ++latest;
    const { data, error } = await read({
      p_days: days,
      p_limit: pageSize,
      p_offset: page * pageSize,
      p_search: search,
    });
    if (mine !== latest) return { kind: 'stale' };
    if (error) return { kind: 'failed' };
    const rows = ((data ?? []) as RecycleRpcRow[]).map(mapRecycleRow);
    if (rows.length === 0 && page > 0) return { kind: 'past_end' };
    return { kind: 'rows', rows, total: rows[0]?.total ?? 0 };
  };
}
