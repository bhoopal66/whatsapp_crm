import { describe, it, expect } from 'vitest';
import {
  rankRecall,
  recencyFactor,
  estimateTokens,
  type RankRow,
  type RankOptions,
} from './rank';

const NOW = new Date('2026-10-01T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const row = (id: string, over: Partial<RankRow> = {}): RankRow => ({
  id,
  content: `distinct content for ${id}`,
  importance: 3,
  trust: 'verified',
  createdAt: NOW,
  lastRecalledAt: null,
  rank: 1,
  ...over,
});
const opts = (over: Partial<RankOptions> = {}): RankOptions => ({
  now: NOW,
  limit: 20,
  tokenBudget: 10_000,
  ...over,
});
const ids = (rows: readonly RankRow[], o: Partial<RankOptions> = {}) =>
  rankRecall(rows, opts(o)).map((r) => r.item.id);

describe('019b rank ordering', () => {
  it('orders by normalised FTS rank, then importance', () => {
    expect(
      ids([
        row('a', { rank: 0.1 }),
        row('b', { rank: 0.4 }),
        row('c', { rank: 0.2 }),
      ])
    ).toEqual(['b', 'c', 'a']);
    // importance 5 (x1.4) beats a 30% better FTS rank at importance 3
    expect(
      ids([row('a', { rank: 1 }), row('b', { rank: 0.75, importance: 5 })])
    ).toEqual(['b', 'a']);
    const [top] = rankRecall(
      [row('a', { rank: 0.5 }), row('b', { rank: 0.25 })],
      opts()
    );
    expect(top!.score).toBeCloseTo(1, 10); // max-normalised fts, importance 3, fresh, verified
  });

  it('fuses cosine (0.6 / 0.4) only when both embeddings are present', () => {
    const q = [1, 0];
    const rows = [
      row('a', { rank: 1, embedding: [0, 1] }),
      row('b', { rank: 0.9, embedding: [1, 0] }),
      row('c', { rank: 0.85 }),
    ];
    const r = rankRecall(rows, opts({ queryEmbedding: q }));
    expect(r.map((x) => x.item.id)).toEqual(['b', 'c', 'a']);
    expect(r.find((x) => x.item.id === 'b')!.score).toBeCloseTo(
      0.6 * 0.9 + 0.4 * 1,
      10
    );
    expect(r.find((x) => x.item.id === 'c')!.score).toBeCloseTo(0.85, 10); // FTS only: no row embedding
    expect(r.find((x) => x.item.id === 'a')!.score).toBeCloseTo(0.6, 10); // orthogonal
    // no query embedding: FTS only for all
    expect(ids(rows)).toEqual(['a', 'b', 'c']);
    // custom weights
    expect(
      rankRecall(
        [
          row('b', { rank: 1, embedding: [1, 0] }),
          row('z', { rank: 1, embedding: [0, 1] }),
        ],
        opts({ queryEmbedding: q, weights: { fts: 1, cosine: 1 } })
      )[1]!.score
    ).toBeCloseTo(0.5, 10);
  });

  it('recall without a query (all ranks 0) is ordered by importance, recency and trust', () => {
    expect(
      ids([
        row('a', { rank: 0 }),
        row('b', { rank: 0, importance: 4 }),
        row('c', { rank: 0, createdAt: daysAgo(90) }),
      ])
    ).toEqual(['b', 'a', 'c']);
  });
});

describe('019b rank trust penalty', () => {
  it('an untrusted item scores 0.7 x the same verified item and ranks below it', () => {
    const r = rankRecall(
      [row('a-untrusted', { trust: 'untrusted' }), row('b-verified')],
      opts()
    );
    expect(r.map((x) => x.item.id)).toEqual(['b-verified', 'a-untrusted']);
    expect(r[1]!.score / r[0]!.score).toBeCloseTo(0.7, 10);
  });
});

describe('019b rank recency decay', () => {
  it('halves at 90 days, floors at 0.3, uses lastRecalledAt over createdAt', () => {
    expect(recencyFactor({ createdAt: daysAgo(90) }, NOW)).toBeCloseTo(0.5, 10);
    expect(recencyFactor({ createdAt: daysAgo(3650) }, NOW)).toBe(0.3);
    expect(
      recencyFactor(
        { createdAt: daysAgo(400), lastRecalledAt: daysAgo(0) },
        NOW
      )
    ).toBe(1);
    const r = rankRecall(
      [
        row('a-old', { createdAt: daysAgo(90) }),
        row('b-new', { createdAt: daysAgo(1) }),
      ],
      opts()
    );
    expect(r.map((x) => x.item.id)).toEqual(['b-new', 'a-old']);
    expect(r[1]!.score).toBeCloseTo(0.5, 10);
    // a very old row is floored, not zeroed
    expect(
      rankRecall([row('x', { createdAt: daysAgo(5000) })], opts())[0]!.score
    ).toBeCloseTo(0.3, 10);
  });
});

describe('019b rank near-duplicate suppression', () => {
  it('same normalised first 80 chars: the higher score is kept', () => {
    const head =
      'The bank agreed a 7.5% rate on the working capital facility for the Garhoud case, ';
    const r = rankRecall(
      [
        row('a', { content: head + 'confirmed by email', rank: 0.5 }),
        row('b', {
          content:
            '  ' +
            head.toUpperCase().replace(/ /g, '  ') +
            'and later by phone',
          rank: 0.9,
        }),
        row('c', { rank: 0.1 }),
      ],
      opts()
    );
    expect(r.map((x) => x.item.id)).toEqual(['b', 'c']);
  });

  it('token Jaccard >= 0.9 is a duplicate, below is not', () => {
    const words = Array.from({ length: 20 }, (_, i) => `w${i}`);
    const base = words.join(' ');
    const near = [...words.slice(0, 19), 'w19', 'extra'].reverse().join(' '); // 20/21 = 0.952
    const far = [...words.slice(0, 17), 'x1', 'x2', 'x3'].reverse().join(' '); // 17/23 = 0.739
    expect(
      ids([
        row('a', { content: base, rank: 1 }),
        row('b', { content: near, rank: 0.5 }),
      ])
    ).toEqual(['a']);
    expect(
      ids([
        row('a', { content: base, rank: 0.5 }),
        row('b', { content: near, rank: 1 }),
      ])
    ).toEqual(['b']);
    expect(
      ids([
        row('a', { content: base, rank: 1 }),
        row('b', { content: far, rank: 0.5 }),
      ])
    ).toEqual(['a', 'b']);
  });
});

describe('019b rank token budget and limit', () => {
  it('stops at the first item that would exceed the budget, never cutting one; respects limit', () => {
    const c = (n: number) => 'x'.repeat(n);
    const rows = [
      row('a', { content: c(40), rank: 1 }),
      row('b', { content: 'y'.repeat(41), rank: 0.9 }),
      row('c', { content: 'z'.repeat(4), rank: 0.8 }),
    ];
    expect(estimateTokens('y'.repeat(41))).toBe(11);
    expect(ids(rows, { tokenBudget: 21 })).toEqual(['a', 'b']); // 10 + 11
    expect(ids(rows, { tokenBudget: 20 })).toEqual(['a']); // b does not fit: stop (c is not added after it)
    expect(ids(rows, { tokenBudget: 9 })).toEqual([]);
    expect(ids(rows, { limit: 2 })).toEqual(['a', 'b']);
    expect(ids(rows, { limit: 0 })).toEqual([]);
    for (const r of rankRecall(rows, opts({ tokenBudget: 21 })))
      expect(r.item.content).toBe(
        rows.find((x) => x.id === r.item.id)!.content
      );
  });
});

describe('019b rank determinism', () => {
  it('equal scores tie-break by id and any input order gives the same output', () => {
    const rows = ['m', 'c', 'x', 'a', 'q'].map((id) => row(id));
    expect(ids(rows)).toEqual(['a', 'c', 'm', 'q', 'x']);
    const mixed = [
      row('k', { rank: 0.3, trust: 'untrusted' }),
      row('e', { rank: 0.9, createdAt: daysAgo(30) }),
      ...rows,
      row('d', { rank: 0.5, importance: 1 }),
    ];
    const want = ids(mixed);
    let seed = 7;
    for (let n = 0; n < 25; n++) {
      const shuffled = [...mixed].sort(
        () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5
      );
      expect(ids(shuffled)).toEqual(want);
    }
  });
});
