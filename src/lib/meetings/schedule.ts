// ============================================================
// The /meetings screens' pure logic (migration 106): the New meeting
// form → the POST/PATCH body, which tab a meeting belongs in, and the
// labels the list and detail page show. No I/O, no clock: `now` and
// the time zone are always passed in, so all of it is unit-tested.
// ============================================================

import { canEditSettings, type AccountRole } from '@/lib/auth/roles';
import { zoneOffsetMs } from '@/lib/team-activity/range';

export const MEETING_SCOPES = ['live', 'upcoming', 'past'] as const;
export type MeetingScope = (typeof MEETING_SCOPES)[number];

export function meetingScopeParam(value: unknown): MeetingScope {
  return typeof value === 'string' &&
    (MEETING_SCOPES as readonly string[]).includes(value)
    ? (value as MeetingScope)
    : 'live';
}

/** The duration choices the form offers, in minutes. */
export const MEETING_DURATIONS = [15, 30, 45, 60, 90, 120] as const;
export const DEFAULT_DURATION_MINUTES = 30;

/** Mirrors migration 106's CHECKs (title 1–200 trimmed, description ≤2000). */
export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 2000;
const MAX_DURATION_MINUTES = 24 * 60;
/** A start this far in the past still counts as "now" (a slow form). */
const PAST_GRACE_MS = 5 * 60_000;
/**
 * An instant meeting (no scheduled start) that nobody is in and nobody
 * ended leaves Upcoming this long after it was created.
 */
export const INSTANT_LAPSE_MS = 24 * 60 * 60_000;

export type MeetingStatus = 'scheduled' | 'ended' | 'cancelled';

/** One meeting as the screens use it, parsed from the API's row. */
export interface MeetingSummary {
  id: string;
  title: string;
  description: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  hostUserId: string;
  openToWorkspace: boolean;
  status: MeetingStatus;
  endedAt: string | null;
  createdAt: string | null;
  inviteeUserIds: string[];
  /** People in the call now (left_at NULL, heartbeat within 60 s). */
  presentCount: number;
}

// ---------------------------------------------------------------- form

export interface MeetingFormValues {
  title: string;
  description: string;
  /** `YYYY-MM-DD`, a wall-clock date in `timeZone`. */
  date: string;
  /** `HH:MM`, 24-hour, a wall-clock time in `timeZone`. */
  time: string;
  durationMinutes: number;
  inviteeUserIds: string[];
  openToWorkspace: boolean;
  /** Start now: an instant meeting, no scheduled times. */
  startNow: boolean;
}

/** Keys under `Meetings.form.errors`. */
export type MeetingFormError =
  | 'titleRequired'
  | 'titleTooLong'
  | 'descriptionTooLong'
  | 'dateRequired'
  | 'timeRequired'
  | 'invalidDateTime'
  | 'durationInvalid'
  | 'startInPast';

/** The body of POST /api/meetings and PATCH /api/meetings/[id]. */
export interface MeetingRequestBody {
  title: string;
  description: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  inviteeUserIds: string[];
  openToWorkspace: boolean;
}

export type BuildResult =
  | { ok: true; body: MeetingRequestBody }
  | { ok: false; errors: MeetingFormError[] };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The instant a wall-clock `date` + `time` names in `timeZone`, or null
 * when it names no instant (malformed, or a time skipped by a DST
 * change). The offset is re-read at the candidate, as zonedDayStart
 * does, and the result is checked by formatting it back.
 */
export function zonedWallTimeToInstant(
  date: string,
  time: string,
  timeZone: string
): Date | null {
  const d = DATE_RE.exec(date);
  const t = TIME_RE.exec(time);
  if (!d || !t) return null;
  const [y, m, day, h, min] = [d[1], d[2], d[3], t[1], t[2]].map(Number);
  const asUtc = Date.UTC(y, m - 1, day, h, min);
  let guess = asUtc - zoneOffsetMs(asUtc, timeZone);
  const corrected = asUtc - zoneOffsetMs(guess, timeZone);
  if (corrected !== guess) guess = corrected;
  const back = zonedParts(new Date(guess).toISOString(), timeZone);
  return back.date === date && back.time === time ? new Date(guess) : null;
}

/** `{date: YYYY-MM-DD, time: HH:MM}` of `iso` in `timeZone`. */
export function zonedParts(
  iso: string,
  timeZone: string
): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

/**
 * The form's starting values: the next half hour in `timeZone`, the
 * default duration, nobody invited.
 */
export function defaultMeetingForm(
  now: Date,
  timeZone: string
): MeetingFormValues {
  const step = 30 * 60_000;
  const next = new Date(Math.ceil((now.getTime() + 1) / step) * step);
  const { date, time } = zonedParts(next.toISOString(), timeZone);
  return {
    title: '',
    description: '',
    date,
    time,
    durationMinutes: DEFAULT_DURATION_MINUTES,
    inviteeUserIds: [],
    openToWorkspace: false,
    startNow: false,
  };
}

/** An existing meeting's values, for the Edit dialog. */
export function meetingToForm(
  m: MeetingSummary,
  now: Date,
  timeZone: string
): MeetingFormValues {
  const base = defaultMeetingForm(now, timeZone);
  const start = m.scheduledStart
    ? zonedParts(m.scheduledStart, timeZone)
    : null;
  const minutes =
    m.scheduledStart && m.scheduledEnd
      ? Math.round(
          (Date.parse(m.scheduledEnd) - Date.parse(m.scheduledStart)) / 60_000
        )
      : DEFAULT_DURATION_MINUTES;
  return {
    ...base,
    title: m.title,
    description: m.description ?? '',
    date: start?.date ?? base.date,
    time: start?.time ?? base.time,
    durationMinutes: minutes > 0 ? minutes : DEFAULT_DURATION_MINUTES,
    inviteeUserIds: [...m.inviteeUserIds],
    openToWorkspace: m.openToWorkspace,
    startNow: !m.scheduledStart,
  };
}

/**
 * Validate the form and build the request body. Times are read in
 * `timeZone` and sent as ISO instants. Start now sends no times (an
 * instant meeting). `allowPast` is for editing a meeting whose start
 * has already gone by.
 */
export function buildMeetingBody(
  values: MeetingFormValues,
  opts: { timeZone: string; now: Date; allowPast?: boolean }
): BuildResult {
  const errors: MeetingFormError[] = [];
  const title = values.title.trim();
  const description = values.description.trim();
  if (!title) errors.push('titleRequired');
  else if (title.length > TITLE_MAX) errors.push('titleTooLong');
  if (description.length > DESCRIPTION_MAX) errors.push('descriptionTooLong');

  let scheduledStart: string | null = null;
  let scheduledEnd: string | null = null;
  if (!values.startNow) {
    if (!values.date) errors.push('dateRequired');
    if (!values.time) errors.push('timeRequired');
    const minutes = values.durationMinutes;
    const durationOk =
      Number.isInteger(minutes) &&
      minutes > 0 &&
      minutes <= MAX_DURATION_MINUTES;
    if (!durationOk) errors.push('durationInvalid');
    if (values.date && values.time) {
      const start = zonedWallTimeToInstant(
        values.date,
        values.time,
        opts.timeZone
      );
      if (!start) errors.push('invalidDateTime');
      else if (
        !opts.allowPast &&
        start.getTime() < opts.now.getTime() - PAST_GRACE_MS
      )
        errors.push('startInPast');
      else if (durationOk) {
        scheduledStart = start.toISOString();
        scheduledEnd = new Date(
          start.getTime() + minutes * 60_000
        ).toISOString();
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      title,
      description: description || null,
      scheduledStart,
      scheduledEnd,
      inviteeUserIds: [...new Set(values.inviteeUserIds)],
      openToWorkspace: values.openToWorkspace,
    },
  };
}

// ------------------------------------------------------- status & scope

/**
 * What a meeting is doing now. `live` is derived from who is present,
 * never stored (migration 106). `due`: its time has come (or it is an
 * instant meeting) and nobody is in yet. `lapsed`: its time went by
 * with nobody in and nobody ended it.
 */
export type MeetingDisplayStatus =
  'live' | 'scheduled' | 'due' | 'lapsed' | 'ended' | 'cancelled';

type StatusInput = Pick<
  MeetingSummary,
  'status' | 'scheduledStart' | 'scheduledEnd' | 'createdAt' | 'presentCount'
>;

export function meetingDisplayStatus(
  m: StatusInput,
  now: Date
): MeetingDisplayStatus {
  if (m.status === 'cancelled') return 'cancelled';
  if (m.status === 'ended') return 'ended';
  if (m.presentCount > 0) return 'live';
  const t = now.getTime();
  if (!m.scheduledStart) {
    const created = m.createdAt ? Date.parse(m.createdAt) : NaN;
    return Number.isFinite(created) && t - created >= INSTANT_LAPSE_MS
      ? 'lapsed'
      : 'due';
  }
  if (m.scheduledEnd && t >= Date.parse(m.scheduledEnd)) return 'lapsed';
  return t >= Date.parse(m.scheduledStart) ? 'due' : 'scheduled';
}

/** Which tab a meeting belongs in: Live now, Upcoming or Past. */
export function meetingScope(m: StatusInput, now: Date): MeetingScope {
  switch (meetingDisplayStatus(m, now)) {
    case 'live':
      return 'live';
    case 'scheduled':
    case 'due':
      return 'upcoming';
    default:
      return 'past';
  }
}

/** May people still join? Not once it has ended or been cancelled. */
export function canJoinMeeting(m: Pick<MeetingSummary, 'status'>): boolean {
  return m.status === 'scheduled';
}

/**
 * Mirrors `meeting_can_manage` (migration 106): the host, or an owner
 * or admin of the workspace. UI only; RLS decides.
 */
export function canManageMeeting(
  role: AccountRole | null,
  userId: string | null | undefined,
  m: Pick<MeetingSummary, 'hostUserId'>
): boolean {
  if (!role) return false;
  return canEditSettings(role) || (!!userId && userId === m.hostUserId);
}

// ------------------------------------------------------------- labels

/**
 * The meeting's time as one line, in `timeZone`: "Thu, 16 Oct, 14:00 –
 * 14:30". Null for an instant meeting, which the screen words itself.
 */
export function formatMeetingWhen(
  m: Pick<MeetingSummary, 'scheduledStart' | 'scheduledEnd'>,
  opts: { locale: string; timeZone: string }
): string | null {
  if (!m.scheduledStart) return null;
  const start = new Date(m.scheduledStart);
  const date = new Intl.DateTimeFormat(opts.locale, {
    timeZone: opts.timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(start);
  const clock = new Intl.DateTimeFormat(opts.locale, {
    timeZone: opts.timeZone,
    hour: '2-digit',
    minute: '2-digit',
  });
  const from = clock.format(start);
  if (!m.scheduledEnd) return `${date}, ${from}`;
  return `${date}, ${from} – ${clock.format(new Date(m.scheduledEnd))}`;
}

// ------------------------------------------------------------ parsing

const str = (v: unknown): string | null =>
  typeof v === 'string' && v ? v : null;

/**
 * One meeting from the API. Reads the table's own column names (the
 * routes return rows), plus `invitees` as rows or ids and the present
 * count as `present_count` or `presentCount`. Null when it is not a
 * meeting at all.
 */
export function parseMeeting(raw: unknown): MeetingSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const hostUserId = str(r.host_user_id ?? r.hostUserId);
  if (!id || !hostUserId) return null;
  const status =
    r.status === 'ended' || r.status === 'cancelled' ? r.status : 'scheduled';
  const inviteesRaw = Array.isArray(r.invitees) ? r.invitees : [];
  const inviteeUserIds = inviteesRaw
    .map((i) =>
      typeof i === 'string'
        ? i
        : str((i as Record<string, unknown> | null)?.user_id)
    )
    .filter((i): i is string => !!i);
  const count = Number(r.present_count ?? r.presentCount ?? 0);
  return {
    id,
    title: str(r.title) ?? '',
    description: str(r.description),
    scheduledStart: str(r.scheduled_start ?? r.scheduledStart),
    scheduledEnd: str(r.scheduled_end ?? r.scheduledEnd),
    hostUserId,
    openToWorkspace: (r.open_to_workspace ?? r.openToWorkspace) === true,
    status,
    endedAt: str(r.ended_at ?? r.endedAt),
    createdAt: str(r.created_at ?? r.createdAt),
    inviteeUserIds,
    presentCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
  };
}

/** GET /api/meetings → `{ meetings: [...] }`; anything unreadable is dropped. */
export function parseMeetingList(json: unknown): MeetingSummary[] {
  const list = (json as { meetings?: unknown } | null)?.meetings;
  if (!Array.isArray(list)) return [];
  return list.map(parseMeeting).filter((m): m is MeetingSummary => m !== null);
}
