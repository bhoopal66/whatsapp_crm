import { describe, expect, it } from 'vitest';

import { numberHealth, numberName, numberState } from './numbers';

function num(
  id: string,
  over: Partial<{
    provider: 'whapi' | 'meta' | 'openwa';
    label: string | null;
    waba_id: string | null;
    is_primary: boolean;
    status: string;
    is_personal: boolean;
  }> = {}
) {
  return {
    id,
    provider: 'whapi' as const,
    label: null,
    waba_id: null,
    is_primary: false,
    status: 'connected',
    ...over,
  };
}

describe('numberState', () => {
  it('knows only the two states the health monitor writes', () => {
    expect(numberState('connected')).toBe('connected');
    expect(numberState('disconnected')).toBe('disconnected');
    expect(numberState('pending')).toBe('unknown');
    expect(numberState('')).toBe('unknown');
    expect(numberState(null)).toBe('unknown');
  });
});

describe('numberHealth', () => {
  it("leaves out staff's personal numbers", () => {
    const h = numberHealth([
      num('a'),
      num('p', { is_personal: true, status: 'disconnected' }),
    ]);
    expect(h.total).toBe(1);
    expect(h.summary).toBe('all_connected');
    expect(h.rows.map((r) => r.number.id)).toEqual(['a']);
  });

  it('reads all connected', () => {
    const h = numberHealth([num('a'), num('b'), num('c')]);
    expect(h).toMatchObject({
      total: 3,
      connected: 3,
      disconnected: 0,
      unknown: 0,
      summary: 'all_connected',
    });
  });

  it('reads some disconnected, and lists them first', () => {
    const h = numberHealth([
      num('a', { is_primary: true }),
      num('b', { status: 'weird' }),
      num('c', { status: 'disconnected' }),
      num('d'),
    ]);
    expect(h.summary).toBe('some_disconnected');
    expect([h.connected, h.disconnected, h.unknown]).toEqual([2, 1, 1]);
    expect(h.rows.map((r) => r.number.id)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('does not call a number of unknown state connected', () => {
    const h = numberHealth([num('a'), num('b', { status: 'pending' })]);
    expect(h.summary).toBe('partly_known');
  });

  it('puts the primary first among equals', () => {
    const h = numberHealth([num('a'), num('b', { is_primary: true })]);
    expect(h.rows.map((r) => r.number.id)).toEqual(['b', 'a']);
  });

  it('has nothing to say about no numbers', () => {
    expect(numberHealth([])).toMatchObject({ total: 0, summary: 'none' });
  });
});

describe('numberName', () => {
  it('prefers the label', () => {
    expect(
      numberName({ provider: 'meta', label: ' Sales ', waba_id: '123' })
    ).toBe('Sales');
  });

  it('shows a linked device by its phone', () => {
    expect(
      numberName({ provider: 'whapi', label: null, waba_id: '971501234567' })
    ).toBe('+971501234567');
    expect(
      numberName({ provider: 'openwa', label: '', waba_id: '+97150' })
    ).toBe('+97150');
  });

  it('never shows a WABA id as a phone', () => {
    expect(
      numberName({ provider: 'meta', label: null, waba_id: '1029384756' })
    ).toBeNull();
  });
});
