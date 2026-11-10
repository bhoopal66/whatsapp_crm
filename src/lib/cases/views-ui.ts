/**
 * Saved views and snooze for the Cases inbox, client side. Pure: no store,
 * no server import (views.ts is the server half and reads the database).
 *
 * A saved view is the inbox's filters without `sort`, plus its own `sort`
 * (null: the inbox default). The server also stores a `snoozeExpired`
 * filter that the inbox has no control for yet; it is read past and never
 * written back.
 */
import {
  EMPTY_FILTERS,
  INBOX_SORTS,
  parseDays,
  PRIORITIES,
  SLA_STATES,
  SNOOZED_MODES,
  type InboxFilters,
  type InboxRow,
  type InboxSort,
} from './ui';
import type { CaseRole } from './types';

export type ViewFilters = Omit<InboxFilters, 'sort'>;

export interface SavedView {
  viewId: string;
  ownerUserId: string;
  name: string;
  filters: ViewFilters;
  /** null: the inbox default order. */
  sort: InboxSort | null;
  shared: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export type SnoozePresetKey = 'tomorrow' | 'in3days' | 'nextWeek';

export interface SnoozePreset {
  key: SnoozePresetKey;
  until: Date;
}

/** 185: a snooze ends in (now, now + 30 days]. */
export const SNOOZE_MAX_DAYS = 30;
const DAY_MS = 86_400_000;
const SNOOZE_HOUR = 9;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const optStr = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;
const pick = <T extends string>(list: readonly T[], v: unknown): T | null =>
  typeof v === 'string' && (list as readonly string[]).includes(v)
    ? (v as T)
    : null;

function parseViewFilters(raw: unknown): ViewFilters {
  const f = isObj(raw) ? raw : {};
  const { sort: _sort, ...defaults } = EMPTY_FILTERS;
  void _sort;
  return {
    ...defaults,
    bank: optStr(f.bank),
    stage: optStr(f.stage),
    agent: optStr(f.agent),
    priority: pick(PRIORITIES, f.priority),
    slaState: pick(SLA_STATES, f.slaState),
    customerWaiting: f.customerWaiting === true,
    documentsMissing: f.documentsMissing === true,
    bankQueryOpen: f.bankQueryOpen === true,
    includeClosed: f.includeClosed === true,
    noActivityDays:
      typeof f.noActivityDays === 'number'
        ? parseDays(String(f.noActivityDays))
        : null,
    snoozed: pick(SNOOZED_MODES, f.snoozed) ?? 'hide',
    mentionedMe: f.mentionedMe === true,
  };
}

/** GET /api/cases/views, tolerant of a missing or malformed body. */
export function parseViews(payload: unknown): SavedView[] {
  if (!isObj(payload) || !Array.isArray(payload.views)) return [];
  const out: SavedView[] = [];
  for (const v of payload.views) {
    if (!isObj(v)) continue;
    const viewId = optStr(v.viewId);
    const name = optStr(v.name);
    if (!viewId || !name) continue;
    out.push({
      viewId,
      ownerUserId: optStr(v.ownerUserId) ?? '',
      name,
      filters: parseViewFilters(v.filters),
      sort: pick(INBOX_SORTS, v.sort),
      shared: v.shared === true,
      createdAt: optStr(v.createdAt),
      updatedAt: optStr(v.updatedAt),
    });
  }
  return out;
}

/** The inbox filters a view stores: everything but `sort`. */
export function viewFiltersFromInbox(f: InboxFilters): ViewFilters {
  const { sort: _sort, ...rest } = f;
  void _sort;
  return rest;
}

/** The sort a view stores: null when it is the inbox default. */
export function viewSortFromInbox(f: InboxFilters): InboxSort | null {
  return f.sort === EMPTY_FILTERS.sort ? null : f.sort;
}

/** Applying a view: its filters, and its sort (else the default). */
export function inboxFiltersFromView(
  view: Pick<SavedView, 'filters' | 'sort'>
): InboxFilters {
  return { ...view.filters, sort: view.sort ?? EMPTY_FILTERS.sort };
}

/* ---- snooze ---- */

const PARTS = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = PARTS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    PARTS.set(timeZone, f);
  }
  return f;
}

/** The wall clock in `timeZone` at instant `ms`, read as if it were UTC. */
function wallAsUtc(ms: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms)))
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** The instant at which `timeZone`'s wall clock reads the given time. */
function zonedToInstant(
  y: number,
  m: number,
  d: number,
  hour: number,
  timeZone: string
): number {
  const want = Date.UTC(y, m, d, hour);
  let guess = want;
  // Two passes settle any offset, DST edges included.
  for (let i = 0; i < 2; i++)
    guess = want - (wallAsUtc(guess, timeZone) - guess);
  return guess;
}

/**
 * Tomorrow, in 3 days and next Monday, each at 09:00 in `timeZone`, and
 * never past now + 30 days. "Next week" is the first Monday after today.
 */
export function snoozePresets(now: Date, timeZone: string): SnoozePreset[] {
  const today = new Date(wallAsUtc(now.getTime(), timeZone));
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const d = today.getUTCDate();
  const dow = today.getUTCDay();
  const toMonday = (8 - dow) % 7 || 7;
  const cap = now.getTime() + SNOOZE_MAX_DAYS * DAY_MS;
  const at = (days: number) =>
    new Date(
      Math.min(zonedToInstant(y, m, d + days, SNOOZE_HOUR, timeZone), cap)
    );
  return [
    { key: 'tomorrow', until: at(1) },
    { key: 'in3days', until: at(3) },
    { key: 'nextWeek', until: at(toMonday) },
  ];
}

/** 185's rule: the end is in (now, now + 30 days]. */
export function isValidSnoozeUntil(until: Date, now: Date): boolean {
  const u = until.getTime();
  const n = now.getTime();
  return (
    Number.isFinite(u) &&
    Number.isFinite(n) &&
    u > n &&
    u <= n + SNOOZE_MAX_DAYS * DAY_MS
  );
}

/** "Snoozed until 21 Oct, 09:00" / "Snooze ended 21 Oct, 09:00"; null when none. */
export function snoozeLabel(
  row: Pick<InboxRow, 'snoozedUntil' | 'snoozeExpired'>,
  locale: string,
  timeZone: string
): string | null {
  if (!row.snoozedUntil) return null;
  const t = new Date(row.snoozedUntil);
  if (Number.isNaN(t.getTime())) return null;
  const when = new Intl.DateTimeFormat(locale, {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(t);
  return row.snoozeExpired ? `Snooze ended ${when}` : `Snoozed until ${when}`;
}

/** Who may snooze a case (185 decides; this only shows or hides the button). */
export function canSnoozeCase(role: CaseRole): boolean {
  return (
    role === 'super_admin' ||
    role === 'admin' ||
    role === 'team_lead' ||
    role === 'coordinator'
  );
}
