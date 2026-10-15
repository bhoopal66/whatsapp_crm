import { describe, expect, it } from 'vitest';

import {
  buildMeetingBody,
  canJoinMeeting,
  canManageMeeting,
  defaultMeetingForm,
  formatMeetingWhen,
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
      meeting: { inviteeUserIds: [], presentCount: 0 },
      canManage: null,
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
