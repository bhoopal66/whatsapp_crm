import { describe, expect, it } from 'vitest';

import {
  buildMeetingBody,
  canJoinMeeting,
  canManageMeeting,
  defaultMeetingForm,
  durationParts,
  filterMeetings,
  formatMeetingDay,
  formatMeetingWhen,
  groupMeetingsByDay,
  linkifyText,
  meetingDurationMs,
  parseChatMessages,
  meetingDisplayStatus,
  meetingScope,
  meetingScopeParam,
  meetingToForm,
  parseMeeting,
  parseMeetingDetail,
  parseMeetingList,
  resolveMeetingTimeZone,
  zonedWallTimeToInstant,
  type MeetingFormValues,
  type MeetingSummary,
} from './schedule';

const NOW = new Date('2026-10-15T08:10:00Z'); // 12:10 in Dubai
const DUBAI = 'Asia/Dubai';

const form = (over: Partial<MeetingFormValues> = {}): MeetingFormValues => ({
  title: 'Weekly sync',
  description: '',
  date: '2026-10-16',
  time: '14:00',
  durationMinutes: 30,
  inviteeUserIds: [],
  openToWorkspace: false,
  startNow: false,
  ...over,
});

const meeting = (over: Partial<MeetingSummary> = {}): MeetingSummary => ({
  id: 'm1',
  title: 'Weekly sync',
  description: null,
  scheduledStart: '2026-10-15T10:00:00.000Z',
  scheduledEnd: '2026-10-15T10:30:00.000Z',
  hostUserId: 'u-host',
  openToWorkspace: false,
  status: 'scheduled',
  endedAt: null,
  createdAt: '2026-10-14T08:00:00.000Z',
  inviteeUserIds: [],
  presentCount: 0,
  present: [],
  ...over,
});

describe('zonedWallTimeToInstant', () => {
  it('reads a wall-clock time in the given zone', () => {
    expect(
      zonedWallTimeToInstant('2026-10-16', '14:00', DUBAI)?.toISOString()
    ).toBe('2026-10-16T10:00:00.000Z');
    expect(
      zonedWallTimeToInstant('2026-10-16', '14:00', 'UTC')?.toISOString()
    ).toBe('2026-10-16T14:00:00.000Z');
  });

  it('follows a DST change', () => {
    // London: BST (UTC+1) until 25 Oct 2026, GMT after.
    expect(
      zonedWallTimeToInstant(
        '2026-10-24',
        '09:00',
        'Europe/London'
      )?.toISOString()
    ).toBe('2026-10-24T08:00:00.000Z');
    expect(
      zonedWallTimeToInstant(
        '2026-10-26',
        '09:00',
        'Europe/London'
      )?.toISOString()
    ).toBe('2026-10-26T09:00:00.000Z');
  });

  it('refuses a time a DST change skips, and malformed input', () => {
    // 29 Mar 2026: London clocks jump 01:00 → 02:00.
    expect(
      zonedWallTimeToInstant('2026-03-29', '01:30', 'Europe/London')
    ).toBeNull();
    expect(zonedWallTimeToInstant('2026-02-30', '10:00', DUBAI)).toBeNull();
    expect(zonedWallTimeToInstant('16/10/2026', '10:00', DUBAI)).toBeNull();
    expect(zonedWallTimeToInstant('2026-10-16', '24:00', DUBAI)).toBeNull();
  });
});

describe('buildMeetingBody', () => {
  const opts = { timeZone: DUBAI, now: NOW };

  it('turns date + time + duration into ISO start and end', () => {
    expect(
      buildMeetingBody(
        form({
          title: '  Weekly sync ',
          description: ' Agenda ',
          inviteeUserIds: ['a', 'b', 'a'],
          openToWorkspace: true,
          durationMinutes: 45,
        }),
        opts
      )
    ).toEqual({
      ok: true,
      body: {
        title: 'Weekly sync',
        description: 'Agenda',
        scheduledStart: '2026-10-16T10:00:00.000Z',
        scheduledEnd: '2026-10-16T10:45:00.000Z',
        inviteeUserIds: ['a', 'b'],
        openToWorkspace: true,
      },
    });
  });

  it('sends no times for Start now, whatever the date fields hold', () => {
    const r = buildMeetingBody(
      form({ startNow: true, date: '', time: '', durationMinutes: 0 }),
      opts
    );
    expect(r).toMatchObject({
      ok: true,
      body: { scheduledStart: null, scheduledEnd: null, description: null },
    });
  });

  it('names every problem by its message key', () => {
    expect(
      buildMeetingBody(
        form({ title: '   ', date: '', time: '', durationMinutes: 0 }),
        opts
      )
    ).toEqual({
      ok: false,
      errors: [
        'titleRequired',
        'dateRequired',
        'timeRequired',
        'durationInvalid',
      ],
    });
    expect(
      buildMeetingBody(
        form({ title: 'x'.repeat(201), description: 'y'.repeat(2001) }),
        opts
      )
    ).toEqual({ ok: false, errors: ['titleTooLong', 'descriptionTooLong'] });
    expect(buildMeetingBody(form({ date: '2026-02-30' }), opts)).toEqual({
      ok: false,
      errors: ['invalidDateTime'],
    });
    expect(
      buildMeetingBody(form({ durationMinutes: 24 * 60 + 1 }), opts)
    ).toEqual({ ok: false, errors: ['durationInvalid'] });
  });

  it('refuses a start in the past, past a short grace, unless editing', () => {
    // 12:00 Dubai is 10 minutes before NOW.
    const past = form({ date: '2026-10-15', time: '12:00' });
    expect(buildMeetingBody(past, opts)).toEqual({
      ok: false,
      errors: ['startInPast'],
    });
    expect(
      buildMeetingBody(form({ date: '2026-10-15', time: '12:06' }), opts).ok
    ).toBe(true);
    expect(buildMeetingBody(past, { ...opts, allowPast: true }).ok).toBe(true);
  });
});

describe('form defaults', () => {
  it('starts at the next half hour in the zone', () => {
    expect(defaultMeetingForm(NOW, DUBAI)).toMatchObject({
      date: '2026-10-15',
      time: '12:30',
      durationMinutes: 30,
      startNow: false,
    });
    // Exactly on the half hour moves to the next one.
    expect(
      defaultMeetingForm(new Date('2026-10-15T08:30:00Z'), DUBAI).time
    ).toBe('13:00');
  });

  it('fills the Edit dialog from a meeting, round-tripping its times', () => {
    const m = meeting({ inviteeUserIds: ['a'], openToWorkspace: true });
    const values = meetingToForm(m, NOW, DUBAI);
    expect(values).toMatchObject({
      date: '2026-10-15',
      time: '14:00',
      durationMinutes: 30,
      inviteeUserIds: ['a'],
      openToWorkspace: true,
      startNow: false,
    });
    const built = buildMeetingBody(values, {
      timeZone: DUBAI,
      now: NOW,
      allowPast: true,
    });
    expect(built).toMatchObject({
      ok: true,
      body: {
        scheduledStart: m.scheduledStart,
        scheduledEnd: m.scheduledEnd,
      },
    });
    expect(
      meetingToForm(
        meeting({ scheduledStart: null, scheduledEnd: null }),
        NOW,
        DUBAI
      ).startNow
    ).toBe(true);
  });
});

describe('meetingDisplayStatus / meetingScope', () => {
  it.each([
    [
      'cancelled wins over people present',
      { status: 'cancelled', presentCount: 2 },
      'cancelled',
      'past',
    ],
    ['ended', { status: 'ended' }, 'ended', 'past'],
    [
      'someone present is live, even early',
      { presentCount: 1 },
      'live',
      'live',
    ],
    ['before its start', {}, 'scheduled', 'upcoming'],
    [
      'inside its window with nobody in',
      {
        scheduledStart: '2026-10-15T08:00:00.000Z',
        scheduledEnd: '2026-10-15T09:00:00.000Z',
      },
      'due',
      'upcoming',
    ],
    [
      'its window gone with nobody in',
      {
        scheduledStart: '2026-10-15T07:00:00.000Z',
        scheduledEnd: '2026-10-15T08:05:00.000Z',
      },
      'lapsed',
      'past',
    ],
    [
      'an instant meeting waiting for people',
      {
        scheduledStart: null,
        scheduledEnd: null,
        createdAt: '2026-10-15T08:00:00.000Z',
      },
      'due',
      'upcoming',
    ],
    [
      // As the API's meetingPhase: it stays on Upcoming until ended.
      'an instant meeting nobody used for a week',
      {
        scheduledStart: null,
        scheduledEnd: null,
        createdAt: '2026-10-08T08:00:00.000Z',
      },
      'due',
      'upcoming',
    ],
  ] as const)('%s', (_name, over, status, scope) => {
    const m = meeting(over as Partial<MeetingSummary>);
    expect(meetingDisplayStatus(m, NOW)).toBe(status);
    expect(meetingScope(m, NOW)).toBe(scope);
  });

  it('lets people join only a meeting still scheduled', () => {
    expect(canJoinMeeting(meeting())).toBe(true);
    expect(canJoinMeeting(meeting({ status: 'ended' }))).toBe(false);
    expect(canJoinMeeting(meeting({ status: 'cancelled' }))).toBe(false);
  });
});

describe('canManageMeeting', () => {
  const m = meeting();
  it('lets the host, an admin and an owner manage', () => {
    expect(canManageMeeting('agent', 'u-host', m)).toBe(true);
    expect(canManageMeeting('viewer', 'u-host', m)).toBe(true);
    expect(canManageMeeting('admin', 'u-other', m)).toBe(true);
    expect(canManageMeeting('owner', 'u-other', m)).toBe(true);
  });
  it('refuses everyone else, and while the role loads', () => {
    expect(canManageMeeting('team_leader', 'u-other', m)).toBe(false);
    expect(canManageMeeting('agent', 'u-other', m)).toBe(false);
    expect(canManageMeeting(null, 'u-host', m)).toBe(false);
    expect(canManageMeeting('agent', null, m)).toBe(false);
  });
});

describe('formatMeetingWhen', () => {
  it('shows the day and the time range in the zone', () => {
    expect(
      formatMeetingWhen(meeting(), { locale: 'en-GB', timeZone: DUBAI })
    ).toBe('Thu 15 Oct, 14:00 – 14:30');
  });
  it('is null for an instant meeting', () => {
    expect(
      formatMeetingWhen(meeting({ scheduledStart: null }), {
        locale: 'en',
        timeZone: DUBAI,
      })
    ).toBeNull();
  });
});

describe('parsing', () => {
  it('reads a list row with its invitee ids and present count', () => {
    expect(
      parseMeeting({
        id: 'm1',
        title: 'Sync',
        description: null,
        scheduled_start: '2026-10-15T10:00:00.000Z',
        scheduled_end: '2026-10-15T10:30:00.000Z',
        host_user_id: 'u-host',
        open_to_workspace: true,
        status: 'scheduled',
        ended_at: null,
        created_at: '2026-10-14T08:00:00.000Z',
        invitee_user_ids: ['a', 'b', 5, ''],
        present_count: 3,
      })
    ).toEqual(
      meeting({
        title: 'Sync',
        openToWorkspace: true,
        inviteeUserIds: ['a', 'b'],
        presentCount: 3,
      })
    );
  });

  it('drops what is not a meeting, and defaults the rest', () => {
    expect(parseMeeting(null)).toBeNull();
    expect(parseMeeting({ id: 'm1' })).toBeNull();
    expect(
      parseMeeting({
        id: 'm1',
        host_user_id: 'h',
        status: 'odd',
        present_count: -1,
      })
    ).toMatchObject({
      status: 'scheduled',
      presentCount: 0,
      inviteeUserIds: [],
    });
    expect(
      parseMeetingList({ meetings: [{ id: 'm1', host_user_id: 'h' }, 5] })
    ).toHaveLength(1);
    expect(parseMeetingList({ error: 'x' })).toEqual([]);
  });

  it('reads the detail response, counting each person in the call once', () => {
    const row = {
      id: 'm1',
      title: 'Sync',
      host_user_id: 'u-host',
      status: 'scheduled',
    };
    expect(
      parseMeetingDetail({
        meeting: row,
        invitee_user_ids: ['a'],
        participants: [{ user_id: 'a' }, { user_id: 'a' }, { user_id: 'b' }],
        can_manage: true,
      })
    ).toMatchObject({
      meeting: { id: 'm1', inviteeUserIds: ['a'], presentCount: 2 },
      canManage: true,
    });
    expect(parseMeetingDetail({ meeting: row })).toMatchObject({
      meeting: { inviteeUserIds: [], presentCount: 0, present: [] },
      canManage: null,
      chatCount: null,
    });
    expect(parseMeetingDetail({ error: 'Meeting not found' })).toBeNull();
    expect(parseMeetingDetail(null)).toBeNull();
  });

  it("shows times in the saved zone, else the viewer's, else UTC", () => {
    expect(resolveMeetingTimeZone('Asia/Dubai', 'Europe/London')).toBe(
      'Asia/Dubai'
    );
    expect(resolveMeetingTimeZone(null, 'Europe/London')).toBe('Europe/London');
    expect(resolveMeetingTimeZone('+04', 'Nowhere/Land')).toBe('UTC');
  });

  it('falls back to Live now for an unknown tab', () => {
    expect(meetingScopeParam('past')).toBe('past');
    expect(meetingScopeParam('nope')).toBe('live');
    expect(meetingScopeParam(undefined)).toBe('live');
  });
});

describe('v2 parsing', () => {
  const row = { id: 'm1', title: 'Sync', host_user_id: 'u-host' };

  it('lists who is in the call, one entry per person, earliest hand up', () => {
    const detail = parseMeetingDetail({
      meeting: row,
      participants: [
        { user_id: 'a', hand_raised_at: null },
        { user_id: 'b', hand_raised_at: '2026-10-15T08:05:00Z' },
        { user_id: 'a', hand_raised_at: '2026-10-15T08:07:00Z' },
        { user_id: 'b', hand_raised_at: '2026-10-15T08:01:00Z' },
        { hand_raised_at: 'x' },
      ],
      chat_count: 12,
    });
    expect(detail?.meeting.present).toEqual([
      { userId: 'a', handRaisedAt: '2026-10-15T08:07:00Z' },
      { userId: 'b', handRaisedAt: '2026-10-15T08:01:00Z' },
    ]);
    expect(detail?.meeting.presentCount).toBe(2);
    expect(detail?.chatCount).toBe(12);
  });

  it('tolerates an API without hands, participants or chat_count', () => {
    expect(
      parseMeetingDetail({ meeting: row, participants: [{ user_id: 'a' }] })
    ).toMatchObject({
      meeting: { present: [{ userId: 'a', handRaisedAt: null }] },
      chatCount: null,
    });
    expect(
      parseMeetingDetail({ meeting: row, chat_count: -3 })?.chatCount
    ).toBe(null);
    // A list row with only a count keeps the count and names nobody.
    expect(parseMeeting({ ...row, present_count: 3 })).toMatchObject({
      presentCount: 3,
      present: [],
    });
    expect(
      parseMeeting({ ...row, participants: [{ user_id: 'z' }] })
    ).toMatchObject({ presentCount: 1, present: [{ userId: 'z' }] });
  });

  it('reads chat lines oldest first, skipping reactions and junk', () => {
    expect(
      parseChatMessages({
        messages: [
          {
            id: '2',
            user_id: 'a',
            kind: 'chat',
            body: 'later',
            created_at: '2026-10-15T08:02:00Z',
          },
          {
            id: '1',
            user_id: 'b',
            kind: 'chat',
            body: 'first',
            created_at: '2026-10-15T08:01:00Z',
          },
          {
            id: '3',
            user_id: 'b',
            kind: 'reaction',
            body: '👍',
            created_at: '2026-10-15T08:03:00Z',
          },
          {
            id: '4',
            user_id: 'b',
            kind: 'chat',
            created_at: '2026-10-15T08:04:00Z',
          },
          null,
        ],
      }).map((l) => l.id)
    ).toEqual(['1', '2']);
    expect(parseChatMessages({ error: 'Forbidden' })).toEqual([]);
  });
});

describe('groupMeetingsByDay', () => {
  // NOW is 12:10 on 15 Oct in Dubai.
  const at = (id: string, start: string | null) =>
    meeting({ id, scheduledStart: start, scheduledEnd: null });

  it('puts instant meetings first, then Today, Tomorrow and dates', () => {
    const groups = groupMeetingsByDay(
      [
        at('instant', null),
        at('today', '2026-10-15T10:00:00Z'),
        at('late-today', '2026-10-15T19:59:00Z'), // 23:59 Dubai
        at('tomorrow', '2026-10-15T20:00:00Z'), // 00:00 on the 16th
        at('later', '2026-10-20T06:00:00Z'),
      ],
      NOW,
      DUBAI
    );
    expect(
      groups.map((g) => [g.kind, g.date, g.meetings.map((m) => m.id)])
    ).toEqual([
      ['unscheduled', null, ['instant']],
      ['today', '2026-10-15', ['today', 'late-today']],
      ['tomorrow', '2026-10-16', ['tomorrow']],
      ['date', '2026-10-20', ['later']],
    ]);
  });

  it('reads the day in the given zone, not UTC', () => {
    // 21:00 UTC on the 15th is already the 16th in Dubai.
    const late = at('x', '2026-10-15T21:00:00Z');
    expect(groupMeetingsByDay([late], NOW, DUBAI)[0].kind).toBe('tomorrow');
    expect(groupMeetingsByDay([late], NOW, 'UTC')[0].kind).toBe('today');
  });

  it('rolls Tomorrow over a month end', () => {
    const now = new Date('2026-10-31T10:00:00Z');
    const g = groupMeetingsByDay(
      [at('nov', '2026-11-01T10:00:00Z')],
      now,
      'UTC'
    );
    expect(g[0]).toMatchObject({ kind: 'tomorrow', date: '2026-11-01' });
  });

  it('formats a day heading without shifting the date', () => {
    expect(formatMeetingDay('2026-10-20', 'en-GB')).toBe('Tuesday 20 October');
  });
});

describe('filterMeetings', () => {
  const names: Record<string, string> = {
    'u-host': 'Sara Ahmed',
    'u-ali': 'Ali Khan',
  };
  const nameOf = (id: string) => names[id] ?? null;
  const list = [
    meeting({ id: 'a', title: 'Weekly sync' }),
    meeting({ id: 'b', title: 'Bank review', inviteeUserIds: ['u-ali'] }),
    meeting({ id: 'c', title: 'Plan', description: 'Budget for Q4' }),
  ];
  const ids = (q: string) => filterMeetings(list, q, nameOf).map((m) => m.id);

  it('matches title, description and people, case-insensitively', () => {
    expect(ids('')).toEqual(['a', 'b', 'c']);
    expect(ids('  ')).toEqual(['a', 'b', 'c']);
    expect(ids('SYNC')).toEqual(['a']);
    expect(ids('budget')).toEqual(['c']);
    expect(ids('ali')).toEqual(['b']);
    expect(ids('sara')).toEqual(['a', 'b', 'c']);
  });

  it('needs every word to match', () => {
    expect(ids('bank ali')).toEqual(['b']);
    expect(ids('bank budget')).toEqual([]);
  });
});

describe('meeting duration', () => {
  it('measures an ended meeting from its start to its end', () => {
    expect(
      meetingDurationMs(
        meeting({ status: 'ended', endedAt: '2026-10-15T10:45:00.000Z' })
      )
    ).toBe(45 * 60_000);
  });

  it('measures an instant meeting from its creation', () => {
    expect(
      meetingDurationMs(
        meeting({
          status: 'ended',
          scheduledStart: null,
          scheduledEnd: null,
          createdAt: '2026-10-15T09:00:00.000Z',
          endedAt: '2026-10-15T10:05:00.000Z',
        })
      )
    ).toBe(65 * 60_000);
  });

  it('has none for a meeting that was not ended, or ended before it began', () => {
    expect(meetingDurationMs(meeting({ status: 'cancelled' }))).toBeNull();
    expect(meetingDurationMs(meeting({ status: 'scheduled' }))).toBeNull();
    expect(
      meetingDurationMs(
        meeting({ status: 'ended', endedAt: '2026-10-15T09:00:00.000Z' })
      )
    ).toBeNull();
  });

  it('splits into hours and minutes, at least one minute', () => {
    expect(durationParts(65 * 60_000)).toEqual({ hours: 1, minutes: 5 });
    expect(durationParts(45 * 60_000 + 29_000)).toEqual({
      hours: 0,
      minutes: 45,
    });
    expect(durationParts(10_000)).toEqual({ hours: 0, minutes: 1 });
    expect(durationParts(120 * 60_000)).toEqual({ hours: 2, minutes: 0 });
  });
});

describe('linkifyText', () => {
  it('splits http(s) links out of plain text', () => {
    expect(linkifyText('see https://example.com/a?b=1, then go')).toEqual([
      { kind: 'text', text: 'see ' },
      {
        kind: 'link',
        text: 'https://example.com/a?b=1',
        href: 'https://example.com/a?b=1',
      },
      { kind: 'text', text: ', then go' },
    ]);
  });

  it('leaves other schemes and markup as text', () => {
    const text = 'javascript:alert(1) <a href="x">x</a> mailto:a@b.c';
    expect(linkifyText(text)).toEqual([{ kind: 'text', text }]);
  });

  it('drops trailing punctuation from a link', () => {
    expect(linkifyText('(http://a.io).')).toEqual([
      { kind: 'text', text: '(' },
      { kind: 'link', text: 'http://a.io', href: 'http://a.io/' },
      { kind: 'text', text: ').' },
    ]);
  });

  it('returns nothing for empty text', () => {
    expect(linkifyText('')).toEqual([]);
  });
});
