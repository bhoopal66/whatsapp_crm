import { describe, expect, it } from 'vitest';

import {
  buildMeetingIcs,
  escapeIcsText,
  foldIcsLine,
  icsFileName,
  toIcsUtc,
} from './ics';

const NOW = new Date('2026-10-15T08:10:00.123Z');
const MEETING = {
  id: '0b6f1c1e-2a8f-4f43-9f7e-6d3a1c2b9e10',
  title: 'Weekly sync',
  description: null,
  scheduledStart: '2026-10-16T10:00:00.000Z',
  scheduledEnd: '2026-10-16T10:30:00.000Z',
};
const OPTS = { origin: 'https://crm.example.com/', now: NOW };

/** Undo folding (3.1): a CRLF followed by one space is removed. */
const unfold = (ics: string) => ics.replace(/\r\n /g, '');
const prop = (ics: string, name: string) =>
  unfold(ics)
    .split('\r\n')
    .find((l) => l.startsWith(`${name}:`))
    ?.slice(name.length + 1);

describe('escapeIcsText', () => {
  it('escapes backslash, semicolon, comma and line breaks', () => {
    expect(escapeIcsText('a\\b')).toBe('a\\\\b');
    expect(escapeIcsText('a;b')).toBe('a\\;b');
    expect(escapeIcsText('a,b')).toBe('a\\,b');
    expect(escapeIcsText('a\r\nb\nc\rd')).toBe('a\\nb\\nc\\nd');
  });

  it('escapes the backslash before adding its own', () => {
    expect(escapeIcsText('\\,')).toBe('\\\\\\,');
  });

  it('drops control characters but keeps tabs', () => {
    expect(escapeIcsText('a\u0007b\tc')).toBe('ab\tc');
  });
});

describe('foldIcsLine', () => {
  it('leaves a line of 75 octets alone', () => {
    const line = 'x'.repeat(75);
    expect(foldIcsLine(line)).toBe(line);
  });

  it('folds longer lines so no physical line exceeds 75 octets', () => {
    const line = `SUMMARY:${'y'.repeat(200)}`;
    const folded = foldIcsLine(line);
    const physical = folded.split('\r\n');
    expect(physical.length).toBeGreaterThan(1);
    expect(physical[0]).toHaveLength(75);
    for (const p of physical.slice(1)) expect(p.startsWith(' ')).toBe(true);
    for (const p of physical)
      expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75);
    expect(unfold(folded)).toBe(line);
  });

  it('counts octets and never splits a multi-byte character', () => {
    const line = `SUMMARY:${'회의'.repeat(40)}`; // 3 octets per character
    const physical = foldIcsLine(line).split('\r\n');
    for (const p of physical) {
      expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75);
      expect(p).not.toContain('�');
    }
    expect(unfold(foldIcsLine(line))).toBe(line);
  });
});

describe('buildMeetingIcs', () => {
  it('has no calendar entry for an instant meeting', () => {
    expect(
      buildMeetingIcs(
        { ...MEETING, scheduledStart: null, scheduledEnd: null },
        OPTS
      )
    ).toBeNull();
  });

  it('writes UTC times, a stable UID and the meeting link', () => {
    const ics = buildMeetingIcs(MEETING, OPTS)!;
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VEVENT\r\nEND:VCALENDAR\r\n')).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/);
    expect(prop(ics, 'DTSTART')).toBe('20261016T100000Z');
    expect(prop(ics, 'DTEND')).toBe('20261016T103000Z');
    expect(prop(ics, 'DTSTAMP')).toBe('20261015T081000Z');
    expect(prop(ics, 'UID')).toBe(`${MEETING.id}@crm.example.com`);
    expect(prop(ics, 'URL')).toBe(
      `https://crm.example.com/meetings/${MEETING.id}`
    );
    // Same meeting, later download: same UID, so calendars update it.
    const later = buildMeetingIcs(MEETING, { ...OPTS, now: new Date() })!;
    expect(prop(later, 'UID')).toBe(prop(ics, 'UID'));
  });

  it('escapes the title and description, and links the page', () => {
    const ics = buildMeetingIcs(
      {
        ...MEETING,
        title: 'Q4; budget, review \\ plan',
        description: 'Line one\nLine two, with comma',
      },
      OPTS
    )!;
    expect(prop(ics, 'SUMMARY')).toBe('Q4\\; budget\\, review \\\\ plan');
    expect(prop(ics, 'DESCRIPTION')).toBe(
      `Line one\\nLine two\\, with comma\\n\\nhttps://crm.example.com/meetings/${MEETING.id}`
    );
  });

  it('folds every long line', () => {
    const ics = buildMeetingIcs(
      { ...MEETING, title: 'T'.repeat(300), description: 'D'.repeat(500) },
      OPTS
    )!;
    for (const line of ics.split('\r\n'))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(prop(ics, 'SUMMARY')).toBe('T'.repeat(300));
  });

  it('omits DTEND when the meeting has no end', () => {
    const ics = buildMeetingIcs({ ...MEETING, scheduledEnd: null }, OPTS)!;
    expect(prop(ics, 'DTEND')).toBeUndefined();
  });
});

describe('helpers', () => {
  it('formats instants as UTC DATE-TIME', () => {
    expect(toIcsUtc('2026-10-16T14:00:00+04:00')).toBe('20261016T100000Z');
  });

  it('names the file after the title', () => {
    expect(icsFileName('Weekly sync: Q4!')).toBe('weekly-sync-q4.ics');
    expect(icsFileName('주간 회의')).toBe('주간-회의.ics');
    expect(icsFileName('***')).toBe('meeting.ics');
  });
});
