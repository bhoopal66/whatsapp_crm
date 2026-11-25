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
  type InboxSnoozed,
  type InboxSort,
} from './ui';
import type { CaseRole } from './types';

/** The search box is a moment's question, never part of a saved view. */
export type ViewFilters = Omit<InboxFilters, 'sort' | 'q' | 'snoozed'> & {
  snoozed: InboxSnoozed;
};

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
  const { sort: _sort, q: _q, ...defaults } = EMPTY_FILTERS;
  void _sort;
  void _q;
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
  const { sort: _sort, q: _q, ...rest } = f;
  void _sort;
  void _q;
  return { ...rest, snoozed: f.snoozed ?? 'hide' };
}

/** The sort a view stores: null when it is the inbox default. */
export function viewSortFromInbox(f: InboxFilters): InboxSort | null {
  return f.sort === EMPTY_FILTERS.sort ? null : f.sort;
}

/** Applying a view: its filters, and its sort (else the default). */
export function inboxFiltersFromView(
  view: Pick<SavedView, 'filters' | 'sort'>
): InboxFilters {
  return {
    ...view.filters,
    // 'hide' is what a view stores when no mode was chosen.
    snoozed: view.filters.snoozed === 'hide' ? null : view.filters.snoozed,
    q: null,
    sort: view.sort ?? EMPTY_FILTERS.sort,
  };
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

/** One note that mentions the signed-in person, as GET /api/cases/mentions lists it. */
export interface MentionItem {
  noteId: string;
  caseId: string;
  stage: string | null;
  /** null: an automatic note. */
  authorId: string | null;
  createdAt: string | null;
  body: string;
}

/** Tolerant of junk: rows without a note id and case id are dropped. */
export function parseMentions(payload: unknown): {
  items: MentionItem[];
  next: string | null;
} {
  if (typeof payload !== 'object' || payload === null)
    return { items: [], next: null };
  const p = payload as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v !== '' ? v : null;
  const items: MentionItem[] = [];
  if (Array.isArray(p.items))
    for (const raw of p.items) {
      if (typeof raw !== 'object' || raw === null) continue;
      const r = raw as Record<string, unknown>;
      const noteId = str(r.noteId);
      const caseId = str(r.caseId);
      if (!noteId || !caseId) continue;
      items.push({
        noteId,
        caseId,
        stage: str(r.stage),
        authorId: str(r.authorId),
        createdAt: str(r.createdAt),
        body: typeof r.body === 'string' ? r.body : '',
      });
    }
  return { items, next: str(p.next) };
}

/** A note on one line: trimmed, whitespace collapsed, cut with an ellipsis. */
export function mentionPreview(body: string, max = 160): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
