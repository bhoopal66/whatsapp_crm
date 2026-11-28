import { describe, expect, it } from 'vitest';

import {
  dueOccurrence,
  latestOccurrence,
  parseCron,
  timeBasedSubjects,
} from './time-based';

// 09:00 in Dubai (UTC+4) is 05:00 UTC.
const at = (iso: string) => new Date(iso);
const cfg = { schedule: '0 9 * * *', chat_tag_id: 'tag-1' };

describe('parseCron', () => {
  it('reads presets, lists, ranges, steps and legacy HH:mm', () => {
    expect(parseCron('0 9 * * 1-5')).not.toBeNull();
    expect(parseCron('*/15 8-18 1,15 * 0,7')).not.toBeNull();
    expect(parseCron('09:30')?.hour.values).toEqual(new Set([9]));
    expect(parseCron('09:30')?.minute.values).toEqual(new Set([30]));
  });
  it('refuses what it cannot read', () => {
    for (const bad of [
      '',
      'every morning',
      '0 9 * *',
      '60 9 * * *',
      '0 24 * * *',
      '0 9 * * MON',
    ]) {
      expect(parseCron(bad)).toBeNull();
    }
  });
});

describe('latestOccurrence', () => {
  it('names the latest minute of the schedule within the hour', () => {
    expect(
      latestOccurrence('0 9 * * *', at('2026-11-28T05:20:30Z'))?.toISOString()
    ).toBe('2026-11-28T05:00:00.000Z');
  });
  it('is null before the time and once the hour has passed', () => {
    expect(
      latestOccurrence('0 9 * * *', at('2026-11-28T04:59:00Z'))
    ).toBeNull();
    expect(
      latestOccurrence('0 9 * * *', at('2026-11-28T06:00:00Z'))
    ).toBeNull();
  });
  it('reads the schedule in the zone given', () => {
    expect(
      latestOccurrence(
        '0 9 * * *',
        at('2026-11-28T09:10:00Z'),
        'Europe/London'
      )?.toISOString()
    ).toBe('2026-11-28T09:00:00.000Z');
  });
  it('honours the weekday field (2026-11-28 is a Saturday)', () => {
    expect(
      latestOccurrence('0 9 * * 1-5', at('2026-11-28T05:10:00Z'))
    ).toBeNull();
    expect(
      latestOccurrence('0 9 * * 6', at('2026-11-28T05:10:00Z'))
    ).not.toBeNull();
  });
});

describe('dueOccurrence', () => {
  it('is due inside the hour after a scheduled time', () => {
    expect(
      dueOccurrence(cfg, '2026-11-01T00:00:00Z', at('2026-11-28T05:01:00Z'))
    ).toBe('2026-11-28T05:00:00.000Z');
  });
  it('is not yet due before the time', () => {
    expect(
      dueOccurrence(cfg, '2026-11-01T00:00:00Z', at('2026-11-28T04:59:59Z'))
    ).toBeNull();
  });
  it('never fires an occurrence from before the automation existed', () => {
    expect(
      dueOccurrence(cfg, '2026-11-28T05:30:00Z', at('2026-11-28T05:31:00Z'))
    ).toBeNull();
  });
  it('never fires without a chat tag or with an unreadable schedule', () => {
    const now = at('2026-11-28T05:01:00Z');
    expect(dueOccurrence({ schedule: '0 9 * * *' }, null, now)).toBeNull();
    expect(dueOccurrence({ ...cfg, schedule: 'soon' }, null, now)).toBeNull();
  });
});

describe('timeBasedSubjects', () => {
  const ok = { opted_out_at: null, do_not_contact_at: null };
  const rows = [
    { id: 'c1', contact_id: 'p1', contact: ok },
    {
      id: 'c2',
      contact_id: 'p2',
      contact: { ...ok, opted_out_at: '2026-01-01' },
    },
    {
      id: 'c3',
      contact_id: 'p3',
      contact: { ...ok, do_not_contact_at: '2026-01-01' },
    },
    { id: 'c4', contact_id: 'p4', contact: ok },
    { id: 'c5', contact_id: null, contact: null },
    { id: 'c6', contact_id: 'p6', contact: ok },
  ];
  it('starts each due chat, leaving out opted-out and do-not-contact customers', () => {
    expect(timeBasedSubjects(rows, new Set(), 10)).toEqual([
      { conversationId: 'c1', contactId: 'p1' },
      { conversationId: 'c4', contactId: 'p4' },
      { conversationId: 'c6', contactId: 'p6' },
    ]);
  });
  it('skips chats already started for this occurrence', () => {
    expect(timeBasedSubjects(rows, new Set(['c1', 'c4']), 10)).toEqual([
      { conversationId: 'c6', contactId: 'p6' },
    ]);
  });
  it('takes at most the limit', () => {
    expect(timeBasedSubjects(rows, new Set(), 1)).toHaveLength(1);
  });
});
