import { describe, expect, it } from 'vitest';

import { readAllPages } from './paging';

const source = (n: number) => {
  const all = Array.from({ length: n }, (_, i) => i);
  const calls: Array<[number, number]> = [];
  return {
    calls,
    read: async (from: number, to: number) => {
      calls.push([from, to]);
      return all.slice(from, to + 1);
    },
  };
};

describe('readAllPages', () => {
  it('reads past the first page', async () => {
    const s = source(2500);
    const rows = await readAllPages(s.read, 1000);
    expect(rows).toHaveLength(2500);
    expect(s.calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('asks once more when the last page is exactly full', async () => {
    const s = source(2000);
    expect(await readAllPages(s.read, 1000)).toHaveLength(2000);
    expect(s.calls).toHaveLength(3);
  });

  it('stops after one short page', async () => {
    const s = source(3);
    expect(await readAllPages(s.read, 1000)).toEqual([0, 1, 2]);
    expect(s.calls).toHaveLength(1);
  });
});
