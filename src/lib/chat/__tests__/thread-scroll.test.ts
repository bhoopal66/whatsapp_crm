import { describe, expect, it } from 'vitest';

import { holdThread, threadScrollBy } from '../thread-scroll';

const ROOT = 'root';
const row = (id: string, top: number, height = 50) => ({
  id,
  top,
  bottom: top + height,
});
/** 1000 tall, 400 in view, scrolled to `scrollTop`. */
const list = (scrollTop: number) => ({
  scrollTop,
  scrollHeight: 1000,
  clientHeight: 400,
});

describe('a thread that changes while someone reads it', () => {
  const rows = [row(ROOT, -80), row('a', -10), row('b', 40), row('c', 500)];

  it('keeps the reply being read where it was', () => {
    const held = holdThread(rows, ROOT, list(200))!;
    expect(held).toEqual({
      atBottom: false,
      rows: [
        { id: 'a', top: -10 },
        { id: 'b', top: 40 },
      ],
    });
    // 300px came in above it.
    const tops: Record<string, number> = { a: 290, b: 340 };
    const by = threadScrollBy(held, (id) => tops[id] ?? null, {
      scrollTop: 200,
      scrollHeight: 1300,
    });
    expect(by).toBe(300);
  });

  it('holds the next row when the first one is gone', () => {
    const held = holdThread(rows, ROOT, list(200))!;
    const by = threadScrollBy(held, (id) => (id === 'b' ? -10 : null), {
      scrollTop: 200,
      scrollHeight: 950,
    });
    expect(by).toBe(-50);
  });

  it('does not move when the browser already held the row', () => {
    const held = holdThread(rows, ROOT, list(200))!;
    const by = threadScrollBy(held, () => -10, {
      scrollTop: 500,
      scrollHeight: 1300,
    });
    expect(by).toBe(0);
  });

  it('holds a reply before the root, which older replies go in under', () => {
    const top = [row(ROOT, 0), row('a', 90)];
    expect(holdThread(top, ROOT, list(0))!.rows.map((r) => r.id)).toEqual([
      'a',
      ROOT,
    ]);
  });

  it('follows the thread at the bottom', () => {
    const held = holdThread(rows, ROOT, list(560))!;
    expect(held.atBottom).toBe(true);
    const by = threadScrollBy(held, () => 0, {
      scrollTop: 560,
      scrollHeight: 1060,
    });
    expect(560 + by).toBe(1060);
  });

  it('opens at the root: nothing is held before there are rows', () => {
    expect(holdThread([], ROOT, list(0))).toBeNull();
  });
});
