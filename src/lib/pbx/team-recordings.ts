// The Team call recordings page (module 015): GET
// /api/pbx/calls/recordings, for team leaders and admins. Pure, and
// safe for the browser: the page imports the types and constants, so
// nothing here pulls in next/server (./calls does, hence the local UUID
// pattern).

import { isCallStatsPeriod, type CallStatsPeriod } from './call-report';

export const RECORDING_DIRECTIONS = [
  'all',
  'inbound',
  'outbound',
  'internal',
] as const;
export type RecordingDirection = (typeof RECORDING_DIRECTIONS)[number];

/** The minimum-length choices the page offers, in seconds of talk. */
export const TALK_FILTERS = [0, 30, 60, 180, 300] as const;
/** The largest `minTalk` the route takes: ten hours. */
export const MIN_TALK_MAX = 36000;

export const RECORDINGS_LIMIT = 50;
export const RECORDINGS_MAX = 100;
export const NUMBER_SEARCH_MIN = 3;
export const NUMBER_SEARCH_MAX = 20;

/** The summary's read: pages of this many calls, at most this many. */
export const SUMMARY_PAGE = 1000;
export const SUMMARY_MAX_PAGES = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- Response ----------

export interface TeamRecordingPerson {
  userId: string;
  name: string | null;
  role: string;
  /** The teams in the caller's scope this person belongs to. */
  teamIds: string[];
}

export interface TeamRecordingTeam {
  id: string;
  name: string;
  /** Members who are people in the caller's scope (live staff). */
  memberIds: string[];
}

export interface TeamRecordingSummary {
  userId: string;
  /** Calls attributed to the person (calls.user_id) in the range. */
  calls: number;
  answered: number;
  /** Calls with a fetched recording. */
  recorded: number;
  recordedSeconds: number;
  longestSeconds: number;
  lastRecordedAt: string | null;
}

/** A row of GET /api/pbx/calls (no internal-call `party`). */
export interface TeamRecordingCall {
  id: string;
  pbxCallId: string;
  direction: string;
  status: string;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  ringSeconds: number | null;
  talkSeconds: number | null;
  remoteNumber: string | null;
  didNumber: string | null;
  extension: string | null;
  contactId: string | null;
  contactName: string | null;
  doNotContactAt: string | null;
  doNotContactReason: string | null;
  userId: string | null;
  userName: string | null;
  rangNames: string[];
  disposition: string | null;
  notes: string | null;
  recordingState: string;
  recordingDeleted: boolean;
  legalHold: boolean;
}

export interface TeamRecordingsResponse {
  range: {
    period: CallStatsPeriod;
    from: string;
    to: string;
    timeZone: string;
  };
  people: TeamRecordingPerson[];
  teams: TeamRecordingTeam[];
  summary: TeamRecordingSummary[];
  /** The summary's read hit its cap: the oldest calls are not counted. */
  summaryCapped: boolean;
  calls: TeamRecordingCall[];
  /** `before` for the next page; null at the end. */
  next: string | null;
}

// ---------- Query ----------

export interface RecordingsCursor {
  /** started_at, in UTC with the database's own fraction. */
  at: string;
  id: string;
}

export interface TeamRecordingsQuery {
  period: CallStatsPeriod;
  /** Custom days (YYYY-MM-DD), checked by callReportRange. */
  from: string | null;
  to: string | null;
  tz: string | null;
  team: string | null;
  user: string | null;
  direction: RecordingDirection;
  minTalk: number;
  /** Digits to find in the customer's number, or null. */
  q: string | null;
  before: RecordingsCursor | null;
  limit: number;
}

const INSTANT =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d{1,6})?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * A timestamp as PostgREST returns one, rewritten in UTC ("…Z") with its
 * fraction kept digit for digit: microseconds survive, which a round
 * trip through Date would cut to milliseconds (and the cursor would then
 * skip or repeat calls). No "+" either, which a query string reads as a
 * space. Null for anything else.
 */
export function utcInstant(value: string): string | null {
  const m = INSTANT.exec(value);
  if (!m) return null;
  let offset = m[4];
  if (offset !== 'Z') {
    const digits = offset.slice(1).replace(':', '');
    offset = `${offset[0]}${digits.slice(0, 2)}:${digits.slice(2) || '00'}`;
  }
  const at = Date.parse(`${m[1]}T${m[2]}${offset}`);
  if (!Number.isFinite(at)) return null;
  return `${new Date(at).toISOString().slice(0, 19)}${m[3] ?? ''}Z`;
}

/** `before` for the page after the call `last` (the page's oldest). */
export function encodeCursor(last: { started_at: string; id: string }): string {
  return `${utcInstant(last.started_at) ?? last.started_at}|${last.id}`;
}

/** `"<startedAt>|<call id>"`, checked; null for anything else. */
export function decodeCursor(value: string): RecordingsCursor | null {
  const parts = value.split('|');
  if (parts.length !== 2) return null;
  const at = utcInstant(parts[0]);
  if (!at || !UUID.test(parts[1])) return null;
  return { at, id: parts[1].toLowerCase() };
}

/**
 * The PostgREST filter for calls older than the cursor in the list's
 * order (started_at desc, id desc). Both values are checked by
 * decodeCursor, and the instant is quoted: it holds `.` and `:`.
 */
export function cursorFilter(c: RecordingsCursor): string {
  return `started_at.lt."${c.at}",and(started_at.eq."${c.at}",id.lt.${c.id})`;
}

/** The route's query string, checked; a string is the 400. */
export function parseTeamRecordingsQuery(
  p: URLSearchParams
): TeamRecordingsQuery | string {
  const period = p.get('period') || 'month';
  if (!isCallStatsPeriod(period)) return 'Unknown period';
  const team = p.get('team') || null;
  if (team !== null && !UUID.test(team)) return 'team must be an id';
  const user = p.get('user') || null;
  if (user !== null && !UUID.test(user)) return 'user must be an id';
  const direction = p.get('direction') || 'all';
  if (!(RECORDING_DIRECTIONS as readonly string[]).includes(direction))
    return `direction must be one of ${RECORDING_DIRECTIONS.join(', ')}`;
  const minTalkRaw = p.get('minTalk') || '0';
  const minTalk = /^\d{1,5}$/.test(minTalkRaw) ? Number(minTalkRaw) : NaN;
  if (!(minTalk <= MIN_TALK_MAX))
    return `minTalk must be whole seconds from 0 to ${MIN_TALK_MAX}`;
  let q: string | null = null;
  const search = (p.get('q') ?? '').trim();
  if (search) {
    q = search.replace(/\D/g, '');
    if (q.length < NUMBER_SEARCH_MIN || q.length > NUMBER_SEARCH_MAX)
      return `q must hold ${NUMBER_SEARCH_MIN} to ${NUMBER_SEARCH_MAX} digits`;
  }
  let before: RecordingsCursor | null = null;
  const cursor = p.get('before');
  if (cursor) {
    before = decodeCursor(cursor);
    if (!before) return 'before is not a page cursor';
  }
  const limitRaw = p.get('limit') || String(RECORDINGS_LIMIT);
  const limit = /^\d{1,3}$/.test(limitRaw) ? Number(limitRaw) : NaN;
  if (!(limit >= 1 && limit <= RECORDINGS_MAX))
    return `limit must be a whole number from 1 to ${RECORDINGS_MAX}`;
  return {
    period,
    from: p.get('from') || null,
    to: p.get('to') || null,
    tz: p.get('tz') || null,
    team,
    user,
    direction: direction as RecordingDirection,
    minTalk,
    q,
    before,
    limit,
  };
}

// ---------- Scope ----------

const byName = (a: { name: string | null }, b: { name: string | null }) =>
  a.name === b.name
    ? 0
    : a.name === null
      ? 1
      : b.name === null
        ? -1
        : a.name.localeCompare(b.name);

/**
 * The people and teams the caller may look at. `profiles` are the live
 * staff rows of the active account; `visibleIds` is
 * pbx_visible_user_ids() for a team leader (the caller and the people
 * of the teams they lead) and null for an admin (everyone). `teams` are
 * already the caller's (every team for an admin, the ones they lead for
 * a leader). A team lists only members in scope, and a person only
 * teams in scope. Both sorted by name.
 */
export function scopePeople(input: {
  profiles: readonly {
    user_id: string;
    full_name: string | null;
    account_role: string;
  }[];
  visibleIds: readonly string[] | null;
  teams: readonly { id: string; name: string }[];
  memberships: readonly { team_id: string; user_id: string }[];
}): { people: TeamRecordingPerson[]; teams: TeamRecordingTeam[] } {
  const visible = input.visibleIds ? new Set(input.visibleIds) : null;
  const people = new Map<string, TeamRecordingPerson>();
  for (const p of input.profiles) {
    if (p.account_role === 'bank_guest') continue;
    if (visible && !visible.has(p.user_id)) continue;
    people.set(p.user_id, {
      userId: p.user_id,
      name: p.full_name?.trim() || null,
      role: p.account_role,
      teamIds: [],
    });
  }
  const teams = new Map<string, TeamRecordingTeam>(
    input.teams.map((t) => [t.id, { id: t.id, name: t.name, memberIds: [] }])
  );
  for (const m of input.memberships) {
    const team = teams.get(m.team_id);
    const person = people.get(m.user_id);
    if (!team || !person || team.memberIds.includes(m.user_id)) continue;
    team.memberIds.push(m.user_id);
    person.teamIds.push(m.team_id);
  }
  return {
    people: [...people.values()].sort(byName),
    teams: [...teams.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * The people whose calls the request reads: the whole scope, narrowed
 * to a team's members, then to one person. A team or person outside
 * the scope is the 403's message.
 */
export function narrowPeople(
  scope: {
    people: readonly TeamRecordingPerson[];
    teams: readonly TeamRecordingTeam[];
  },
  q: { team: string | null; user: string | null }
): { ok: true; userIds: string[] } | { ok: false; error: string } {
  let ids = scope.people.map((p) => p.userId);
  if (q.team !== null) {
    const team = scope.teams.find((t) => t.id === q.team);
    if (!team) return { ok: false, error: 'You cannot view that team’s calls' };
    const members = new Set(team.memberIds);
    ids = ids.filter((id) => members.has(id));
  }
  if (q.user !== null) {
    if (!scope.people.some((p) => p.userId === q.user))
      return { ok: false, error: 'You cannot view that person’s calls' };
    ids = ids.filter((id) => id === q.user);
  }
  return { ok: true, userIds: ids };
}

// ---------- Summary ----------

export interface SummaryCallRow {
  user_id: string | null;
  answered_at: string | null;
  recording_state: string;
  talk_seconds: number | null;
  started_at: string;
}

/**
 * One entry per person in `userIds`, in that order, with zero rows
 * included (who has no recordings is the point). A call counts as
 * recorded when its recording was fetched; one whose audio the
 * retention period has since deleted still counts (the summary reads
 * calls only, not call_recordings).
 */
export function summarizeRecordings(
  userIds: readonly string[],
  rows: readonly SummaryCallRow[]
): TeamRecordingSummary[] {
  const by = new Map<string, TeamRecordingSummary>(
    userIds.map((userId) => [
      userId,
      {
        userId,
        calls: 0,
        answered: 0,
        recorded: 0,
        recordedSeconds: 0,
        longestSeconds: 0,
        lastRecordedAt: null,
      },
    ])
  );
  for (const r of rows) {
    const s = r.user_id ? by.get(r.user_id) : undefined;
    if (!s) continue;
    s.calls += 1;
    if (r.answered_at) s.answered += 1;
    if (r.recording_state !== 'fetched') continue;
    const talk = Math.max(0, r.talk_seconds ?? 0);
    s.recorded += 1;
    s.recordedSeconds += talk;
    s.longestSeconds = Math.max(s.longestSeconds, talk);
    if (
      s.lastRecordedAt === null ||
      Date.parse(r.started_at) > Date.parse(s.lastRecordedAt)
    )
      s.lastRecordedAt = r.started_at;
  }
  return [...by.values()];
}
