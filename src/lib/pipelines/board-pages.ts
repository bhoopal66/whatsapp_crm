import { readAllPages } from '@/lib/contacts/chat-tag-column';

/** PostgREST's usual cap on one answer. */
export const BOARD_PAGE_SIZE = 1000;

export interface DealPage<T> {
  data: T[] | null;
  error: { message: string } | null;
  /** The exact total, when the read asked for it. */
  count?: number | null;
}

/**
 * Every deal of a board. One read answered only the first 1,000 and the
 * board drew them as the whole pipeline. The total that comes with a
 * page ends the reading, so a board that fits in one page still costs
 * one round trip. Any failed page throws: part of a board is never an
 * answer. A deal added meanwhile can push another onto the next page,
 * so a repeated id is kept once.
 */
export async function loadBoardDeals<T extends { id: string }>(
  fetchPage: (from: number, to: number) => PromiseLike<DealPage<T>>
): Promise<T[]> {
  let total: number | null = null;
  const all = await readAllPages<T>(async (from, to) => {
    if (total !== null && from >= total) return { data: [], error: null };
    const page = await fetchPage(from, to);
    if (typeof page.count === 'number') total = page.count;
    return page;
  }, BOARD_PAGE_SIZE);
  // Throw rather than answer [] so a failed refresh keeps the board the
  // session cache already holds instead of emptying it.
  if (all.error) throw new Error(all.error.message);
  return [...new Map(all.data.map((deal) => [deal.id, deal])).values()];
}
