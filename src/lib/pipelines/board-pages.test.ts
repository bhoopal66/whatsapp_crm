import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBoardDeals } from './board-pages';

const deals = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `d${i}` }));

/** A table that never answers more than `cap` rows at once. */
function table(n: number, cap = 1000) {
  const calls: number[] = [];
  const all = deals(n);
  return {
    calls,
    fetchPage: async (from: number, to: number) => {
      calls.push(from);
      return {
        data: all.slice(from, Math.min(to + 1, from + cap)),
        error: null,
        count: n,
      };
    },
  };
}

describe('loadBoardDeals', () => {
  it('reads past 1,000 deals, also under a lower cap', async () => {
    const big = table(2500);
    expect(await loadBoardDeals(big.fetchPage)).toEqual(deals(2500));
    expect(big.calls).toEqual([0, 1000, 2000]);
    expect(await loadBoardDeals(table(1200, 500).fetchPage)).toHaveLength(1200);
  });

  it('costs one read when everything fits', async () => {
    const small = table(40);
    await loadBoardDeals(small.fetchPage);
    expect(small.calls).toEqual([0]);
  });

  it('throws when a later page fails', async () => {
    const { fetchPage } = table(2500);
    await expect(
      loadBoardDeals(async (from, to) =>
        from === 0
          ? fetchPage(from, to)
          : { data: null, error: { message: 'timeout' } }
      )
    ).rejects.toThrow('timeout');
  });

  it('keeps a deal once when two pages carry it', async () => {
    const pages = [deals(2), [{ id: 'd1' }, { id: 'd2' }]];
    expect(
      await loadBoardDeals(async () => ({
        data: pages.shift() ?? [],
        error: null,
      }))
    ).toEqual(deals(3));
  });
});

describe('the pipelines page', () => {
  const page = readFileSync(
    join(process.cwd(), 'src/app/(dashboard)/pipelines/page.tsx'),
    'utf8'
  );

  it('reads the board in pages, in a total order', () => {
    expect(page).toContain('loadBoardDeals<BoardDeal>');
    expect(page).toContain(".order('id', { ascending: false })");
    expect(page).toContain('.range(from, to)');
  });

  it('shows an error with Retry instead of an empty board', () => {
    expect(page).toContain('dealsQuery.error && !dealsQuery.data');
    expect(page).toContain("t('retry')");
  });
});
