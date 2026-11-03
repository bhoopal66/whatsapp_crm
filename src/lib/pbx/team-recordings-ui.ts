// The Team call recordings page's pure logic (/calls/recordings): the
// URL that keeps its filters (so a link is shareable and a reload keeps
// them), the API query built from it, the number search's debounce
// rule, the per-person table's rows and sort, and the day grouping of
// the list. Safe for the browser; the response types and constants are
// ./team-recordings.

import {
  checkCustomDays,
  isCallStatsPeriod,
  type CallStatsPeriod,
} from './call-report';
import {
  NUMBER_SEARCH_MAX,
  NUMBER_SEARCH_MIN,
  RECORDING_DIRECTIONS,
  TALK_FILTERS,
  type RecordingDirection,
  type TeamRecordingPerson,
  type TeamRecordingSummary,
  type TeamRecordingTeam,
} from './team-recordings';
import { dayKey } from './timeline';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- The URL ----------

/** The route's own default: a leader reviews the month so far. */
export const DEFAULT_RECORDINGS_PERIOD: CallStatsPeriod = 'month';

export interface RecordingsParams {
  period: CallStatsPeriod;
  /** YYYY-MM-DD, custom only (null otherwise or when unusable). */
  from: string | null;
  to: string | null;
  team: string | null;
  user: string | null;
  direction: RecordingDirection;
  /** One of TALK_FILTERS. */
  minTalk: number;
  /** Digits, NUMBER_SEARCH_MIN to NUMBER_SEARCH_MAX of them, or null. */
  q: string | null;
}

const uuidOrNull = (v: string | null) => (v && UUID_RE.test(v) ? v : null);

/**
 * The page's URL as it reads it. Anything unusable falls back to its
 * default rather than reaching the route as a 400: an unknown period is
 * the month, a custom period with bad days keeps the days null (the
 * page then asks for them), a malformed id is "all", a length the
 * picker does not offer is any length, a search the route would refuse
 * is no search.
 */
export function readRecordingsParams(
  get: (key: string) => string | null
): RecordingsParams {
  const raw = get('period');
  const period = isCallStatsPeriod(raw) ? raw : DEFAULT_RECORDINGS_PERIOD;
  const days =
    period === 'custom' && checkCustomDays(get('from'), get('to')) === null
      ? { from: get('from'), to: get('to') }
      : { from: null, to: null };
  const direction = get('direction');
  const minTalk = Number(get('minTalk') ?? '0');
  return {
    period,
    ...days,
    team: uuidOrNull(get('team')),
    user: uuidOrNull(get('user')),
    direction: (RECORDING_DIRECTIONS as readonly string[]).includes(
      direction ?? ''
    )
      ? (direction as RecordingDirection)
      : 'all',
    minTalk: (TALK_FILTERS as readonly number[]).includes(minTalk)
      ? minTalk
      : 0,
    q: numberSearch(get('q') ?? '') || null,
  };
}

/** The page's query string for `p`, without the `?`; defaults left out. */
export function recordingsSearch(p: RecordingsParams): string {
  const q = new URLSearchParams();
  if (p.period !== DEFAULT_RECORDINGS_PERIOD) q.set('period', p.period);
  if (p.period === 'custom' && p.from && p.to) {
    q.set('from', p.from);
    q.set('to', p.to);
  }
  if (p.team) q.set('team', p.team);
  if (p.user) q.set('user', p.user);
  if (p.direction !== 'all') q.set('direction', p.direction);
  if (p.minTalk > 0) q.set('minTalk', String(p.minTalk));
  if (p.q) q.set('q', p.q);
  return q.toString();
}

/**
 * GET /api/pbx/calls/recordings' query for `p`, or null while it cannot
 * be asked (a custom period lacking its days). `before` is the previous
 * page's `next`; URLSearchParams encodes its `|`.
 */
export function recordingsQuery(
  p: RecordingsParams,
  tz: string,
  before: string | null = null
): string | null {
  if (p.period === 'custom' && !(p.from && p.to)) return null;
  const q = new URLSearchParams({ period: p.period });
  if (p.period === 'custom') {
    q.set('from', p.from!);
    q.set('to', p.to!);
  }
  q.set('tz', tz);
  if (p.team) q.set('team', p.team);
  if (p.user) q.set('user', p.user);
  if (p.direction !== 'all') q.set('direction', p.direction);
  if (p.minTalk > 0) q.set('minTalk', String(p.minTalk));
  if (p.q) q.set('q', p.q);
  if (before) q.set('before', before);
  return q.toString();
}

/**
 * What the number box sends, as the route counts it (digits only): ''
 * for a box with no digits (no search), the digits when there are
 * NUMBER_SEARCH_MIN to NUMBER_SEARCH_MAX of them, null while the box
 * holds a search the route would refuse (keep the previous one).
 */
export function numberSearch(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return '';
  if (digits.length < NUMBER_SEARCH_MIN || digits.length > NUMBER_SEARCH_MAX)
    return null;
  return digits;
}

/**
 * The people the Person picker lists: the chosen team's members, or
 * the whole scope (already sorted by name by the route).
 */
export function peopleOfTeam(
  people: readonly TeamRecordingPerson[],
  teams: readonly TeamRecordingTeam[],
  teamId: string | null
): TeamRecordingPerson[] {
  if (!teamId) return [...people];
  const team = teams.find((t) => t.id === teamId);
  if (!team) return [];
  const members = new Set(team.memberIds);
  return people.filter((p) => members.has(p.userId));
}

// ---------- By person ----------

export interface SummaryRow extends TeamRecordingSummary {
  name: string | null;
  teamNames: string[];
  /** Mean seconds per recorded call; null with none recorded. */
  avgSeconds: number | null;
}

export function averageRecording(s: TeamRecordingSummary): number | null {
  return s.recorded > 0 ? Math.round(s.recordedSeconds / s.recorded) : null;
}

/** The summary joined to the people's names and team names. */
export function summaryRows(
  summary: readonly TeamRecordingSummary[],
  people: readonly TeamRecordingPerson[],
  teams: readonly TeamRecordingTeam[]
): SummaryRow[] {
  const person = new Map(people.map((p) => [p.userId, p]));
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  return summary.map((s) => {
    const p = person.get(s.userId);
    return {
      ...s,
      name: p?.name ?? null,
      teamNames: (p?.teamIds ?? []).flatMap((id) => {
        const n = teamName.get(id);
        return n ? [n] : [];
      }),
      avgSeconds: averageRecording(s),
    };
  });
}

export const SUMMARY_SORT_KEYS = [
  'name',
  'calls',
  'answered',
  'recorded',
  'recordedSeconds',
  'avgSeconds',
  'longestSeconds',
  'lastRecordedAt',
] as const;
export type SummarySortKey = (typeof SUMMARY_SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

/** Who recorded most first: the page's opening order. */
export const DEFAULT_SUMMARY_SORT: { key: SummarySortKey; dir: SortDir } = {
  key: 'recorded',
  dir: 'desc',
};

function sortValue(r: SummaryRow, key: SummarySortKey): string | number | null {
  if (key === 'name') return r.name?.toLocaleLowerCase() ?? null;
  if (key === 'lastRecordedAt')
    return r.lastRecordedAt ? Date.parse(r.lastRecordedAt) : null;
  return r[key];
}

/**
 * The rows sorted by `key`. A missing figure (no name, no recording)
 * sorts last either way; ties fall back to the name, so the order is
 * stable across refreshes.
 */
export function sortSummary(
  rows: readonly SummaryRow[],
  key: SummarySortKey,
  dir: SortDir
): SummaryRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  const byName = (a: SummaryRow, b: SummaryRow) =>
    a.name === b.name
      ? 0
      : a.name === null
        ? 1
        : b.name === null
          ? -1
          : a.name.localeCompare(b.name);
  return [...rows].sort((a, b) => {
    const x = sortValue(a, key);
    const y = sortValue(b, key);
    if (x === null || y === null) {
      if (x !== y) return x === null ? 1 : -1;
      return byName(a, b);
    }
    const c =
      typeof x === 'string' || typeof y === 'string'
        ? String(x).localeCompare(String(y))
        : x - y;
    return c !== 0 ? sign * c : byName(a, b);
  });
}

/** A header click: the same column flips, another starts high-first. */
export function nextSort(
  current: { key: SummarySortKey; dir: SortDir },
  key: SummarySortKey
): { key: SummarySortKey; dir: SortDir } {
  if (current.key === key)
    return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'name' ? 'asc' : 'desc' };
}

// ---------- The list ----------

export interface RecordingDay<T> {
  /** YYYY-MM-DD in the zone. */
  key: string;
  items: T[];
}

/**
 * Consecutive runs of one day in `timeZone`, in the input's order (the
 * route lists newest first). Pages appended later extend the last day
 * rather than repeating its heading.
 */
export function groupRecordingsByDay<T extends { startedAt: string }>(
  calls: readonly T[],
  timeZone: string
): RecordingDay<T>[] {
  const days: RecordingDay<T>[] = [];
  for (const c of calls) {
    const key = dayKey(c.startedAt, timeZone);
    const last = days[days.length - 1];
    if (last && last.key === key) last.items.push(c);
    else days.push({ key, items: [c] });
  }
  return days;
}

/** 'Mon 3 Nov' for a YYYY-MM-DD (a calendar day: no zone to apply). */
export function dayHeading(key: string, locale: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
