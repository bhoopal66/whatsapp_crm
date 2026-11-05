import { isPresent } from './requests';
import { PRESENCE_WINDOW_MS } from './types';

// ============================================================
// Who may come back into a locked meeting (176).
// ============================================================

/** How long after a seat closes its person still counts as mid-call. */
export const LOCKED_REJOIN_WINDOW_MS = 5 * 60_000;

/**
 * A dropped connection rejoins from scratch and the old seat is closed
 * first, so someone already inside must get past the lock: they hold an
 * open seat, or one that closed within the window.
 */
export function mayEnterLocked(
  seats: readonly { left_at: string | null }[],
  nowMs: number
): boolean {
  return seats.some(
    (s) =>
      !s.left_at || nowMs - Date.parse(s.left_at) <= LOCKED_REJOIN_WINDOW_MS
  );
}

// ============================================================
// Who came, for how long, from the seats of one meeting.
// ============================================================

/** The columns of `meeting_participants` attendance is worked out from. */
export const ATTENDANCE_SEAT_COLUMNS =
  'user_id, joined_at, last_seen_at, left_at, removed_at';

export interface AttendanceSeat {
  user_id: string;
  joined_at: string;
  last_seen_at: string;
  left_at: string | null;
  removed_at: string | null;
}

export interface AttendanceEntry {
  userId: string;
  firstJoinedAt: string;
  /** Null while they are in the call. */
  lastLeftAt: string | null;
  /** Time in the call: overlapping seats count once. */
  totalMs: number;
  /** Seats with any length: how many times they joined. */
  seats: number;
  /** A moderator removed one of their seats. */
  removed: boolean;
}

export interface AttendanceSummary {
  people: number;
  startedAt: string | null;
  /** Null while anyone is in the call. */
  endedAt: string | null;
  longestMs: number;
}

/**
 * When a seat that is not live stopped. A dead tab has no `left_at` until
 * a rejoin or the meeting's end closes it, and that close stamps its own
 * time, so a `left_at` further past the last heartbeat than presence
 * allows says when the seat was tidied up, not when the person went:
 * read as it stands, a tab that died at 09:05 of a meeting ended at 17:00
 * would attend all day, and only once the meeting ended.
 */
function seatStoppedMs(seat: AttendanceSeat): number {
  const lastSeen = Date.parse(seat.last_seen_at);
  if (!seat.left_at) return lastSeen;
  const left = Date.parse(seat.left_at);
  return left - lastSeen > PRESENCE_WINDOW_MS ? lastSeen : left;
}

/** Milliseconds covered by the spans, overlaps counted once. */
function unionMs(spans: readonly (readonly [number, number])[]): number {
  let total = 0;
  let reached = -Infinity;
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (end <= reached) continue;
    total += end - Math.max(start, reached);
    reached = end;
  }
  return total;
}

/**
 * One entry per person with a seat of any length, first joined first. A
 * seat a heartbeat is still holding counts to now, unless the meeting
 * ended; `endedAtMs` caps every seat. An empty, inverted or unreadable
 * seat counts for nothing, so someone with no other has no entry.
 */
export function summarizeAttendance(
  seats: readonly AttendanceSeat[],
  { nowMs, endedAtMs = null }: { nowMs: number; endedAtMs?: number | null }
): AttendanceEntry[] {
  const people = new Map<
    string,
    { spans: [number, number][]; present: boolean; removed: boolean }
  >();
  for (const seat of seats) {
    const person = people.get(seat.user_id) ?? {
      spans: [],
      present: false,
      removed: false,
    };
    people.set(seat.user_id, person);
    person.removed ||= Boolean(seat.removed_at);

    const live = endedAtMs === null && isPresent(seat, nowMs);
    const start = Date.parse(seat.joined_at);
    const stopped = live ? nowMs : seatStoppedMs(seat);
    const end = endedAtMs === null ? stopped : Math.min(stopped, endedAtMs);
    // Written to be false for NaN as well.
    if (!(end > start)) continue;
    person.spans.push([start, end]);
    person.present ||= live;
  }

  return [...people]
    .filter(([, person]) => person.spans.length > 0)
    .map(([userId, { spans, present, removed }]) => ({
      userId,
      firstMs: Math.min(...spans.map(([start]) => start)),
      lastMs: Math.max(...spans.map(([, end]) => end)),
      present,
      totalMs: unionMs(spans),
      seats: spans.length,
      removed,
    }))
    .sort((a, b) => a.firstMs - b.firstMs || a.userId.localeCompare(b.userId))
    .map(({ firstMs, lastMs, present, ...entry }) => ({
      ...entry,
      firstJoinedAt: new Date(firstMs).toISOString(),
      lastLeftAt: present ? null : new Date(lastMs).toISOString(),
    }));
}

export function attendanceSummary(
  entries: readonly AttendanceEntry[]
): AttendanceSummary {
  if (entries.length === 0) {
    return { people: 0, startedAt: null, endedAt: null, longestMs: 0 };
  }
  const left = entries.map((e) => e.lastLeftAt);
  return {
    people: entries.length,
    startedAt: new Date(
      Math.min(...entries.map((e) => Date.parse(e.firstJoinedAt)))
    ).toISOString(),
    endedAt: left.includes(null)
      ? null
      : new Date(
          Math.max(...left.map((at) => Date.parse(at as string)))
        ).toISOString(),
    longestMs: Math.max(...entries.map((e) => e.totalMs)),
  };
}

/** Column headings and the two words a cell can hold; the caller's locale. */
export interface AttendanceCsvLabels {
  name: string;
  joined: string;
  left: string;
  minutes: string;
  seats: string;
  removed: string;
  /** The Left cell of someone still in the call. */
  stillPresent: string;
  /** The Removed cell of someone removed; blank otherwise. */
  yes: string;
}

/** A spreadsheet runs a cell opening with one of these as a formula. */
const FORMULA_START_RE = /^[=+\-@\t\r]/;

function csvCell(value: string): string {
  const safe = FORMULA_START_RE.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** RFC 4180 text, CRLF line ends, times in UTC. A display name is whatever
 *  its owner typed, so every cell goes through `csvCell`. */
export function attendanceCsv(
  entries: readonly AttendanceEntry[],
  nameOf: (userId: string) => string,
  labels: AttendanceCsvLabels
): string {
  const rows = [
    [
      labels.name,
      labels.joined,
      labels.left,
      labels.minutes,
      labels.seats,
      labels.removed,
    ],
    ...entries.map((e) => [
      nameOf(e.userId),
      e.firstJoinedAt,
      e.lastLeftAt ?? labels.stillPresent,
      (e.totalMs / 60_000).toFixed(1),
      String(e.seats),
      e.removed ? labels.yes : '',
    ]),
  ];
  return rows.map((row) => row.map(csvCell).join(',') + '\r\n').join('');
}
