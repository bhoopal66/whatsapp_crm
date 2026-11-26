import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingCallEngine } from '@/hooks/use-meeting-call';

import {
  lateRecordingNotices,
  meetingFlagNotices,
  RECORDING_ABSENT_GRACE_MS as GRACE,
  recordingFailure,
  recordingFlagOf,
  stepRecordingView,
  type RecordingMemo,
} from './recording';
import { noticeToast, batchTone, showsToast } from '../room-ui/panels';
import {
  JOIN_TONE,
  LEAVE_TONE,
  RECORD_TONE,
} from '@/components/meetings/room/room-sounds';
import type { RoomNotice } from './contract';

const db = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  selected: [] as string[],
  onMeetingUpdate: null as ((p: { new: unknown }) => void) | null,
  onStatus: null as ((status: string) => void) | null,
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = (cols: string) => (db.selected.push(cols), q);
      q.eq = () => q;
      q.is = async () => ({ data: [], error: null });
      q.maybeSingle = async () => ({ data: db.row, error: null });
      return q;
    },
    channel: () => {
      const c: Record<string, unknown> = {};
      c.on = (
        _kind: string,
        spec: { table: string; event: string },
        fn: (p: { new: unknown }) => void
      ) => {
        if (spec.table === 'meetings') db.onMeetingUpdate = fn;
        return c;
      };
      c.subscribe = (fn: (status: string) => void) => ((db.onStatus = fn), c);
      return c;
    },
    removeChannel: async () => {},
  }),
}));

const ROW = {
  id: 'm',
  title: 'Weekly',
  status: 'scheduled',
  host_user_id: 'h',
};
const flag = { userId: 'u', startedAt: '2026-11-05T10:00:00.000Z' };
const T = 1_000_000;

const step = (
  memo: RecordingMemo | null,
  recorderPresent: boolean,
  nowMs: number,
  f: typeof flag | null = flag
) => stepRecordingView(memo, { flag: f, recorderPresent, nowMs });

describe('stepRecordingView', () => {
  it('shows the flag while the recorder is present', () => {
    expect(step(null, true, T).recording).toEqual(flag);
  });

  it('keeps showing it through the grace, then hides it', () => {
    const present = step(null, true, T).memo;
    const gone = step(present, false, T + 1000);
    expect(gone.recording).toEqual(flag);
    const late = step(gone.memo, false, T + 1000 + GRACE - 1);
    expect(late.recording).toEqual(flag);
    expect(step(late.memo, false, T + 1000 + GRACE).recording).toBeNull();
  });

  it('hides a cleared flag at once, whatever the clock says', () => {
    const r = step(step(null, true, T).memo, true, T + 1, null);
    expect(r).toEqual({ memo: null, recording: null });
  });

  it('a recorder back inside the grace resets the clock', () => {
    const gone = step(step(null, true, T).memo, false, T);
    const back = step(gone.memo, true, T + GRACE - 1);
    expect(back.recording).toEqual(flag);
    const again = step(back.memo, false, T + GRACE);
    expect(again.recording).toEqual(flag);
    expect(step(again.memo, false, T + 2 * GRACE - 1).recording).toEqual(flag);
  });

  it('a flag whose recorder was never seen starts the same clock', () => {
    const first = step(null, false, T);
    expect(first.recording).toEqual(flag);
    expect(step(first.memo, false, T + GRACE - 1).recording).toEqual(flag);
    expect(step(first.memo, false, T + GRACE).recording).toBeNull();
  });

  it('a new recording does not inherit the old one’s clock', () => {
    const old = step(null, false, T);
    const next = { userId: 'v', startedAt: '2026-11-05T11:00:00.000Z' };
    expect(step(old.memo, false, T + GRACE, next).recording).toEqual(next);
  });

  it('reads the same instant in another format as the same recording', () => {
    const old = step(null, false, T);
    const same = { ...flag, startedAt: '2026-11-05T10:00:00+00:00' };
    expect(step(old.memo, false, T + GRACE, same).recording).toBeNull();
  });
});

describe('meetingFlagNotices', () => {
  const on = {
    recording_started_at: '2026-11-05T10:00:00.123Z',
    recording_by: 'u',
  };

  it('raises nothing at first load, whatever the row says', () => {
    expect(
      meetingFlagNotices(null, { ...on, locked_at: '2026-11-05T10:00:00Z' })
    ).toEqual([]);
  });

  it('raises each transition', () => {
    expect(meetingFlagNotices({}, on)).toEqual([
      { kind: 'recording_started', userId: 'u' },
    ]);
    expect(
      meetingFlagNotices(on, { recording_started_at: null, recording_by: null })
    ).toEqual([{ kind: 'recording_stopped' }]);
    expect(meetingFlagNotices({}, { locked_at: 'x' })).toEqual([
      { kind: 'meeting_locked' },
    ]);
    expect(meetingFlagNotices({ locked_at: 'x' }, { locked_at: null })).toEqual(
      [{ kind: 'meeting_unlocked' }]
    );
  });

  it('a column a database does not have is no change', () => {
    expect(meetingFlagNotices({}, {})).toEqual([]);
    expect(recordingFlagOf({})).toBeNull();
    expect(meetingFlagNotices({ locked_at: null }, {})).toEqual([]);
  });

  it('the same recording in the database’s format is no transition', () => {
    expect(
      meetingFlagNotices(on, {
        ...on,
        recording_started_at: '2026-11-05T10:00:00.123+00:00',
      })
    ).toEqual([]);
  });

  it('a different recording is announced', () => {
    expect(
      meetingFlagNotices(on, {
        recording_started_at: '2026-11-05T10:05:00Z',
        recording_by: 'v',
      })
    ).toEqual([{ kind: 'recording_started', userId: 'v' }]);
  });
});

describe('lateRecordingNotices', () => {
  const draft = { kind: 'recording_started', userId: 'u' };

  it('announces a recording nobody told us about', () => {
    expect(lateRecordingNotices(null, flag, 'me')).toEqual({
      announced: flag,
      drafts: [draft],
    });
  });

  it('stays quiet for one already announced, by instant', () => {
    const same = { ...flag, startedAt: '2026-11-05T14:00:00.000+04:00' };
    expect(lateRecordingNotices(flag, same, 'me').drafts).toEqual([]);
  });

  it('announces a newer recording after an older one', () => {
    const next = { userId: 'u', startedAt: '2026-11-05T11:00:00.000Z' };
    expect(lateRecordingNotices(flag, next, 'me').drafts).toEqual([draft]);
  });

  it('stays quiet for our own, and with nothing recording', () => {
    expect(lateRecordingNotices(null, flag, 'u')).toEqual({
      announced: flag,
      drafts: [],
    });
    expect(lateRecordingNotices(flag, null, 'me')).toEqual({
      announced: flag,
      drafts: [],
    });
  });
});

describe('recordingFailure', () => {
  it('names the two refusals the screen words differently', () => {
    expect(recordingFailure(409, { error: 'already_recording' })).toBe(
      'already_recording'
    );
    expect(recordingFailure(503, { error: 'migration_required' })).toBe(
      'unavailable'
    );
  });

  it('anything else failed', () => {
    expect(recordingFailure(409, { error: 'closed' })).toBe('failed');
    expect(recordingFailure(0, null)).toBe('failed');
  });
});

describe('recording notices are not a preference', () => {
  const n = (kind: 'recording_started' | 'recording_stopped'): RoomNotice =>
    kind === 'recording_started'
      ? { id: '1', kind, userId: 'u' }
      : { id: '1', kind };
  const joined = noticeToast({ id: '2', kind: 'joined', userId: 'u' });
  const left = noticeToast({ id: '3', kind: 'left', userId: 'u' });

  it.each(['recording_started', 'recording_stopped'] as const)(
    '%s shows off the room page and plays with the sounds off',
    (kind) => {
      const nt = noticeToast(n(kind));
      expect(showsToast(nt, true)).toBe(true);
      expect(batchTone([nt], false)).toBe('record');
    }
  );

  it('its tone wins a batch, wherever it falls', () => {
    const nt = noticeToast(n('recording_started'));
    expect(batchTone([nt, joined], true)).toBe('record');
    expect(batchTone([joined, nt], false)).toBe('record');
  });

  it('join and leave keep their switches', () => {
    expect(showsToast(joined, true)).toBe(false);
    expect(showsToast(joined, false)).toBe(true);
    expect(batchTone([joined, left], false)).toBeNull();
    expect(batchTone([joined, left], true)).toBe('leave');
  });

  it('the recording tone is its own', () => {
    expect(RECORD_TONE).not.toEqual(JOIN_TONE);
    expect(RECORD_TONE).not.toEqual(LEAVE_TONE);
  });
});

// The engine itself, without media: the private seams are what a live
// call would drive, since node has no RTCPeerConnection.
interface Seams {
  loadMeeting(): Promise<void>;
  subscribeRows(): Promise<void>;
  reconnect(): Promise<void>;
  connectionFailed(): void;
  participantId: string | null;
  attached: boolean;
}

describe('MeetingCallEngine host flags', () => {
  const fetchMock = vi.fn();
  const answer = (status: number, body: unknown) =>
    fetchMock.mockResolvedValue({
      ok: status < 400,
      status,
      json: async () => body,
    });
  const sent = () =>
    fetchMock.mock.calls.map(([url, init]) => [
      String(url).split('/').pop(),
      init?.body && JSON.parse(init.body),
    ]);

  async function engine(row: Record<string, unknown> = ROW) {
    db.row = row;
    const e = new MeetingCallEngine('m');
    const seams = e as unknown as Seams;
    await seams.loadMeeting();
    await seams.subscribeRows();
    return { e, seams };
  }
  const kinds = (e: MeetingCallEngine) =>
    e.getSnapshot().notices.map((n) => n.kind);
  const settle = () => new Promise((r) => setTimeout(r));

  beforeEach(() => {
    db.selected = [];
    fetchMock.mockReset();
    answer(200, {});
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('first load reads every column and raises nothing', async () => {
    const { e } = await engine({
      ...ROW,
      locked_at: '2026-11-05T10:00:00Z',
      recording_started_at: flag.startedAt,
      recording_by: 'u',
    });
    expect(db.selected[0]).toBe('*');
    expect(e.getSnapshot().locked).toBe(true);
    expect(e.getSnapshot().recording).toEqual(flag);
    expect(e.getSnapshot().notices).toEqual([]);
  });

  it('a database without 176 reads as unlocked and not recording', async () => {
    const { e } = await engine();
    expect(e.getSnapshot().meetingState).toBe('ready');
    expect(e.getSnapshot().locked).toBe(false);
    expect(e.getSnapshot().recording).toBeNull();
  });

  it('merges a realtime row, so a rename shows at once', async () => {
    const { e } = await engine();
    db.onMeetingUpdate?.({ new: { ...ROW, title: 'Renamed' } });
    expect(e.getSnapshot().meeting?.title).toBe('Renamed');
    expect(e.getSnapshot().notices).toEqual([]);
  });

  it('an ended meeting ends the call and merges nothing', async () => {
    const { e } = await engine();
    db.onMeetingUpdate?.({ new: { ...ROW, title: 'X', status: 'ended' } });
    expect(e.getSnapshot().phase).toBe('ended');
    expect(e.getSnapshot().meeting?.title).toBe('Weekly');
  });

  it('own lock: the answer shows it, realtime raises no second notice', async () => {
    const { e } = await engine();
    answer(200, { ok: true, locked_at: '2026-11-05T10:00:00.123Z' });
    expect(await e.setLocked(true)).toBe('ok');
    expect(e.getSnapshot().locked).toBe(true);
    db.onMeetingUpdate?.({
      new: { ...ROW, locked_at: '2026-11-05T10:00:00.123+00:00' },
    });
    expect(kinds(e)).toEqual(['meeting_locked']);
  });

  it('own recording: one notice whichever lands first', async () => {
    const started = '2026-11-05T10:00:00.123Z';
    const event = {
      new: {
        ...ROW,
        recording_started_at: '2026-11-05T10:00:00.123+00:00',
        recording_by: 'u',
      },
    };
    answer(200, { ok: true, recording_started_at: started, recording_by: 'u' });

    const first = await engine();
    expect(await first.e.setRecordingFlag(true)).toBe('ok');
    db.onMeetingUpdate?.(event);
    expect(kinds(first.e)).toEqual(['recording_started']);

    const second = await engine();
    db.onMeetingUpdate?.(event);
    expect(await second.e.setRecordingFlag(true)).toBe('ok');
    expect(kinds(second.e)).toEqual(['recording_started']);
  });

  it('a recording begun while the channel was down is announced', async () => {
    const { e } = await engine();
    db.row = {
      ...ROW,
      recording_started_at: flag.startedAt,
      recording_by: 'u',
    };
    db.onStatus?.('SUBSCRIBED');
    await settle();
    expect(e.getSnapshot().recording).toEqual(flag);
    expect(kinds(e)).toEqual(['recording_started']);
  });

  it('a clear shows at once, without waiting for a plan', async () => {
    const { e } = await engine({
      ...ROW,
      recording_started_at: flag.startedAt,
      recording_by: 'u',
    });
    answer(200, { ok: true, recording_started_at: null, recording_by: null });
    expect(await e.setRecordingFlag(false)).toBe('ok');
    expect(e.getSnapshot().recording).toBeNull();
    expect(kinds(e)).toEqual(['recording_stopped']);
  });

  it('a lock the server refused for another reason says it failed', async () => {
    const { e } = await engine();
    answer(500, { error: 'boom' });
    expect(await e.setLocked(true)).toBe('failed');
    expect(e.getSnapshot().locked).toBe(false);
  });

  it('a refused action changes nothing', async () => {
    const { e } = await engine();
    answer(503, { error: 'migration_required' });
    expect(await e.setLocked(true)).toBe('unavailable');
    expect(await e.setRecordingFlag(true)).toBe('unavailable');
    expect(await e.moderateAll('mute_all')).toBe(false);
    expect(await e.invite(['u'])).toBeNull();
    expect(e.getSnapshot().locked).toBe(false);
    expect(e.getSnapshot().notices).toEqual([]);
  });

  it('calls the bulk and invite paths', async () => {
    const { e } = await engine();
    answer(200, {
      ok: true,
      count: 3,
      invited: ['u'],
      needs_readmit: ['v'],
    });
    expect(await e.moderateAll('lower_all_hands')).toBe(true);
    expect(await e.invite(['u', 'v'])).toEqual({
      invited: ['u'],
      needsReadmit: ['v'],
    });
    expect(sent()).toEqual([
      ['moderate', { action: 'lower_all_hands' }],
      ['invite', { userIds: ['u', 'v'] }],
    ]);
  });

  it('a reconnect says so; giving up and leaving do not', async () => {
    const { e, seams } = await engine();
    seams.attached = false; // stop after the leave: no rejoin in node
    seams.participantId = 'p1';
    await seams.reconnect();
    seams.participantId = 'p2';
    seams.connectionFailed();
    seams.participantId = 'p3';
    await e.leave();
    expect(sent()).toEqual([
      ['leave', { participantId: 'p1', reconnecting: true }],
      ['leave', { participantId: 'p2' }],
      ['leave', { participantId: 'p3' }],
    ]);
  });
});
