/**
 * My uploads (the desk's `mine` tab) in plain words: the summary line,
 * the filter chips and their counts, the search, day headings and times,
 * each row's status and its one next action, the empty states, and the
 * link that starts a fresh upload for a rejected one. Pure, like
 * `friendly.ts`: text comes back as `DeskFriendly` keys plus values, and
 * nothing here decides what the server decides (filing, queues).
 */
import type { DayGroup, FriendlyText } from './friendly';
import type { ItemKind, ItemState, MyItem } from './store';

/**
 * The desk counts its days in Dubai (queue alerts in `escalate.ts`, leave
 * in `cover.ts`); there is no per-account zone to read.
 */
export const DESK_TIME_ZONE = 'Asia/Dubai';

// ---------- Filters and counts ----------

export const MINE_FILTERS = [
  'all',
  'attention',
  'untagged',
  'rejected',
  'filed',
  'duplicate',
] as const;
export type MineFilter = (typeof MINE_FILTERS)[number];

type StateOnly = Pick<MyItem, 'state'>;

/** Waiting in a sorting queue or rejected: the uploader has something to do. */
export function needsAttention(item: StateOnly): boolean {
  return item.state === 'untagged' || item.state === 'rejected';
}

export function matchesFilter(item: StateOnly, filter: MineFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'attention') return needsAttention(item);
  return item.state === filter;
}

/** How many uploads each chip would show. */
export function countMine(
  items: readonly StateOnly[]
): Record<MineFilter, number> {
  const out = Object.fromEntries(MINE_FILTERS.map((f) => [f, 0])) as Record<
    MineFilter,
    number
  >;
  for (const it of items)
    for (const f of MINE_FILTERS) if (matchesFilter(it, f)) out[f] += 1;
  return out;
}

// ---------- Search ----------

type Searchable = Pick<
  MyItem,
  'caseNumber' | 'caseRef' | 'companyName' | 'originalName' | 'docKey'
>;

/**
 * Uploads whose case number (or the number typed), company, file name or
 * document type (its key or its label) holds the query, ignoring case and
 * the spaces around it. An empty query keeps everything.
 */
export function searchMine<T extends Searchable>(
  items: readonly T[],
  query: string,
  docLabel: (key: string) => string = (k) => k
): T[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...items];
  return items.filter((it) =>
    [
      it.caseNumber,
      it.caseRef,
      it.companyName,
      it.originalName,
      it.docKey,
      it.docKey ? docLabel(it.docKey) : null,
    ].some((v) => v !== null && v !== undefined && v.toLowerCase().includes(q))
  );
}

// ---------- Summary ----------

function dayIn(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * "4 uploads today · 2 need your attention" (attention over every loaded
 * upload, whatever its day), or the calm variant when none do.
 */
export function mineSummary(
  items: readonly Pick<MyItem, 'state' | 'receivedAt'>[],
  now: Date,
  timeZone: string = DESK_TIME_ZONE
): FriendlyText {
  const today = dayIn(now, timeZone);
  let count = 0;
  let attention = 0;
  for (const it of items) {
    const d = new Date(it.receivedAt);
    if (!Number.isNaN(d.getTime()) && dayIn(d, timeZone) === today) count += 1;
    if (needsAttention(it)) attention += 1;
  }
  return attention > 0
    ? { key: 'mine.summary', values: { count, attention } }
    : { key: 'mine.summaryClear', values: { count } };
}

// ---------- Days and times ----------

/** "Today", "Yesterday", or the weekday and date ("Monday 24 November"). */
export function dayHeading(
  group: Pick<DayGroup<unknown>, 'day' | 'when'>,
  locale: string
): FriendlyText {
  if (group.when === 'today') return { key: 'mine.day.today' };
  if (group.when === 'yesterday') return { key: 'mine.day.yesterday' };
  const d = new Date(`${group.day}T12:00:00Z`);
  if (group.day === '' || Number.isNaN(d.getTime()))
    return { key: 'mine.day.unknown' };
  const date = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(d);
  return { key: 'mine.day.earlier', values: { date } };
}

/** The time of day as HH:MM (24-hour) in the desk's zone; '' if unreadable. */
export function timeText(
  iso: string,
  locale: string,
  timeZone: string = DESK_TIME_ZONE
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}

// ---------- One row ----------

/** The status word; the colour beside it is never the only signal. */
export function statusKey(state: ItemState): string {
  return `mine.status.${state}`;
}

export type MineAction = 'fix' | 'uploadAgain' | null;

/** The one next step: fix a queued upload, resend a rejected one. */
export function mineAction(item: StateOnly): MineAction {
  if (item.state === 'untagged') return 'fix';
  if (item.state === 'rejected') return 'uploadAgain';
  return null;
}

/**
 * Who sent a duplicate first, as far as the row says: the item carries
 * only the first uploader's id, so it is "you" or "a colleague", never a
 * name.
 */
export function duplicateLine(
  item: Pick<MyItem, 'state' | 'duplicateOfUploader'>,
  myUserId: string | null | undefined
): FriendlyText | null {
  if (item.state !== 'duplicate') return null;
  if (!item.duplicateOfUploader) return { key: 'mine.duplicate.plain' };
  return item.duplicateOfUploader === myUserId
    ? { key: 'mine.duplicate.you' }
    : { key: 'mine.duplicate.colleague' };
}

// ---------- Empty states ----------

export type MineEmpty = 'none' | 'noMatch' | 'allFiled';

/** Which empty state shows, or null when there are rows to show. */
export function mineEmpty(i: {
  total: number;
  shown: number;
  filter: MineFilter;
  query: string;
}): MineEmpty | null {
  if (i.total === 0) return 'none';
  if (i.shown > 0) return null;
  if (i.filter === 'attention' && i.query.trim() === '') return 'allFiled';
  return 'noMatch';
}

// ---------- Upload again ----------

const KINDS: readonly ItemKind[] = ['new_case', 'pending_doc', 'info'];
/** Longer than any case number or caption code; a pasted essay is dropped. */
const MAX_CASE_PARAM = 64;

export const PREFILL_PARAMS = ['kind', 'case'] as const;

export interface UploadPrefill {
  kind: ItemKind | '';
  caseRef: string;
}

/**
 * The Upload tab (the desk's default tab, so plain `/desk`) with a
 * rejected upload's kind and case filled in. Only what the person may
 * retype anyway goes into the link; the server decides as for any upload.
 */
export function uploadAgainHref(
  item: Pick<MyItem, 'kind' | 'caseNumber' | 'caseRef'>
): string {
  const p = new URLSearchParams();
  if (item.kind) p.set('kind', item.kind);
  const ref =
    item.kind === 'new_case' ? null : (item.caseNumber ?? item.caseRef);
  if (ref) p.set('case', ref);
  const qs = p.toString();
  return qs ? `/desk?${qs}` : '/desk';
}

/** What the link above carries, checked; null when it carries nothing. */
export function uploadPrefill(params: {
  get(name: string): string | null;
}): UploadPrefill | null {
  const rawKind = params.get('kind') ?? '';
  const kind = (KINDS as readonly string[]).includes(rawKind)
    ? (rawKind as ItemKind)
    : '';
  const rawCase = (params.get('case') ?? '').trim();
  const caseRef =
    kind === 'new_case' || rawCase.length > MAX_CASE_PARAM ? '' : rawCase;
  return kind === '' && caseRef === '' ? null : { kind, caseRef };
}
