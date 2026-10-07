import { describe, expect, it } from 'vitest';
import {
  COMPASS_ORDERS,
  compassColumns,
  compassOrderSpec,
  compassReadIsConsistent,
  compassRowToCsvRow,
  compassSelectionKey,
  compassWindowPage,
  compassWindowSize,
  normalizeCompassSelection,
  parseCompassLimit,
  parseCompassStart,
  readCompassWindow,
  type CompassAudienceRow,
  type CompassSelection,
} from './compass-audience';

const sel = (s: Partial<CompassSelection>): CompassSelection => ({
  order: 'list_top',
  offset: 0,
  limit: null,
  ...s,
});

describe('compassOrderSpec', () => {
  it('maps the top of the Compass list to updated_at descending', () => {
    expect(compassOrderSpec('list_top')).toEqual({
      column: 'updated_at',
      ascending: false,
    });
  });

  it('maps the bottom of the Compass list to updated_at ascending', () => {
    expect(compassOrderSpec('list_bottom')).toEqual({
      column: 'updated_at',
      ascending: true,
    });
  });

  it('maps the added and name orders', () => {
    expect(compassOrderSpec('newest_added')).toEqual({
      column: 'created_at',
      ascending: false,
    });
    expect(compassOrderSpec('oldest_added')).toEqual({
      column: 'created_at',
      ascending: true,
    });
    expect(compassOrderSpec('name_az')).toEqual({
      column: 'name',
      ascending: true,
    });
    expect(compassOrderSpec('name_za')).toEqual({
      column: 'name',
      ascending: false,
    });
    for (const order of COMPASS_ORDERS)
      expect(compassOrderSpec(order)).toBeDefined();
  });
});

describe('normalizeCompassSelection', () => {
  it('defaults an empty selection to the whole list from the top', () => {
    expect(normalizeCompassSelection(undefined)).toEqual({
      order: 'list_top',
      offset: 0,
      limit: null,
    });
  });

  it('clamps the offset and limit to non-negative integers', () => {
    expect(
      normalizeCompassSelection({ order: 'name_az', offset: 9.7, limit: 100.4 })
    ).toEqual({ order: 'name_az', offset: 9, limit: 100 });
    expect(
      normalizeCompassSelection({ order: 'bogus' as never, offset: -3 })
    ).toEqual({ order: 'list_top', offset: 0, limit: null });
  });

  it('reads only an absent limit as all', () => {
    for (const limit of [null, undefined, '' as never]) {
      expect(normalizeCompassSelection({ limit }).limit).toBeNull();
    }
  });

  it('turns a 0, negative, NaN or infinite limit into an empty window, never all', () => {
    for (const limit of [
      0,
      -5,
      0.4,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      'abc' as never,
    ]) {
      const s = normalizeCompassSelection({ limit });
      expect(s.limit).toBe(0);
      expect(compassWindowSize(s, 4213)).toBe(0);
      expect(compassWindowPage(s, 0, 1000)).toBeNull();
    }
  });
});

describe('compassSelectionKey', () => {
  it('differs whenever the order, offset or limit does', () => {
    const base = compassSelectionKey(sel({ offset: 10, limit: 100 }));
    expect(compassSelectionKey(sel({ offset: 10, limit: 100 }))).toBe(base);
    expect(
      compassSelectionKey(sel({ order: 'name_az', offset: 10, limit: 100 }))
    ).not.toBe(base);
    expect(compassSelectionKey(sel({ offset: 11, limit: 100 }))).not.toBe(base);
    expect(compassSelectionKey(sel({ offset: 10, limit: 101 }))).not.toBe(base);
    expect(compassSelectionKey(sel({ offset: 10 }))).not.toBe(base);
    expect(compassSelectionKey(sel({ offset: 10, limit: 0 }))).not.toBe(
      compassSelectionKey(sel({ offset: 10 }))
    );
  });
});

describe('parseCompassStart', () => {
  it('turns a 1-based position into a 0-based offset', () => {
    expect(parseCompassStart('1')).toBe(0);
    expect(parseCompassStart('500')).toBe(499);
    expect(parseCompassStart(' 42 ')).toBe(41);
  });

  it('rejects blank, zero, negative and non-integer text', () => {
    for (const text of ['', ' ', '0', '-1', '1.5', '5e', 'abc', '1e3']) {
      expect(parseCompassStart(text)).toBeNull();
    }
  });
});

describe('parseCompassLimit', () => {
  it('reads blank as all and a positive whole number as that many', () => {
    expect(parseCompassLimit('')).toEqual({ limit: null });
    expect(parseCompassLimit('  ')).toEqual({ limit: null });
    expect(parseCompassLimit('100')).toEqual({ limit: 100 });
  });

  it('rejects 0, negative and non-integer text rather than read it as all', () => {
    for (const text of ['0', '00', '-3', '2.5', '5e', 'abc']) {
      expect(parseCompassLimit(text)).toBeNull();
    }
  });
});

describe('compassWindowSize', () => {
  it('takes the limit when enough rows remain', () => {
    expect(compassWindowSize(sel({ offset: 0, limit: 100 }), 4213)).toBe(100);
  });

  it('is cut short by the end of the list', () => {
    expect(compassWindowSize(sel({ offset: 4200, limit: 100 }), 4213)).toBe(13);
  });

  it('takes everything after the offset when limit is null', () => {
    expect(compassWindowSize(sel({ offset: 13 }), 4213)).toBe(4200);
  });

  it('is empty when the offset is past the end', () => {
    expect(compassWindowSize(sel({ offset: 5000, limit: 10 }), 4213)).toBe(0);
    expect(compassWindowSize(sel({ offset: 4213 }), 4213)).toBe(0);
  });
});

describe('compassWindowPage', () => {
  it('starts at the offset and stops at the limit', () => {
    const s = sel({ offset: 50, limit: 2500 });
    expect(compassWindowPage(s, 0, 1000)).toEqual({ from: 50, to: 1049 });
    expect(compassWindowPage(s, 1000, 1000)).toEqual({ from: 1050, to: 2049 });
    expect(compassWindowPage(s, 2000, 1000)).toEqual({ from: 2050, to: 2549 });
    expect(compassWindowPage(s, 2500, 1000)).toBeNull();
  });

  it('follows short pages by what was actually fetched', () => {
    // max-rows of 500 under a 1000-row page: the next page starts at
    // the first row not yet seen, not a page further on.
    const s = sel({ offset: 10, limit: 1200 });
    expect(compassWindowPage(s, 500, 1000)).toEqual({ from: 510, to: 1209 });
  });

  it('never ends on its own when limit is null', () => {
    const s = sel({ offset: 7 });
    expect(compassWindowPage(s, 0, 1000)).toEqual({ from: 7, to: 1006 });
    expect(compassWindowPage(s, 90_000, 1000)).toEqual({
      from: 90_007,
      to: 91_006,
    });
  });

  it('asks for a small limit in one short page', () => {
    expect(compassWindowPage(sel({ offset: 0, limit: 100 }), 0, 1000)).toEqual({
      from: 0,
      to: 99,
    });
  });
});

/**
 * A fake `.range(from, to)` over `total` rows (row i is the number i)
 * that, like PostgREST, answers at most `maxRows` per request.
 */
function fakeTable(total: number, maxRows = Number.POSITIVE_INFINITY) {
  const calls: [number, number][] = [];
  const page = (from: number, to: number) => {
    calls.push([from, to]);
    const end = Math.min(to + 1, total, from + maxRows);
    const data: number[] = [];
    for (let i = from; i < end; i++) data.push(i);
    return Promise.resolve({ data, error: null });
  };
  return { page, calls };
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => from + i);

describe('readCompassWindow', () => {
  it('keeps reading past short pages when max-rows is below the page size', async () => {
    const t = fakeTable(10, 3);
    const rows = await readCompassWindow(
      t.page,
      { offset: 0, limit: null },
      5,
      'x'
    );
    expect(rows).toEqual(range(0, 10));
    // The last request is the empty page that ends the read.
    expect(t.calls.at(-1)).toEqual([10, 14]);
  });

  it('reads to the empty page when limit is null', async () => {
    const t = fakeTable(12);
    const rows = await readCompassWindow(
      t.page,
      { offset: 2, limit: null },
      5,
      'x'
    );
    expect(rows).toEqual(range(2, 12));
    expect(t.calls).toEqual([
      [2, 6],
      [7, 11],
      [12, 16],
    ]);
  });

  it('reads a limit smaller than one page in one request', async () => {
    const t = fakeTable(100);
    const rows = await readCompassWindow(
      t.page,
      { offset: 10, limit: 3 },
      5,
      'x'
    );
    expect(rows).toEqual([10, 11, 12]);
    expect(t.calls).toEqual([[10, 12]]);
  });

  it('stops at a limit that spans pages and ends mid-page', async () => {
    const t = fakeTable(100, 3);
    const rows = await readCompassWindow(
      t.page,
      { offset: 4, limit: 11 },
      5,
      'x'
    );
    expect(rows).toEqual(range(4, 15));
    for (const [, to] of t.calls) expect(to).toBeLessThanOrEqual(14);
    expect(t.calls.at(-1)).toEqual([13, 14]);
  });

  it('returns nothing when the offset is past the end', async () => {
    const t = fakeTable(10);
    const rows = await readCompassWindow(
      t.page,
      { offset: 50, limit: 5 },
      5,
      'x'
    );
    expect(rows).toEqual([]);
  });

  it('asks for nothing when the limit is 0', async () => {
    const t = fakeTable(10);
    expect(
      await readCompassWindow(t.page, { offset: 0, limit: 0 }, 5, 'x')
    ).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it('throws on a page error', async () => {
    await expect(
      readCompassWindow(
        () => Promise.resolve({ data: null, error: { message: 'boom' } }),
        { offset: 0, limit: null },
        5,
        'Compass contacts'
      )
    ).rejects.toThrow('Failed to fetch Compass contacts: boom');
  });
});

describe('compassReadIsConsistent', () => {
  it('accepts a read with the same count and nothing stamped since', () => {
    expect(
      compassReadIsConsistent({
        before: { count: 4213 },
        after: { count: 4213, changedSince: 0 },
      })
    ).toBe(true);
  });

  it('rejects a read during which rows were updated (a sync)', () => {
    expect(
      compassReadIsConsistent({
        before: { count: 4213 },
        after: { count: 4213, changedSince: 50 },
      })
    ).toBe(false);
  });

  it('rejects a read during which the filtered count changed', () => {
    expect(
      compassReadIsConsistent({
        before: { count: 4213 },
        after: { count: 4212, changedSince: 0 },
      })
    ).toBe(false);
    expect(
      compassReadIsConsistent({
        before: { count: 4213 },
        after: { count: 4214, changedSince: 0 },
      })
    ).toBe(false);
  });
});

const row = (r: Partial<CompassAudienceRow>): CompassAudienceRow => ({
  compass_id: 'C-1',
  name: 'Aisha',
  phone: '971501234567',
  email: null,
  company: 'Acme',
  attributes: null,
  ...r,
});

describe('compassRowToCsvRow', () => {
  it('carries the built-ins for the upsert and as values', () => {
    expect(compassRowToCsvRow(row({ email: 'a@x.ae' }))).toEqual({
      phone: '971501234567',
      name: 'Aisha',
      company: 'Acme',
      values: {
        name: 'Aisha',
        phone: '971501234567',
        email: 'a@x.ae',
        company: 'Acme',
        compass_id: 'C-1',
      },
    });
  });

  it('lower-cases attribute keys and stringifies their values', () => {
    const csv = compassRowToCsvRow(
      row({
        name: null,
        company: null,
        attributes: {
          'Account Type': 'Gold',
          Balance: 1200.5,
          Active: true,
          Missing: null,
          Branch: { city: 'Dubai' },
          Name: 'shadow',
        },
      })
    );
    expect(csv.name).toBeUndefined();
    expect(csv.company).toBeUndefined();
    expect(csv.values).toEqual({
      phone: '971501234567',
      compass_id: 'C-1',
      'account type': 'Gold',
      balance: '1200.5',
      active: 'true',
      branch: '{"city":"Dubai"}',
    });
  });
});

describe('compassColumns', () => {
  it('lists built-ins first, then the union of attribute keys sorted', () => {
    const rows = [
      compassRowToCsvRow(row({ attributes: { Zone: 'B', tier: 'gold' } })),
      compassRowToCsvRow(row({ attributes: { branch: 'Deira' } })),
    ];
    expect(compassColumns(rows)).toEqual([
      'name',
      'phone',
      'email',
      'company',
      'compass_id',
      'branch',
      'tier',
      'zone',
    ]);
  });

  it('still offers the built-ins for an empty sample', () => {
    expect(compassColumns([])).toEqual([
      'name',
      'phone',
      'email',
      'company',
      'compass_id',
    ]);
  });
});
