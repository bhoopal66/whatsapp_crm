import { describe, expect, it } from 'vitest';

import {
  formatDuration,
  groupTimelineByDay,
  parseAuditRows,
  parseCallSummary,
  parseConversation,
  parseTimeline,
  sendResultMessageKey,
  shouldRestoreText,
  timelineIcon,
  type TimelineEntry,
} from './case-tabs';

const entry = (at: string, kind = 'note'): TimelineEntry => ({
  at,
  kind,
  refId: at,
  actor: null,
  summary: '',
  source: 'case',
});

describe('groupTimelineByDay', () => {
  it('groups by the calendar day of the given time zone', () => {
    // 21:30 UTC on the 1st is already the 2nd in Dubai (UTC+4).
    const rows = [
      entry('2026-10-01T08:00:00Z'),
      entry('2026-10-01T21:30:00Z'),
      entry('2026-10-02T10:00:00Z'),
    ];
    expect(
      groupTimelineByDay(rows, 'Asia/Dubai').map((d) => [
        d.day,
        d.entries.length,
      ])
    ).toEqual([
      ['2026-10-01', 1],
      ['2026-10-02', 2],
    ]);
    expect(
      groupTimelineByDay(rows, 'UTC').map((d) => [d.day, d.entries.length])
    ).toEqual([
      ['2026-10-01', 2],
      ['2026-10-02', 1],
    ]);
  });

  it('keeps the input order of days and entries (newest first stays so)', () => {
    const rows = [
      entry('2026-10-02T10:00:00Z', 'b'),
      entry('2026-10-02T09:00:00Z', 'a'),
      entry('2026-10-01T09:00:00Z', 'c'),
    ];
    const days = groupTimelineByDay(rows, 'UTC');
    expect(days.map((d) => d.day)).toEqual(['2026-10-02', '2026-10-01']);
    expect(days[0].entries.map((e) => e.kind)).toEqual(['b', 'a']);
  });

  it('puts every entry of a day in one group even when not adjacent', () => {
    const rows = [
      entry('2026-10-01T09:00:00Z'),
      entry('2026-10-02T09:00:00Z'),
      entry('2026-10-01T10:00:00Z'),
    ];
    expect(groupTimelineByDay(rows, 'UTC')).toHaveLength(2);
  });

  it('is empty for no entries', () => {
    expect(groupTimelineByDay([])).toEqual([]);
  });
});

describe('timelineIcon', () => {
  it('maps every timeline kind', () => {
    expect(timelineIcon('stage')).toBe('ArrowRightLeft');
    expect(timelineIcon('task')).toBe('ListPlus');
    expect(timelineIcon('task_status')).toBe('ListChecks');
    expect(timelineIcon('note')).toBe('StickyNote');
    expect(timelineIcon('document')).toBe('FileText');
    expect(timelineIcon('sla')).toBe('Timer');
    expect(timelineIcon('bank_contact')).toBe('Landmark');
    expect(timelineIcon('group_open')).toBe('Users');
    expect(timelineIcon('group_end')).toBe('UserX');
    expect(timelineIcon('conversation_archived')).toBe('Archive');
    expect(timelineIcon('group_message')).toBe('MessageSquare');
    expect(timelineIcon('message')).toBe('MessageSquare');
    expect(timelineIcon('call')).toBe('Phone');
  });

  it('falls back to a dot, also for prototype names', () => {
    expect(timelineIcon('something_new')).toBe('Circle');
    expect(timelineIcon('toString')).toBe('Circle');
  });
});

describe('sendResultMessageKey', () => {
  it('201 is sent; 200 is sent but not recorded', () => {
    expect(sendResultMessageKey(201, undefined)).toBe('sent');
    expect(sendResultMessageKey(200, undefined)).toBe('sentNotRecorded');
  });

  it('names each refusal code', () => {
    expect(sendResultMessageKey(409, 'SEND_BLOCKED')).toBe('optedOut');
    expect(sendResultMessageKey(409, 'SEND_NOT_ALLOWED')).toBe('notOnList');
    expect(sendResultMessageKey(409, 'UNKNOWN_USER')).toBe('notOnList');
    expect(sendResultMessageKey(409, 'GROUP_NOT_READY')).toBe('notReady');
    expect(sendResultMessageKey(409, 'GROUP_NOT_FOUND')).toBe('noGroup');
    expect(sendResultMessageKey(409, 'NUMBER_REMOVED')).toBe('numberRemoved');
    expect(sendResultMessageKey(409, 'CONTACT_REMOVED')).toBe('contactRemoved');
    expect(sendResultMessageKey(429, 'SEND_RATE_LIMITED')).toBe('rateLimited');
  });

  it('falls back on the status', () => {
    expect(sendResultMessageKey(429, undefined)).toBe('rateLimited');
    expect(sendResultMessageKey(409, 'SOMETHING_ELSE')).toBe('notReady');
    expect(sendResultMessageKey(403, 'NOT_ALLOWED')).toBe('notAllowed');
    expect(sendResultMessageKey(404, 'CASE_NOT_FOUND')).toBe('notFound');
    expect(sendResultMessageKey(400, undefined)).toBe('invalid');
    expect(sendResultMessageKey(500, undefined)).toBe('failed');
    expect(sendResultMessageKey(0, undefined)).toBe('failed');
    expect(sendResultMessageKey(409, 'toString')).toBe('notReady');
  });
});

describe('shouldRestoreText', () => {
  it('gives the text back on a refusal or no answer, never after a 5xx', () => {
    expect(shouldRestoreText(409)).toBe(true);
    expect(shouldRestoreText(429)).toBe(true);
    expect(shouldRestoreText(0)).toBe(true);
    expect(shouldRestoreText(500)).toBe(false);
    expect(shouldRestoreText(201)).toBe(false);
  });
});

describe('parseCallSummary / formatDuration', () => {
  it('reads timeline.ts call summaries', () => {
    expect(parseCallSummary('inbound call: answered (75s)')).toEqual({
      direction: 'inbound',
      status: 'answered',
      seconds: 75,
    });
    expect(parseCallSummary('outbound call: missed')).toEqual({
      direction: 'outbound',
      status: 'missed',
      seconds: null,
    });
    expect(parseCallSummary('a note')).toBeNull();
  });

  it('formats talk time', () => {
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(3725)).toBe('1:02:05');
  });
});

describe('parsers', () => {
  it('parseTimeline drops entries without a valid time or kind', () => {
    expect(
      parseTimeline({
        entries: [
          { at: '2026-10-01T08:00:00Z', kind: 'note', summary: 'hi' },
          { at: 'nope', kind: 'note' },
          { at: '2026-10-01T08:00:00Z' },
          null,
        ],
      })
    ).toEqual([
      {
        at: '2026-10-01T08:00:00Z',
        kind: 'note',
        refId: '',
        actor: null,
        summary: 'hi',
        source: '',
      },
    ]);
    expect(parseTimeline(null)).toEqual([]);
  });

  it('parseConversation keeps messages with an id and a time', () => {
    const c = parseConversation({
      groupId: 'g',
      archived: true,
      messages: [{ id: 'm', created_at: '2026-10-01T08:00:00Z' }, { id: 'x' }],
    });
    expect(c.groupId).toBe('g');
    expect(c.archived).toBe(true);
    expect(c.messages.map((m) => m.id)).toEqual(['m']);
    expect(parseConversation(undefined)).toEqual({
      groupId: null,
      archived: false,
      waMode: null,
      messages: [],
    });
  });

  it('parseConversation reads waMode: none, group, anything else null (136)', () => {
    expect(parseConversation({ waMode: 'none' }).waMode).toBe('none');
    expect(parseConversation({ waMode: 'group' }).waMode).toBe('group');
    expect(parseConversation({}).waMode).toBeNull();
    expect(parseConversation({ waMode: 'GROUP' }).waMode).toBeNull();
    expect(parseConversation({ waMode: 1 }).waMode).toBeNull();
  });

  it('parseAuditRows sorts newest first and drops bad rows', () => {
    const rows = parseAuditRows({
      rows: [
        {
          id: '1',
          viewerId: 'u',
          viewerRole: 'admin',
          viewedAt: '2026-10-01T08:00:00Z',
        },
        {
          id: '2',
          viewerId: 'v',
          viewerRole: 'team_lead',
          viewedAt: '2026-10-02T08:00:00Z',
        },
        { id: '3', viewedAt: 'bad' },
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(['2', '1']);
  });
});
