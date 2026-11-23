import { describe, expect, it } from 'vitest';

import { customerAccess } from './customer-access';
import {
  dealRows,
  dealsFromRead,
  headerActions,
  overflowItems,
} from './customer-layout';

describe('headerActions', () => {
  it('gives a viewer only the WhatsApp chat link', () => {
    const a = headerActions(customerAccess('viewer'));
    expect(a).toEqual({ bar: ['whatsapp'], secondary: [], menu: [] });
    expect(overflowItems(a, true)).toEqual([]);
  });

  it('gives an agent call, send and edit but no delete', () => {
    const a = headerActions(customerAccess('agent'));
    expect(a.bar).toEqual(['call', 'whatsapp', 'message']);
    expect(a.secondary).toEqual(['template', 'edit']);
    expect(a.menu).toEqual([]);
  });

  it('keeps delete in the menu for an admin, and moves secondary ones there on a phone', () => {
    const a = headerActions(customerAccess('admin'));
    expect(overflowItems(a, false)).toEqual(['delete']);
    expect(overflowItems(a, true)).toEqual(['template', 'edit', 'delete']);
  });

  it('shows nothing that acts while the role is loading', () => {
    expect(headerActions(customerAccess(null))).toEqual({
      bar: ['whatsapp'],
      secondary: [],
      menu: [],
    });
  });
});

describe('dealsFromRead', () => {
  it('never takes an error for an empty list', () => {
    expect(dealsFromRead({ data: null, error: { message: 'timeout' } })).toBe(
      'failed'
    );
    expect(dealsFromRead({ data: [], error: { message: 'x' } })).toBe('failed');
    expect(dealsFromRead({ data: null, error: null })).toBe('failed');
  });
  it('gives the rows of a good read', () => {
    const rows = [{ id: 'd1', title: 'T', value: 1 }];
    expect(dealsFromRead({ data: rows, error: null })).toBe(rows);
    expect(dealsFromRead({ data: [], error: null })).toEqual([]);
  });
});

describe('dealRows', () => {
  it('formats value in the deal or default currency, open deals first', () => {
    const rows = dealRows(
      [
        { id: 'a', title: 'Won one', value: 5, status: 'won', stage: null },
        {
          id: 'b',
          title: 'Open one',
          value: null,
          currency: null,
          status: 'open',
          stage: { name: 'Docs', color: '#f00' },
        },
      ],
      'AED'
    );
    expect(rows.map((r) => [r.id, r.outcome, r.stage])).toEqual([
      ['b', null, 'Docs'],
      ['a', 'won', null],
    ]);
    expect(rows[0].value).toMatch(/0/);
    expect(rows[0].value).toMatch(/AED|د\.إ/);
  });
});
