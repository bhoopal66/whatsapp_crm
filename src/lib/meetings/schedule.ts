// ============================================================
// The /meetings screens' pure logic (migration 106): the New meeting
// form → the POST/PATCH body, which tab a meeting belongs in, and the
// labels the list and detail page show. No I/O, no clock: `now` and
// the time zone are always passed in, so all of it is unit-tested.
// ============================================================

import { canEditSettings, type AccountRole } from '@/lib/auth/roles';
import { isValidTimeZone } from '@/lib/team-activity/limits';
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
/** The one-tap durations above the form's custom field. */
export const QUICK_DURATIONS = [15, 30, 45, 60, 90] as const;
export const DEFAULT_DURATION_MINUTES = 30;

/** Mirrors migration 106's CHECKs (title 1–200 trimmed, description ≤2000). */
export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 2000;
const MAX_DURATION_MINUTES = 24 * 60;
/** A start this far in the past still counts as "now" (a slow form). */
const PAST_GRACE_MS = 5 * 60_000;

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
  /**
   * Who is in the call, one entry per person, when the API listed the
   * present seats (`participants`); empty when it only gave a count.
   */
  present: PresentPerson[];
}

/** One person in the call; `handRaisedAt` is their earliest raised hand. */
export interface PresentPerson {
  userId: string;
  handRaisedAt: string | null;
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
 * The form's starting values: `start` when given (the calendar's
 * selected slot), else the next half hour, read in `timeZone`; the
 * default duration, nobody invited.
 */
export function defaultMeetingForm(
  now: Date,
  timeZone: string,
  start?: Date
): MeetingFormValues {
  const step = 30 * 60_000;
  const next = start ?? new Date(Math.ceil((now.getTime() + 1) / step) * step);
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
 * instant meeting) and nobody is in yet. `lapsed`: its end went by with
 * nobody in and nobody ended it. The tab each lands on matches the
 * API's `meetingPhase` (lib/meetings/requests.ts), which picks the list
 * a scope returns: an instant meeting never lapses there.
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
  if (m.scheduledEnd && Date.parse(m.scheduledEnd) < t) return 'lapsed';
  if (!m.scheduledStart) return 'due';
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

const idList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((i): i is string => !!str(i)) : [];

/**
 * Present seats → one entry per person (two tabs are one person), in
 * the order they first appear; a person's hand is up if any seat's is.
 */
function presentPeople(v: unknown): PresentPerson[] | null {
  if (!Array.isArray(v)) return null;
  const byUser = new Map<string, PresentPerson>();
  for (const p of v) {
    const row =
      p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
    const userId = str(row.user_id);
    if (!userId) continue;
    const raised = str(row.hand_raised_at);
    const seen = byUser.get(userId);
    if (!seen) byUser.set(userId, { userId, handRaisedAt: raised });
    else if (raised && (!seen.handRaisedAt || raised < seen.handRaisedAt))
      seen.handRaisedAt = raised;
  }
  return [...byUser.values()];
}

/**
 * One meeting from the API: a `meetings` row (column names) plus the
 * list's `invitee_user_ids` and `present_count`. Null when it is not a
 * meeting at all.
 */
export function parseMeeting(raw: unknown): MeetingSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const hostUserId = str(r.host_user_id);
  if (!id || !hostUserId) return null;
  const status =
    r.status === 'ended' || r.status === 'cancelled' ? r.status : 'scheduled';
  const inviteeUserIds = idList(r.invitee_user_ids);
  const present = presentPeople(r.participants);
  const count = Number(r.present_count ?? present?.length ?? 0);
  return {
    id,
    title: str(r.title) ?? '',
    description: str(r.description),
    scheduledStart: str(r.scheduled_start),
    scheduledEnd: str(r.scheduled_end),
    hostUserId,
    openToWorkspace: r.open_to_workspace === true,
    status,
    endedAt: str(r.ended_at),
    createdAt: str(r.created_at),
    inviteeUserIds,
    presentCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
    present: present ?? [],
  };
}

/** GET /api/meetings → `{ meetings: [...] }`; anything unreadable is dropped. */
export function parseMeetingList(json: unknown): MeetingSummary[] {
  const list = (json as { meetings?: unknown } | null)?.meetings;
  if (!Array.isArray(list)) return [];
  return list.map(parseMeeting).filter((m): m is MeetingSummary => m !== null);
}

/** The detail page's meeting and whether the caller may manage it. */
export interface MeetingDetailData {
  meeting: MeetingSummary;
  /** `meeting_can_manage` as the server answered it; null if absent. */
  canManage: boolean | null;
  /** Chat messages sent in it; null from an API that predates chat. */
  chatCount: number | null;
}

/**
 * GET /api/meetings/[id] → `{ meeting, invitee_user_ids, participants,
 * can_manage }`. The participants are the present rows; one person on
 * two tabs counts once, as the list's `present_count` does.
 */
export function parseMeetingDetail(json: unknown): MeetingDetailData | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as Record<string, unknown>;
  const row =
    r.meeting && typeof r.meeting === 'object'
      ? (r.meeting as Record<string, unknown>)
      : null;
  const meeting = parseMeeting(
    row && {
      ...row,
      invitee_user_ids: r.invitee_user_ids,
      participants: Array.isArray(r.participants) ? r.participants : [],
      present_count: undefined,
    }
  );
  if (!meeting) return null;
  const chat = r.chat_count;
  return {
    meeting,
    canManage: typeof r.can_manage === 'boolean' ? r.can_manage : null,
    chatCount:
      typeof chat === 'number' && Number.isFinite(chat) && chat >= 0
        ? Math.floor(chat)
        : null,
  };
}

/**
 * The zone the screens show times in: the account's saved one
 * (`team_activity_limits().timezone`, readable by every member), else
 * the viewer's, else UTC.
 */
export function resolveMeetingTimeZone(
  saved: unknown,
  viewer: string | null | undefined
): string {
  if (typeof saved === 'string' && isValidTimeZone(saved)) return saved;
  if (viewer && isValidTimeZone(viewer)) return viewer;
  return 'UTC';
}

// --------------------------------------------------------- list views

export interface MeetingDayGroup {
  /** `unscheduled`: instant meetings, which have no day. */
  kind: 'unscheduled' | 'today' | 'tomorrow' | 'date';
  /** `YYYY-MM-DD` in the time zone; null for `unscheduled`. */
  date: string | null;
  meetings: MeetingSummary[];
}

/** The calendar day after `date` (`YYYY-MM-DD`), DST-proof. */
function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * Upcoming meetings by their start's day in `timeZone`: instant
 * meetings first, then each day in date order. Order within a group is
 * the input's (the API sorts by start).
 */
export function groupMeetingsByDay(
  meetings: readonly MeetingSummary[],
  now: Date,
  timeZone: string
): MeetingDayGroup[] {
  const today = zonedParts(now.toISOString(), timeZone).date;
  const tomorrow = nextDay(today);
  const unscheduled: MeetingSummary[] = [];
  const byDate = new Map<string, MeetingSummary[]>();
  for (const m of meetings) {
    if (!m.scheduledStart) {
      unscheduled.push(m);
      continue;
    }
    const date = zonedParts(m.scheduledStart, timeZone).date;
    const list = byDate.get(date) ?? [];
    list.push(m);
    byDate.set(date, list);
  }
  const groups: MeetingDayGroup[] = [];
  if (unscheduled.length > 0)
    groups.push({ kind: 'unscheduled', date: null, meetings: unscheduled });
  for (const date of [...byDate.keys()].sort()) {
    groups.push({
      kind: date === today ? 'today' : date === tomorrow ? 'tomorrow' : 'date',
      date,
      meetings: byDate.get(date)!,
    });
  }
  return groups;
}

/** A `YYYY-MM-DD` day as a heading: "Friday, 16 October". */
export function formatMeetingDay(date: string, locale: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/**
 * The search box: every word must appear (case-insensitive) in the
 * title, the description, or the name of the host or an invitee.
 */
export function filterMeetings(
  meetings: readonly MeetingSummary[],
  query: string,
  nameOf: (userId: string) => string | null
): MeetingSummary[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...meetings];
  return meetings.filter((m) => {
    const hay = [
      m.title,
      m.description ?? '',
      ...[m.hostUserId, ...m.inviteeUserIds].map((u) => nameOf(u) ?? ''),
    ]
      .join('\n')
      .toLocaleLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * How long a past meeting ran: from its start (the creation time of an
 * instant meeting) to when it was ended. Null when it was not ended or
 * the figures make no sense (ended before its scheduled start).
 */
export function meetingDurationMs(
  m: Pick<MeetingSummary, 'status' | 'endedAt' | 'scheduledStart' | 'createdAt'>
): number | null {
  if (m.status !== 'ended' || !m.endedAt) return null;
  const from = m.scheduledStart ?? m.createdAt;
  if (!from) return null;
  const ms = Date.parse(m.endedAt) - Date.parse(from);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** A duration in whole minutes (at least 1), split for the label. */
export function durationParts(ms: number): { hours: number; minutes: number } {
  const total = Math.max(1, Math.round(ms / 60_000));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

// ---------------------------------------------------------- chat log

export interface ChatLine {
  id: string;
  userId: string;
  body: string;
  createdAt: string;
}

/** GET /api/meetings/[id]/messages → chat lines, oldest first. */
export function parseChatMessages(json: unknown): ChatLine[] {
  const list = (json as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(list)) return [];
  const lines: ChatLine[] = [];
  for (const raw of list) {
    const r =
      raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const id = str(r.id);
    const userId = str(r.user_id);
    const createdAt = str(r.created_at);
    if (!id || !userId || !createdAt || typeof r.body !== 'string') continue;
    if (r.kind !== undefined && r.kind !== 'chat') continue;
    lines.push({ id, userId, body: r.body, createdAt });
  }
  return lines.sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
  );
}

export type TextSegment =
  { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string };

const URL_RE = /https?:\/\/[^\s<>"]+/gi;
/** Sentence punctuation that ends a link rather than belonging to it. */
const TRAILING_RE = /[.,;:!?)\]}'"]+$/;

/**
 * Chat text as plain-text and link segments, for rendering as text
 * nodes and anchors (never HTML). Only http(s) URLs become links.
 */
export function linkifyText(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  const push = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last?.kind === 'text') last.text += t;
    else out.push({ kind: 'text', text: t });
  };
  let at = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const url = raw.replace(TRAILING_RE, '');
    push(text.slice(at, start));
    let href: string | null = null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        href = parsed.href;
    } catch {
      href = null;
    }
    if (href) out.push({ kind: 'link', text: url, href });
    else push(url);
    at = start + url.length;
  }
  push(text.slice(at));
  return out;
}
