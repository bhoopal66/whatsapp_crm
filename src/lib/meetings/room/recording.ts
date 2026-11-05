// What the room shows of the `meetings` row's host flags: is it locked,
// is someone recording. The columns come from migration 176 and may be
// absent on a database without it, which reads as unlocked and not
// recording, never as an error.

import type { RoomNotice } from './contract';
import type { NoticeDraft } from './notices';

export interface MeetingFlagColumns {
  locked_at?: string | null;
  recording_started_at?: string | null;
  recording_by?: string | null;
}

export interface RecordingFlag {
  /** Empty if the row names nobody: still a recording, and still shown. */
  userId: string;
  startedAt: string;
}

export function recordingFlagOf(
  row: MeetingFlagColumns | null
): RecordingFlag | null {
  if (!row?.recording_started_at) return null;
  return {
    userId: row.recording_by ?? '',
    startedAt: row.recording_started_at,
  };
}

/**
 * By instant, not by text: our own answer says `…:00.123Z` and the
 * realtime event for the same write `…:00.123+00:00`, and one recording
 * must not read as two.
 */
function sameRecording(a: RecordingFlag, b: RecordingFlag): boolean {
  return (
    a.userId === b.userId && Date.parse(a.startedAt) === Date.parse(b.startedAt)
  );
}

/**
 * Notices for one change of the row. `before` null is the first load,
 * which only records how things stand. Comparing values is what dedupes
 * an action of ours: its answer and its realtime event carry the same
 * change, so whichever lands second finds nothing new.
 */
export function meetingFlagNotices(
  before: MeetingFlagColumns | null,
  after: MeetingFlagColumns
): NoticeDraft<RoomNotice>[] {
  if (!before) return [];
  const drafts: NoticeDraft<RoomNotice>[] = [];
  const was = recordingFlagOf(before);
  const now = recordingFlagOf(after);
  // A different recording is a new one: a stop and a start can both fall
  // inside a network blip, and the new one still has to be announced.
  if (now && (!was || !sameRecording(was, now))) {
    drafts.push({ kind: 'recording_started', userId: now.userId });
  } else if (was && !now) {
    drafts.push({ kind: 'recording_stopped' });
  }
  if (!before.locked_at !== !after.locked_at) {
    drafts.push({
      kind: after.locked_at ? 'meeting_locked' : 'meeting_unlocked',
    });
  }
  return drafts;
}

/**
 * How long a recording stays on screen once its recorder is out of the
 * room. A reconnect comes back well inside it, so the indicator never
 * flickers off; a crashed browser cannot clear the flag, so without this
 * limit it would read as recording for ever.
 */
export const RECORDING_ABSENT_GRACE_MS = 90_000;

export interface RecordingMemo {
  flag: RecordingFlag;
  /** When the recorder was first missed; null while they are present. */
  absentSince: number | null;
}

/**
 * What to show of the flag at this plan. Consent errs on the side of
 * showing: only a recorder missing for the whole grace hides it. A flag
 * whose recorder was never seen (we joined after they crashed) starts
 * the same clock, and a new recording starts its own.
 */
export function stepRecordingView(
  memo: RecordingMemo | null,
  input: {
    flag: RecordingFlag | null;
    recorderPresent: boolean;
    nowMs: number;
  }
): { memo: RecordingMemo | null; recording: RecordingFlag | null } {
  const { flag, recorderPresent, nowMs } = input;
  if (!flag) return { memo: null, recording: null };
  if (recorderPresent) {
    return { memo: { flag, absentSince: null }, recording: flag };
  }
  const held = memo && sameRecording(memo.flag, flag) ? memo.absentSince : null;
  const absentSince = held ?? nowMs;
  return {
    memo: { flag, absentSince },
    recording: nowMs - absentSince < RECORDING_ABSENT_GRACE_MS ? flag : null,
  };
}

export type RecordingFlagResult =
  'ok' | 'already_recording' | 'unavailable' | 'failed';

/** What a refused `POST …/recording` means to the screen. */
export function recordingFailure(
  status: number,
  body: unknown
): Exclude<RecordingFlagResult, 'ok'> {
  const error = (body as { error?: unknown } | null)?.error;
  if (status === 409 && error === 'already_recording') {
    return 'already_recording';
  }
  if (status === 503 && error === 'migration_required') return 'unavailable';
  return 'failed';
}
