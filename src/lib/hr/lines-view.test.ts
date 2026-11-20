import { describe, expect, it } from 'vitest';

import {
  hrLineRows,
  hrLinesPayload,
  isDirty,
  toggleLine,
  type HrLineChannel,
} from './lines-view';

const names: Record<string, string> = { u1: 'Zaid', u2: 'Amal' };
const nameOf = (id: string) => names[id] ?? null;

const channels: HrLineChannel[] = [
  {
    id: 'p1',
    provider: 'openwa',
    label: null,
    waba_id: '971500000001',
    is_personal: true,
    user_id: 'u1',
  },
  { id: 'm1', provider: 'meta', label: null, waba_id: '1234567890' },
  {
    id: 'p2',
    provider: 'openwa',
    label: 'Amal phone',
    waba_id: '971500000002',
    is_personal: true,
    user_id: 'u2',
  },
  { id: 'w1', provider: 'whapi', label: 'Support', waba_id: '971500000003' },
  { id: 'w2', provider: 'whapi', label: null, waba_id: '971500000004' },
];

describe('hrLineRows', () => {
  const rows = hrLineRows(channels, ['w1', 'p1'], nameOf);

  it('puts company numbers first, then personal numbers by owner', () => {
    expect(rows.map((r) => r.id)).toEqual(['w2', 'm1', 'w1', 'p2', 'p1']);
  });

  it('titles a number by label, linked-device phone, else provider', () => {
    const title = Object.fromEntries(rows.map((r) => [r.id, r.title]));
    expect(title).toMatchObject({
      w1: 'Support',
      w2: '971500000004',
      // A Meta waba_id is the WABA id, never shown as a phone.
      m1: 'Cloud API',
      p1: '971500000001',
    });
  });

  it('marks personal numbers with their owner in the subtitle', () => {
    const sub = Object.fromEntries(rows.map((r) => [r.id, r.subtitle]));
    expect(sub).toEqual({
      w1: 'Whapi',
      w2: 'Whapi',
      m1: 'Cloud API',
      p1: 'OpenWA · Personal, Zaid',
      p2: 'OpenWA · Personal, Amal',
    });
  });

  it('words the owner part with the given formatter', () => {
    const [row] = hrLineRows([channels[0]], [], nameOf, (o) => `개인, ${o}`);
    expect(row.subtitle).toBe('OpenWA · 개인, Zaid');
  });

  it('ticks only the saved numbers', () => {
    expect(rows.filter((r) => r.checked).map((r) => r.id)).toEqual([
      'w1',
      'p1',
    ]);
  });

  it('is empty with no numbers', () => {
    expect(hrLineRows([], ['w1'], nameOf)).toEqual([]);
  });
});

describe('isDirty', () => {
  const saved = { auto_open_recruiter: false, channel_ids: ['a', 'b'] };

  it('is clean for the same ids in another order', () => {
    expect(
      isDirty(saved, { auto_open_recruiter: false, channel_ids: ['b', 'a'] })
    ).toBe(false);
  });

  it('is dirty when the switch changes', () => {
    expect(isDirty(saved, { ...saved, auto_open_recruiter: true })).toBe(true);
  });

  it('is dirty when a number is added, removed or swapped', () => {
    expect(isDirty(saved, { ...saved, channel_ids: ['a', 'b', 'c'] })).toBe(
      true
    );
    expect(isDirty(saved, { ...saved, channel_ids: ['a'] })).toBe(true);
    expect(isDirty(saved, { ...saved, channel_ids: ['a', 'c'] })).toBe(true);
  });

  it('is clean after ticking and unticking the same number', () => {
    const back = toggleLine(toggleLine(saved, 'c', true), 'c', false);
    expect(isDirty(saved, back)).toBe(false);
  });
});

describe('hrLinesPayload', () => {
  it('sends unique sorted ids and the switch', () => {
    expect(
      hrLinesPayload({
        auto_open_recruiter: true,
        channel_ids: ['b', 'a', 'b'],
      })
    ).toEqual({ channelIds: ['a', 'b'], autoOpen: true });
  });
});
