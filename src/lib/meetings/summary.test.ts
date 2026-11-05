import { describe, expect, it } from 'vitest';

import { NOTES_MAX } from './requests';
import {
  attendanceCsvText,
  attendanceFileName,
  groupInvited,
  meetingRanMs,
  notesSaveOutcome,
  notesTooLong,
  parseAttendance,
  parseNotesRead,
  rejoinCount,
} from './summary';

const row = {
  user_id: 'b',
  first_joined_at: '2026-11-05T09:10:00.000Z',
  last_left_at: null,
  total_ms: 60_000,
  seats: 3,
  removed: true,
};
const labels = {
  name: 'Name',
  joined: 'Joined',
  left: 'Left',
  minutes: 'Minutes',
  seats: 'Seats',
  removed: 'Removed',
  stillPresent: 'Still here',
  yes: 'Yes',
};
const ended = {
  status: 'ended' as const,
  scheduledStart: '2026-11-05T09:00:00.000Z',
  endedAt: '2026-11-05T17:00:00.000Z',
  createdAt: null,
};

describe('parseAttendance', () => {
  it('maps snake to camel and sorts by first joined', () => {
    const early = {
      ...row,
      user_id: 'a',
      first_joined_at: '2026-11-05T09:00:00Z',
    };
    const parsed = parseAttendance({
      attendance: [row, early],
      summary: { people: 2, started_at: 's', ended_at: null, longest_ms: 5 },
    });
    expect(parsed?.entries.map((e) => e.userId)).toEqual(['a', 'b']);
    expect(parsed?.entries[1]).toEqual({
      userId: 'b',
      firstJoinedAt: row.first_joined_at,
      lastLeftAt: null,
      totalMs: 60_000,
      seats: 3,
      removed: true,
    });
    expect(parsed).toMatchObject({ people: 2, startedAt: 's', endedAt: null });
  });

  it('refuses another shape', () => {
    expect(parseAttendance({ error: 'x' })).toBeNull();
    expect(parseAttendance(null)).toBeNull();
  });
});

describe('meetingRanMs', () => {
  const read = { entries: [], people: 2, startedAt: null, endedAt: null };

  it('prefers when people were really in the room', () => {
    const ms = meetingRanMs(
      {
        ...read,
        startedAt: '2026-11-05T09:05:00.000Z',
        endedAt: '2026-11-05T09:50:00.000Z',
      },
      ended
    );
    expect(ms).toBe(45 * 60_000);
  });

  it("falls back to the row's figure without a read", () => {
    expect(meetingRanMs(null, ended)).toBe(8 * 3_600_000);
    expect(meetingRanMs(read, ended)).toBe(8 * 3_600_000);
  });

  it('is nothing when nobody came', () => {
    expect(meetingRanMs({ ...read, people: 0 }, ended)).toBeNull();
  });
});

describe('groupInvited', () => {
  it('splits invitees by who came, ignoring uninvited attendees', () => {
    expect(
      groupInvited(['a', 'b', 'b', 'c'], [{ userId: 'c' }, { userId: 'x' }])
    ).toEqual({ attended: ['c'], noShow: ['a', 'b'] });
  });
});

describe('rejoinCount', () => {
  it('does not count the first seat', () => {
    expect(rejoinCount({ seats: 1 })).toBe(0);
    expect(rejoinCount({ seats: 3 })).toBe(2);
  });
});

describe('attendanceCsvText', () => {
  it('opens with a BOM, once, ahead of the heading', () => {
    const entries = parseAttendance({ attendance: [row] })?.entries ?? [];
    const text = attendanceCsvText(entries, () => '=سارة', labels);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1, 5)).toBe('Name');
    expect(text).toContain("'=سارة");
  });
});

describe('attendanceFileName', () => {
  it('keeps letters of any script and has a fallback', () => {
    expect(attendanceFileName('October / Review')).toBe(
      'october-review-attendance.csv'
    );
    expect(attendanceFileName('회의')).toBe('회의-attendance.csv');
    expect(attendanceFileName('...')).toBe('meeting-attendance.csv');
  });
});

describe('notes', () => {
  it('reads a missing table and an empty row', () => {
    expect(parseNotesRead({ notes: null, available: false })).toMatchObject({
      available: false,
      notes: { body: '', version: 0 },
    });
    expect(parseNotesRead({})).toBeNull();
  });

  it('turns each PUT answer into an outcome', () => {
    expect(
      notesSaveOutcome(
        200,
        { version: 4, updated_at: 't', updated_by: 'u' },
        'typed'
      )
    ).toEqual({
      kind: 'saved',
      notes: { body: 'typed', version: 4, updatedBy: 'u', updatedAt: 't' },
    });
    expect(
      notesSaveOutcome(
        409,
        {
          error: 'stale',
          notes: {
            body: 'theirs',
            version: 7,
            updated_by: null,
            updated_at: 't',
          },
        },
        'mine'
      )
    ).toEqual({
      kind: 'stale',
      latest: { body: 'theirs', version: 7, updatedBy: null, updatedAt: 't' },
    });
    expect(notesSaveOutcome(409, { error: 'meeting_closed' }, 'x').kind).toBe(
      'closed'
    );
    expect(notesSaveOutcome(400, { error: 'long' }, 'x').kind).toBe('tooLong');
    expect(notesSaveOutcome(500, null, 'x').kind).toBe('failed');
  });

  it('counts code points as the server does', () => {
    expect(notesTooLong('😀'.repeat(NOTES_MAX))).toBe(false);
    expect(notesTooLong('a'.repeat(NOTES_MAX + 1))).toBe(true);
  });
});
