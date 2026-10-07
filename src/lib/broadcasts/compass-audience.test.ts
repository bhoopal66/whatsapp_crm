import { describe, expect, it } from 'vitest';
import {
  COMPASS_ORDERS,
  compassColumns,
  compassOrderSpec,
  compassRowToCsvRow,
  compassWindowPage,
  compassWindowSize,
  normalizeCompassSelection,
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

  it('clamps to non-negative integers and reads limit 0 as all', () => {
    expect(
      normalizeCompassSelection({ order: 'list_bottom', offset: -3, limit: 0 })
    ).toEqual({ order: 'list_bottom', offset: 0, limit: null });
    expect(
      normalizeCompassSelection({ order: 'name_az', offset: 9.7, limit: 100.4 })
    ).toEqual({ order: 'name_az', offset: 9, limit: 100 });
    expect(
      normalizeCompassSelection({
        order: 'bogus' as never,
        offset: Number.NaN,
        limit: Number.POSITIVE_INFINITY,
      })
    ).toEqual({ order: 'list_top', offset: 0, limit: null });
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
