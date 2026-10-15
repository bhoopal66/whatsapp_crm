import { describe, expect, it } from 'vitest';

import { buildPayload, MAX_PAYLOAD_BYTES } from './payload';
import { decideQuietHours, parseClock } from './quiet-hours';
import { PUSH_KINDS, ttlFor, urgencyFor } from './kinds';

const night = {
  quiet_start: '22:00',
  quiet_end: '07:00',
  time_zone: 'Asia/Dubai',
};
// 2026-10-15 23:00 in Dubai (UTC+4).
const at2300 = new Date('2026-10-15T19:00:00Z');

describe('decideQuietHours', () => {
  it('sends outside the window and when no window is set', () => {
    const noon = new Date('2026-10-15T08:00:00Z');
    expect(
      decideQuietHours({
        kind: 'chat_message',
        createdAt: noon,
        prefs: night,
        now: noon,
      })
    ).toEqual({ action: 'send' });
    expect(
      decideQuietHours({
        kind: 'chat_message',
        createdAt: at2300,
        prefs: null,
        now: at2300,
      })
    ).toEqual({ action: 'send' });
    expect(
      decideQuietHours({
        kind: 'chat_message',
        createdAt: at2300,
        prefs: { ...night, quiet_end: '22:00' },
        now: at2300,
      })
    ).toEqual({ action: 'send' });
  });

  it('holds a chat or WhatsApp message until the window ends (across midnight, in the zone)', () => {
    const created = new Date('2026-10-15T18:59:00Z');
    for (const kind of ['chat_message', 'whatsapp_message', 'task_assigned']) {
      expect(
        decideQuietHours({
          kind,
          createdAt: created,
          prefs: night,
          now: at2300,
        })
      ).toEqual({
        action: 'hold',
        until: new Date('2026-10-16T03:00:00Z'), // 07:00 Dubai
      });
    }
  });

  it('still delivers reminders during quiet hours', () => {
    for (const kind of ['meeting_reminder', 'event_reminder']) {
      expect(
        decideQuietHours({ kind, createdAt: at2300, prefs: night, now: at2300 })
      ).toEqual({ action: 'send' });
    }
  });

  it('skips a row that would be 12 h or older when the window ends', () => {
    const old = new Date('2026-10-15T14:00:00Z'); // 13 h before 07:00 Dubai
    expect(
      decideQuietHours({
        kind: 'chat_message',
        createdAt: old,
        prefs: night,
        now: at2300,
      }).action
    ).toBe('skip');
  });

  it('handles a same-day window and an unknown zone as UTC', () => {
    const prefs = {
      quiet_start: '12:00:00',
      quiet_end: '13:30:00',
      time_zone: 'Not/AZone',
    };
    const now = new Date('2026-10-15T12:10:00Z');
    expect(
      decideQuietHours({ kind: 'chat_message', createdAt: now, prefs, now })
    ).toEqual({
      action: 'hold',
      until: new Date('2026-10-15T13:30:00Z'),
    });
  });

  it('parses HH:MM and HH:MM:SS only', () => {
    expect(parseClock('07:30')).toBe(27_000);
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('7:30')).toBeNull();
  });
});

describe('kinds', () => {
  it('urgency and TTL', () => {
    expect(urgencyFor('whatsapp_message')).toBe('high');
    expect(urgencyFor('event_reminder')).toBe('high');
    expect(urgencyFor('task_assigned')).toBe('normal');
    expect(ttlFor('chat_message')).toBe(86_400);
    expect(ttlFor('meeting_invite')).toBe(259_200);
  });

  it('no chat_* bell type is a preference (its message pushes instead)', () => {
    expect(
      PUSH_KINDS.some((k) => k.startsWith('chat_') && k !== 'chat_message')
    ).toBe(false);
  });
});

describe('buildPayload', () => {
  const row = {
    title: 'Asha',
    body: 'hi',
    url: '/inbox?c=1',
    tag: 'wa:1',
    kind: 'whatsapp_message',
    created_at: '2026-10-15T19:00:00Z',
  };

  it('carries title, body, url, tag, kind and ts', () => {
    expect(JSON.parse(buildPayload(row))).toEqual({
      title: 'Asha',
      body: 'hi',
      url: '/inbox?c=1',
      tag: 'wa:1',
      kind: 'whatsapp_message',
      ts: Date.parse(row.created_at),
    });
  });

  it('stays within 3 KB and never links off-site', () => {
    const big = buildPayload({
      ...row,
      body: '😀'.repeat(2000),
      url: 'https://evil.example',
    });
    expect(Buffer.byteLength(big)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(JSON.parse(big).url).toBe('/notifications');
  });
});
