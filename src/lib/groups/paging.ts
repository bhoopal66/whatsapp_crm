/** PostgREST answers at most this many rows at once. */
export const READ_PAGE = 1000;

/**
 * Read every row of a query that is capped per answer: `readPage(from,
 * to)` returns rows `from..to` (inclusive); stops at the first short page.
 */
export async function readAllPages<T>(
  readPage: (from: number, to: number) => Promise<T[]>,
  size: number = READ_PAGE
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += size) {
    const rows = await readPage(from, from + size - 1);
    out.push(...rows);
    if (rows.length < size) return out;
  }
}
