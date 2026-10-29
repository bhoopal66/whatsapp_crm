import { describe, expect, it, vi } from 'vitest';

import { REPLY_CLASS_NAMES } from '@/lib/typesafe/questions/reply-class';
import en from '../../../messages/en.json';
import {
  REPLY_CLASS_LABEL_KEY,
  REPLY_CLASS_ORDER,
  REPLY_CLASS_TONE,
  buildReplySegments,
  formatSegmentPercent,
  isReplyClass,
  matchesReplyClassFilter,
  replySortAction,
  sortPastReplies,
} from './reply-class-view';

describe('REPLY_CLASS_ORDER', () => {
  it('equals the Jev question’s classes, in 148’s order', () => {
    expect([...REPLY_CLASS_ORDER]).toEqual(REPLY_CLASS_NAMES);
  });

  it('has a label in the ReplyClasses namespace and a tone for every class', () => {
    const ns = (en as Record<string, Record<string, unknown>>).ReplyClasses;
    for (const cls of REPLY_CLASS_ORDER) {
      expect(typeof ns[REPLY_CLASS_LABEL_KEY[cls]]).toBe('string');
      expect(REPLY_CLASS_TONE[cls].bar).toMatch(/dark:bg-/);
    }
  });

  it('gives every class its own bar colour', () => {
    const bars = REPLY_CLASS_ORDER.map((c) => REPLY_CLASS_TONE[c].bar);
    expect(new Set(bars).size).toBe(bars.length);
  });
});

describe('isReplyClass', () => {
  it('accepts the seven classes only', () => {
    expect(isReplyClass('not_now')).toBe(true);
    expect(isReplyClass('maybe')).toBe(false);
    expect(isReplyClass(null)).toBe(false);
  });
});

describe('buildReplySegments', () => {
  const sum = (xs: { percent: number }[]) =>
    xs.reduce((s, x) => s + x.percent, 0);

  it('keeps only classes with replies, in display order', () => {
    const segs = buildReplySegments({
      other: 1,
      interested: 2,
      stop: 0,
      question: 1,
    });
    expect(segs.map((s) => s.cls)).toEqual(['interested', 'question', 'other']);
  });

  it('rounds by largest remainder so percents sum to 100', () => {
    // 1/3 each: 33.33… → 34/33/33, the first class takes the spare point.
    const thirds = buildReplySegments({ interested: 1, question: 1, other: 1 });
    expect(thirds.map((s) => s.percent)).toEqual([34, 33, 33]);
    expect(sum(thirds)).toBe(100);

    // 12/39 = 30.77, 20/39 = 51.28, 7/39 = 17.95 → 31 / 51 / 18.
    const mixed = buildReplySegments({ interested: 12, question: 20, stop: 7 });
    expect(mixed.map((s) => s.percent)).toEqual([31, 51, 18]);
    expect(sum(mixed)).toBe(100);
  });

  it('sums to 100 where naive rounding would not', () => {
    // Seven equal classes: 14.29 each, naive rounding gives 98.
    const counts = Object.fromEntries(REPLY_CLASS_ORDER.map((c) => [c, 1]));
    const segs = buildReplySegments(counts);
    expect(segs.reduce((s, x) => s + Math.round(x.share), 0)).toBe(98);
    expect(sum(segs)).toBe(100);
    expect(segs.map((s) => s.percent)).toEqual([15, 15, 14, 14, 14, 14, 14]);
  });

  it('keeps exact shares for the bar widths', () => {
    const [a, b] = buildReplySegments({ interested: 1, other: 3 });
    expect(a.share).toBe(25);
    expect(b.share).toBe(75);
  });

  it('returns nothing for no replies and ignores junk', () => {
    expect(buildReplySegments({})).toEqual([]);
    expect(buildReplySegments(null)).toEqual([]);
    expect(
      buildReplySegments({ interested: -2, question: NaN, bogus: 9 })
    ).toEqual([]);
  });

  it('formats a tiny share as <1%', () => {
    const segs = buildReplySegments({ interested: 999, stop: 1 });
    expect(segs.map(formatSegmentPercent)).toEqual(['100%', '<1%']);
  });
});

describe('matchesReplyClassFilter', () => {
  it('passes everything with no filter, else only that class', () => {
    expect(matchesReplyClassFilter({ reply_class: null }, null)).toBe(true);
    expect(matchesReplyClassFilter({}, 'stop')).toBe(false);
    expect(matchesReplyClassFilter({ reply_class: 'stop' }, 'stop')).toBe(true);
    expect(matchesReplyClassFilter({ reply_class: 'other' }, 'stop')).toBe(
      false
    );
  });
});

describe('replySortAction', () => {
  it('offers the backfill only when on, available and something is unsorted', () => {
    const base = { enabled: true, available: true, unclassifiedReplies: 3 };
    expect(replySortAction(base)).toBe('sort');
    expect(replySortAction({ ...base, unclassifiedReplies: 0 })).toBeNull();
    expect(replySortAction({ ...base, available: false })).toBe('unavailable');
    expect(replySortAction({ ...base, enabled: false })).toBe('turn_on');
    expect(
      replySortAction({
        enabled: false,
        available: false,
        unclassifiedReplies: 0,
      })
    ).toBe('turn_on');
  });
});

describe('sortPastReplies', () => {
  it('follows the cursor until it is null, through calls that sort nothing', async () => {
    const calls = [
      { classified: 0, nextCursor: 'r500' },
      { classified: 100, nextCursor: 'r1000' },
      { classified: 0, nextCursor: 'r1500' },
      { classified: 3, nextCursor: null },
    ];
    const once = vi.fn<
      (after: string | null) => Promise<(typeof calls)[number]>
    >(async () => calls.shift()!);
    const progress = vi.fn();
    await expect(sortPastReplies(once, progress)).resolves.toBe(103);
    expect(once.mock.calls.map((c) => c[0])).toEqual([
      null,
      'r500',
      'r1000',
      'r1500',
    ]);
    expect(progress.mock.calls).toEqual([[100], [103]]);
  });

  it('propagates an error and honours shouldStop', async () => {
    await expect(
      sortPastReplies(
        async () => {
          throw new Error('409');
        },
        () => {}
      )
    ).rejects.toThrow('409');

    const once = vi.fn(async () => ({ classified: 5, nextCursor: 'next' }));
    let n = 0;
    await expect(
      sortPastReplies(
        once,
        () => {},
        () => n++ >= 2
      )
    ).resolves.toBe(10);
    expect(once).toHaveBeenCalledTimes(2);
  });
});
