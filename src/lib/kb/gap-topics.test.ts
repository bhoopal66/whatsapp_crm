import { describe, expect, it } from 'vitest';
import {
  CARRY_OVER_MIN_OVERLAP,
  COSINE_THRESHOLD,
  GAP_WINDOW_DAYS,
  JACCARD_THRESHOLD,
  MAX_GAPS_PER_RUN,
  REOPEN_AFTER_NEW_QUESTIONS,
  capGaps,
  carryOverStatus,
  clusterGaps,
  clusterMode,
  cosine,
  jaccard,
  normaliseTokens,
  type GapRow,
} from './gap-topics';

const at = (day: number, hour = 0) =>
  new Date(Date.UTC(2026, 9, day, hour)).toISOString();
const row = (
  id: string,
  question: string,
  day: number,
  embedding?: number[]
): GapRow => ({
  id,
  question,
  createdAt: at(day),
  embedding,
});

describe('thresholds', () => {
  it('are the documented values', () => {
    expect(COSINE_THRESHOLD).toBe(0.82);
    expect(JACCARD_THRESHOLD).toBe(0.5);
    expect(CARRY_OVER_MIN_OVERLAP).toBe(0.5);
    expect(REOPEN_AFTER_NEW_QUESTIONS).toBe(5);
    expect(GAP_WINDOW_DAYS).toBe(30);
    expect(MAX_GAPS_PER_RUN).toBe(1000);
  });
});

describe('normaliseTokens', () => {
  it('lowercases, drops punctuation, stop words and one-letter tokens', () => {
    expect([...normaliseTokens('Can I get a POS machine?!')]).toEqual([
      'pos',
      'machine',
    ]);
  });
  it('keeps Arabic letters and strips diacritics and tatweel', () => {
    const a = normaliseTokens('هل يمكنني فتح حسابٌ تجاري؟');
    const b = normaliseTokens('فتح حســاب تجاري');
    expect([...b]).toEqual(['فتح', 'حساب', 'تجاري']);
    expect(jaccard(a, b)).toBeGreaterThanOrEqual(0.75);
  });
});

describe('similarity', () => {
  it('jaccard of empty sets is 0', () => {
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
  });
  it('cosine of mismatched or zero vectors is 0', () => {
    expect(cosine([1, 0], [1])).toBe(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
    expect(cosine([1, 1], [2, 2])).toBeCloseTo(1);
  });
});

describe('capGaps', () => {
  it('keeps the last 30 days, newest first, at most 1000', () => {
    const now = new Date(at(31, 12));
    const rows = [row('old', 'q', 1), row('a', 'q', 10), row('b', 'q', 20)];
    expect(capGaps(rows, now).map((r) => r.id)).toEqual(['b', 'a']);
    const many = Array.from({ length: 1005 }, (_, i) => row(`r${i}`, 'q', 25));
    expect(capGaps(many, now)).toHaveLength(1000);
  });
});

describe('clusterGaps (lexical)', () => {
  const rows = [
    row('p1', 'Can I get a POS machine without a trade licence?', 3),
    row('p2', 'POS machine without trade licence possible?', 5),
    row('p3', 'pos machine without a trade licence', 4),
    row('l1', 'What is the interest rate on a business loan?', 6),
    row('l2', 'business loan interest rate?', 2),
    row('x1', 'Do you work on Fridays?', 1),
  ];

  it('groups near-identical questions and sorts by size then recency', () => {
    const topics = clusterGaps(rows);
    expect(clusterMode(rows)).toBe('lexical');
    expect(topics.map((t) => [...t.memberIds].sort())).toEqual([
      ['p1', 'p2', 'p3'],
      ['l1', 'l2'],
      ['x1'],
    ]);
    const pos = topics[0]!;
    expect(pos.count).toBe(3);
    expect(pos.memberIds).toEqual(['p2', 'p3', 'p1']); // newest first
    expect(pos.lastSeenAt).toBe(at(5));
    expect(pos.firstSeenAt).toBe(at(3));
    // the medoid is the member closest to all the others
    expect(pos.label).toBe('pos machine without a trade licence');
  });

  it('is deterministic whatever the input order', () => {
    const a = clusterGaps(rows);
    const b = clusterGaps([...rows].reverse());
    expect(b).toEqual(a);
  });

  it('ties on size break on the most recently seen topic', () => {
    const topics = clusterGaps([
      row('a', 'opening hours', 1),
      row('b', 'card machine fees', 9),
    ]);
    expect(topics.map((t) => t.memberIds[0])).toEqual(['b', 'a']);
  });
});

describe('clusterGaps (embeddings)', () => {
  it('uses cosine when every row has an embedding', () => {
    const rows = [
      // lexically unrelated, semantically one topic
      row('e1', 'POS without licence?', 3, [1, 0.1, 0]),
      row('e2', 'card terminal, no trade permit', 4, [0.95, 0.15, 0]),
      row('e3', 'opening hours', 5, [0, 0, 1]),
    ];
    expect(clusterMode(rows)).toBe('embedding');
    expect(clusterGaps(rows).map((t) => [...t.memberIds].sort())).toEqual([
      ['e1', 'e2'],
      ['e3'],
    ]);
  });

  it('falls back to lexical when any row lacks an embedding', () => {
    const rows = [
      row('e1', 'POS without licence?', 3, [1, 0]),
      row('e2', 'card terminal, no trade permit', 4),
    ];
    expect(clusterMode(rows)).toBe('lexical');
    expect(clusterGaps(rows)).toHaveLength(2);
  });
});

describe('carryOverStatus', () => {
  const dismissedAt = at(10);
  const createdAt = new Map<string, string>([
    ['a', at(1)],
    ['b', at(2)],
    ['c', at(3)],
    ['d', at(4)],
    ...Array.from(
      { length: 6 },
      (_, i) => [`n${i}`, at(11 + i)] as [string, string]
    ),
  ]);
  const prev = [
    {
      memberIds: ['a', 'b', 'c', 'd'],
      status: 'dismissed' as const,
      dismissedAt,
    },
  ];

  it('keeps a dismissal when half the dismissed questions are in the new topic', () => {
    expect(
      carryOverStatus({ memberIds: ['a', 'b', 'n0', 'n1'] }, createdAt, prev)
    ).toEqual({ status: 'dismissed', dismissedAt });
  });

  it('does not match below 50% overlap', () => {
    expect(
      carryOverStatus({ memberIds: ['a', 'n0'] }, createdAt, prev)
    ).toEqual({ status: 'open', dismissedAt: null });
  });

  it('reopens once five questions arrived after the dismissal', () => {
    const four = ['a', 'b', 'c', 'n0', 'n1', 'n2', 'n3'];
    expect(carryOverStatus({ memberIds: four }, createdAt, prev).status).toBe(
      'dismissed'
    );
    expect(
      carryOverStatus({ memberIds: [...four, 'n4'] }, createdAt, prev)
    ).toEqual({ status: 'open', dismissedAt: null });
  });

  it('ignores open previous topics', () => {
    expect(
      carryOverStatus({ memberIds: ['a', 'b'] }, createdAt, [
        { memberIds: ['a', 'b'], status: 'open', dismissedAt: null },
      ]).status
    ).toBe('open');
  });
});
