import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DEVICE_VALUE,
  deviceIdFromValue,
  deviceSelectItems,
  deviceSelectValue,
  meterBars,
  presentOthers,
} from './lobby';

const names: Record<string, string> = { u1: 'Zara Ali', u2: 'Adam Bell' };
const nameOf = (id: string) => names[id] ?? null;

describe('presentOthers', () => {
  it('drops our own seats and dedupes a person with two tabs', () => {
    const body = {
      participants: [
        { user_id: 'u1', hand_raised_at: null },
        { user_id: 'me', hand_raised_at: null },
        { user_id: 'u1', hand_raised_at: '2026-10-15T10:00:00Z' },
        { user_id: 'u2', hand_raised_at: null },
        { user_id: 'me', hand_raised_at: null },
      ],
    };
    expect(presentOthers(body, 'me', nameOf)).toEqual({
      people: [
        { userId: 'u2', name: 'Adam Bell' },
        { userId: 'u1', name: 'Zara Ali' },
      ],
      count: 2,
    });
  });

  it('is empty, not unknown, when only we are present', () => {
    expect(
      presentOthers({ participants: [{ user_id: 'me' }] }, 'me', nameOf)
    ).toEqual({ people: [], count: 0 });
  });

  it('keeps people the roster cannot name, after the named ones', () => {
    const body = {
      participants: [{ user_id: 'x2' }, { user_id: 'x1' }, { user_id: 'u1' }],
    };
    expect(presentOthers(body, null, nameOf).people).toEqual([
      { userId: 'u1', name: 'Zara Ali' },
      { userId: 'x1', name: null },
      { userId: 'x2', name: null },
    ]);
  });

  it('skips malformed rows', () => {
    const body = {
      participants: [null, 'u1', { user_id: 7 }, { user_id: '' }, {}],
    };
    expect(presentOthers(body, 'me', nameOf)).toEqual({
      people: [],
      count: 0,
    });
  });

  it('falls back to present_count without a participants list', () => {
    expect(presentOthers({ present_count: 3 }, 'me', nameOf)).toEqual({
      people: [],
      count: 3,
    });
  });

  it('is unknown when the answer carries neither field', () => {
    for (const body of [{}, null, 'oops', { present_count: '2' }]) {
      expect(presentOthers(body, 'me', nameOf)).toEqual({
        people: [],
        count: null,
      });
    }
  });
});

describe('meterBars', () => {
  it('is dark in silence and for nonsense', () => {
    expect(meterBars(0)).toBe(0);
    expect(meterBars(-1)).toBe(0);
    expect(meterBars(Number.NaN)).toBe(0);
  });

  it('lights one bar for any sound and all bars from 0.5', () => {
    expect(meterBars(0.001)).toBe(1);
    expect(meterBars(0.5)).toBe(5);
    expect(meterBars(1)).toBe(5);
  });

  it('rises with the level', () => {
    const levels = [0.05, 0.1, 0.2, 0.3, 0.5];
    const lit = levels.map((l) => meterBars(l));
    expect(lit).toEqual([...lit].sort((a, b) => a - b));
    expect(meterBars(0.05)).toBeGreaterThan(1);
  });

  it('honours the bar count', () => {
    expect(meterBars(1, 3)).toBe(3);
    expect(meterBars(1, 0)).toBe(0);
  });
});

describe('device pickers', () => {
  const unnamed = (n: number) => `Microphone ${n}`;

  it('lists the default first and names unlabelled devices', () => {
    const items = deviceSelectItems(
      [
        { deviceId: 'a', label: 'Built-in' },
        { deviceId: 'b', label: '' },
        { deviceId: 'a', label: 'Duplicate' },
      ],
      'System default',
      unnamed
    );
    expect(Object.entries(items)).toEqual([
      [DEFAULT_DEVICE_VALUE, 'System default'],
      ['a', 'Built-in'],
      ['b', 'Microphone 2'],
    ]);
  });

  it('shows the default for null or an unlisted choice', () => {
    const items = deviceSelectItems(
      [{ deviceId: 'a', label: 'A' }],
      'Default',
      unnamed
    );
    expect(deviceSelectValue('a', items)).toBe('a');
    expect(deviceSelectValue(null, items)).toBe(DEFAULT_DEVICE_VALUE);
    expect(deviceSelectValue('gone', items)).toBe(DEFAULT_DEVICE_VALUE);
    expect(deviceSelectValue('constructor', items)).toBe(DEFAULT_DEVICE_VALUE);
  });

  it('maps the default back to an empty id for selectDevice', () => {
    expect(deviceIdFromValue(DEFAULT_DEVICE_VALUE)).toBe('');
    expect(deviceIdFromValue(null)).toBe('');
    expect(deviceIdFromValue('a')).toBe('a');
  });
});
