import { describe, expect, it } from 'vitest';

import {
  diffInvitees,
  isPresent,
  meetingPhase,
  parseCreateMeeting,
  parseMeetingPatch,
  parseScope,
} from './requests';

const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const U2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('parseCreateMeeting', () => {
  it('trims, normalises times to UTC and dedupes invitees', () => {
    const r = parseCreateMeeting({
      title: '  Weekly sync ',
      description: '  ',
      scheduledStart: '2026-10-20T09:00:00+04:00',
      scheduledEnd: '2026-10-20T10:00:00+04:00',
      inviteeUserIds: [U1, U1.toUpperCase(), U2],
      openToWorkspace: true,
    });
    expect(r).toEqual({
      ok: true,
      values: {
        meeting: {
          title: 'Weekly sync',
          description: null,
          scheduled_start: '2026-10-20T05:00:00.000Z',
          scheduled_end: '2026-10-20T06:00:00.000Z',
          open_to_workspace: true,
        },
        inviteeUserIds: [U1, U2],
      },
    });
  });

  it('allows an instant meeting (no times, closed by default)', () => {
    expect(parseCreateMeeting({ title: 'Now' })).toMatchObject({
      ok: true,
      values: {
        meeting: { scheduled_start: null, open_to_workspace: false },
        inviteeUserIds: [],
      },
    });
  });

  it.each([
    [{}, 'Title is required'],
    [{ title: 'x'.repeat(201) }, 'Title must be at most 200 characters'],
    [{ title: 'x', description: 'd'.repeat(2001) }, 'Description must'],
    [{ title: 'x', scheduledStart: '2026-10-20T09:00' }, 'scheduledStart'],
    [{ title: 'x', scheduledEnd: '2026-10-20T09:00Z' }, 'needs a start'],
    [
      {
        title: 'x',
        scheduledStart: '2026-10-20T10:00Z',
        scheduledEnd: '2026-10-20T09:00Z',
      },
      'after the start',
    ],
    [{ title: 'x', inviteeUserIds: ['nope'] }, 'inviteeUserIds'],
    [{ title: 'x', openToWorkspace: 'yes' }, 'openToWorkspace'],
  ])('refuses %j', (body, error) => {
    const r = parseCreateMeeting(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(error);
  });
});

describe('parseMeetingPatch', () => {
  const current = {
    scheduled_start: '2026-10-20T09:00:00.000Z',
    scheduled_end: '2026-10-20T10:00:00.000Z',
  };

  it('changes only the keys sent', () => {
    expect(parseMeetingPatch({ title: ' New ' }, current)).toEqual({
      ok: true,
      values: { meeting: { title: 'New' }, inviteeUserIds: undefined },
    });
  });

  it('checks a moved start against the stored end', () => {
    const r = parseMeetingPatch(
      { scheduledStart: '2026-10-20T11:00:00Z' },
      current
    );
    expect(r).toEqual({
      ok: false,
      error: 'The end time must be after the start time',
    });
  });

  it('takes an invitee list, empty included', () => {
    expect(parseMeetingPatch({ inviteeUserIds: [] }, current)).toMatchObject({
      ok: true,
      values: { inviteeUserIds: [] },
    });
  });

  it('refuses an empty patch', () => {
    expect(parseMeetingPatch({}, current)).toEqual({
      ok: false,
      error: 'Nothing to update',
    });
  });
});

describe('diffInvitees', () => {
  it('inserts the new and deletes the dropped, case-insensitively', () => {
    expect(diffInvitees([U1], [U1.toUpperCase(), U2])).toEqual({
      add: [U2],
      remove: [],
    });
    expect(diffInvitees([U1, U2], [U2])).toEqual({ add: [], remove: [U1] });
  });
});

describe('presence and phase', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');

  it('is present only while not left and heard from within 60 s', () => {
    expect(
      isPresent({ left_at: null, last_seen_at: '2026-10-15T11:59:30Z' }, now)
    ).toBe(true);
    expect(
      isPresent({ left_at: null, last_seen_at: '2026-10-15T11:58:59Z' }, now)
    ).toBe(false);
    expect(
      isPresent(
        {
          left_at: '2026-10-15T11:59:50Z',
          last_seen_at: '2026-10-15T11:59:50Z',
        },
        now
      )
    ).toBe(false);
  });

  it('derives live from presence, past from status or a passed end', () => {
    const scheduled = { status: 'scheduled' as const, scheduled_end: null };
    expect(meetingPhase(scheduled, 1, now)).toBe('live');
    expect(meetingPhase(scheduled, 0, now)).toBe('upcoming');
    expect(
      meetingPhase(
        { status: 'scheduled', scheduled_end: '2026-10-15T11:00:00Z' },
        0,
        now
      )
    ).toBe('past');
    expect(meetingPhase({ status: 'ended', scheduled_end: null }, 2, now)).toBe(
      'past'
    );
  });

  it('defaults the scope to upcoming and refuses unknown ones', () => {
    expect(parseScope(null)).toBe('upcoming');
    expect(parseScope('live')).toBe('live');
    expect(parseScope('all')).toBeNull();
  });
});
