/**
 * Reads a list that can pass PostgREST's 1,000-row cap, a page at a time.
 *
 * A bare `.select()` stops at the cap without saying so, so an unread
 * figure over 1,000 chats read as exactly 1,000. The caller builds one
 * page with `.order('id').range(from, to)` (a stable order, or pages
 * overlap and skip rows); a page shorter than the page size ends the read,
 * so the usual case stays one request. At most `MAX_PAGES` pages are read,
 * and `truncated` says the last one was full, i.e. there may be more.
 */
export const READ_PAGE_SIZE = 1000;
export const MAX_READ_PAGES = 5;

export interface ReadPagesResult<T> {
  rows: T[];
  truncated: boolean;
}

interface PageResult<T> {
  data: T[] | null;
  error: unknown;
}

export async function readPages<T>(
  readPage: (from: number, to: number) => PromiseLike<PageResult<T>>
): Promise<ReadPagesResult<T>> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_READ_PAGES; page++) {
    const from = page * READ_PAGE_SIZE;
    const { data, error } = await readPage(from, from + READ_PAGE_SIZE - 1);
    if (error || !data) throw error ?? new Error('no rows');
    rows.push(...data);
    if (data.length < READ_PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}
