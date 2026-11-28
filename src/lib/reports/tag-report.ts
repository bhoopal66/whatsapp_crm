// ============================================================
// The chat tag report (migration 255, docs/chat-tag-report.md).
//
// `chat_tag_report()` returns the whole page as one jsonb: the
// workspace's tags, the chats on each tag now (split by sub-tag, agent,
// number and lead source) and the chats that arrived at each tag in
// the period. Counts only: no chat text, customer name or phone number
// ever comes back. This module parses that answer defensively and
// shapes it for the page and the CSV. Pure: no I/O.
// ============================================================

export interface ReportTag {
  id: string;
  parentId: string | null;
  name: string;
  color: string | null;
  subTagTitle: string | null;
  position: number;
}

/** Chats on (or arriving at) a main tag and one of its sub-tags. */
export interface TagCount {
  tagId: string;
  subTagId: string | null;
  chats: number;
}

/** Chats on a main tag, split by agent, number or lead source. */
export interface SplitCount {
  tagId: string;
  /** Agent auth user id, number id or lead source; null = none. */
  key: string | null;
  /** Agent or number display name (null for a lead source or none). */
  name: string | null;
  chats: number;
}

export interface DailyCount {
  /** YYYY-MM-DD in the account's time zone. */
  day: string;
  tagId: string;
  chats: number;
}

export interface ChatTagReport {
  /** When the tag log began: movement is counted from here. */
  historySince: string | null;
  tags: ReportTag[];
  current: TagCount[];
  byAgent: SplitCount[];
  byNumber: SplitCount[];
  bySource: SplitCount[];
  arrivals: TagCount[];
  arrivalsDaily: DailyCount[];
}

export const SPLITS = ['agent', 'number', 'source'] as const;
export type SplitKind = (typeof SPLITS)[number];

export function isSplitKind(value: unknown): value is SplitKind {
  return (
    typeof value === 'string' && (SPLITS as readonly string[]).includes(value)
  );
}

// ---------- parsing ----------

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

/** A non-negative whole count; anything else is 0. */
function count(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : 0;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseTag(o: Obj): ReportTag | null {
  const id = str(o.id);
  if (!id) return null;
  const position = Number(o.position);
  return {
    id,
    parentId: str(o.parent_id),
    name: str(o.name) ?? '',
    color: str(o.color),
    subTagTitle: str(o.sub_tag_title),
    position: Number.isFinite(position) ? position : 0,
  };
}

function parseTagCount(o: Obj): TagCount | null {
  const tagId = str(o.tag_id);
  if (!tagId) return null;
  return { tagId, subTagId: str(o.sub_tag_id), chats: count(o.chats) };
}

function parseSplit(o: Obj): SplitCount | null {
  const tagId = str(o.tag_id);
  if (!tagId) return null;
  return {
    tagId,
    key: str(o.key),
    name: str(o.name),
    chats: count(o.chats),
  };
}

function parseDaily(o: Obj): DailyCount | null {
  const tagId = str(o.tag_id);
  const day = str(o.day);
  if (!tagId || !day || !DAY_RE.test(day)) return null;
  return { day, tagId, chats: count(o.chats) };
}

function keep<T>(rows: Obj[], parse: (o: Obj) => T | null): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const parsed = parse(row);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** The RPC's answer, tolerating missing or malformed parts. */
export function parseChatTagReport(raw: unknown): ChatTagReport {
  const o = isObj(raw) ? raw : {};
  const since = str(o.history_since);
  return {
    historySince: since && !Number.isNaN(Date.parse(since)) ? since : null,
    tags: keep(arr(o.tags), parseTag),
    current: keep(arr(o.current), parseTagCount),
    byAgent: keep(arr(o.by_agent), parseSplit),
    byNumber: keep(arr(o.by_number), parseSplit),
    bySource: keep(arr(o.by_source), parseSplit),
    arrivals: keep(arr(o.arrivals), parseTagCount),
    arrivalsDaily: keep(arr(o.arrivals_daily), parseDaily),
  };
}

// ---------- shaping ----------

/** "Main tag · Sub-tag", or the main tag alone. */
export function tagLabel(main: string, sub?: string | null): string {
  return sub ? `${main} · ${sub}` : main;
}

export interface SubTagRow {
  subTagId: string | null;
  /** The sub-tag's name; null for chats with no sub-tag. */
  subTagName: string | null;
  chats: number;
}

export interface TagGroup {
  tagId: string;
  /** Null when the tag is not in the list (deleted since). */
  tag: ReportTag | null;
  total: number;
  /** Sub-tag rows, largest first; chats with no sub-tag last. */
  rows: SubTagRow[];
}

function tagIndex(tags: readonly ReportTag[]): Map<string, ReportTag> {
  return new Map(tags.map((t) => [t.id, t]));
}

/**
 * Counts grouped by main tag: each main tag's total is the sum over
 * its sub-tags, chats with no sub-tag included. Main tags in the
 * workspace's order (position, then name); tags with no chats left out.
 */
export function tagGroups(
  tags: readonly ReportTag[],
  counts: readonly TagCount[]
): TagGroup[] {
  const byId = tagIndex(tags);
  const groups = new Map<string, TagGroup>();
  for (const c of counts) {
    if (c.chats <= 0) continue;
    let g = groups.get(c.tagId);
    if (!g) {
      g = {
        tagId: c.tagId,
        tag: byId.get(c.tagId) ?? null,
        total: 0,
        rows: [],
      };
      groups.set(c.tagId, g);
    }
    g.total += c.chats;
    const existing = g.rows.find((r) => r.subTagId === c.subTagId);
    if (existing) existing.chats += c.chats;
    else
      g.rows.push({
        subTagId: c.subTagId,
        subTagName: c.subTagId ? (byId.get(c.subTagId)?.name ?? null) : null,
        chats: c.chats,
      });
  }
  for (const g of groups.values()) {
    g.rows.sort((a, b) => {
      if ((a.subTagId === null) !== (b.subTagId === null))
        return a.subTagId === null ? 1 : -1;
      return b.chats - a.chats;
    });
  }
  return [...groups.values()].sort((a, b) => compareTags(a.tag, b.tag));
}

/** Known tags by position then name; an unknown tag last. */
function compareTags(a: ReportTag | null, b: ReportTag | null): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return a.position - b.position || a.name.localeCompare(b.name);
}

/** Total chats over every group. */
export function groupsTotal(groups: readonly TagGroup[]): number {
  return groups.reduce((sum, g) => sum + g.total, 0);
}

/** The split rows of one kind. */
export function splitRows(
  report: ChatTagReport,
  kind: SplitKind
): SplitCount[] {
  switch (kind) {
    case 'agent':
      return report.byAgent;
    case 'number':
      return report.byNumber;
    case 'source':
      return report.bySource;
  }
}

/** One tag's split, largest first ("none" last). */
export function splitFor(
  rows: readonly SplitCount[],
  tagId: string
): SplitCount[] {
  return rows
    .filter((r) => r.tagId === tagId && r.chats > 0)
    .sort((a, b) => {
      const an = a.key === null || a.key === 'none';
      const bn = b.key === null || b.key === 'none';
      if (an !== bn) return an ? 1 : -1;
      return b.chats - a.chats;
    });
}

export interface DailySeries {
  /** One row per day: `{ day, [category]: chats }`. */
  data: Array<Record<string, string | number>>;
  /** One category per main tag, in the workspace's order. */
  categories: string[];
  /** The chart colour nearest each tag's own colour, per category. */
  colors: ChartColorName[];
}

/** The chart palette (`components/tremor/chart-colors.ts`). */
export type ChartColorName =
  | 'blue'
  | 'emerald'
  | 'violet'
  | 'amber'
  | 'gray'
  | 'cyan'
  | 'pink'
  | 'lime'
  | 'fuchsia';

const PALETTE_HUES: ReadonlyArray<[ChartColorName, number]> = [
  ['blue', 217],
  ['emerald', 160],
  ['violet', 258],
  ['amber', 38],
  ['cyan', 189],
  ['pink', 330],
  ['lime', 84],
  ['fuchsia', 292],
];

/**
 * The palette colour nearest a tag's stored `#rrggbb`, by hue, so a
 * tag's bars match its dot; grey for a washed-out colour or bad input.
 */
export function nearestChartColor(
  hex: string | null | undefined
): ChartColorName {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
  if (!m) return 'gray';
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (max === 0 || d / max < 0.2) return 'gray';
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  const hue = (h * 60 + 360) % 360;
  let best: ChartColorName = 'gray';
  let bestDist = Infinity;
  for (const [name, ph] of PALETTE_HUES) {
    const dist = Math.min(Math.abs(hue - ph), 360 - Math.abs(hue - ph));
    if (dist < bestDist) {
      bestDist = dist;
      best = name;
    }
  }
  return best;
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Daily arrivals per main tag for a bar chart: every day from the first
 * to the last arrival (gaps filled with zeros), a category per tag named
 * by its label (a repeated name gets a number so no series is lost).
 */
export function dailySeries(report: ChatTagReport): DailySeries {
  const byId = tagIndex(report.tags);
  const tagIds = [...new Set(report.arrivalsDaily.map((d) => d.tagId))].sort(
    (a, b) => compareTags(byId.get(a) ?? null, byId.get(b) ?? null)
  );
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const id of tagIds) {
    const base = byId.get(id)?.name || '?';
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base} (${i})`;
    used.add(name);
    names.set(id, name);
  }
  const days = report.arrivalsDaily.map((d) => d.day).sort();
  if (days.length === 0) return { data: [], categories: [], colors: [] };
  const rows = new Map<string, Record<string, string | number>>();
  const last = days[days.length - 1];
  // A hard stop well beyond the SQL's 400-day cap.
  for (let day = days[0], n = 0; day <= last && n < 500; day = nextDay(day)) {
    const row: Record<string, string | number> = { day };
    for (const id of tagIds) row[names.get(id)!] = 0;
    rows.set(day, row);
    n++;
  }
  for (const d of report.arrivalsDaily) {
    const row = rows.get(d.day);
    const name = names.get(d.tagId);
    if (row && name) row[name] = Number(row[name] ?? 0) + d.chats;
  }
  return {
    data: [...rows.values()],
    categories: tagIds.map((id) => names.get(id)!),
    colors: tagIds.map((id) => nearestChartColor(byId.get(id)?.color)),
  };
}

// ---------- CSV ----------

export interface TagCsvLabels {
  /** Section names, by key. */
  sections: Record<
    'current' | 'agent' | 'number' | 'source' | 'arrivals' | 'daily',
    string
  >;
  unknownTag: string;
  noSubTag: string;
  unassigned: string;
  noNumber: string;
  /** An agent or number no longer in the workspace. */
  unknownName: string;
  /** A lead source's display name (`none` = no source recorded). */
  source: (key: string) => string;
}

export const TAG_CSV_HEADER = [
  'Section',
  'Main tag',
  'Sub-tag',
  'Breakdown',
  'Day',
  'Chats',
] as const;

export const DEFAULT_TAG_CSV_LABELS: TagCsvLabels = {
  sections: {
    current: 'Chats on the tag now',
    agent: 'Now, by agent',
    number: 'Now, by number',
    source: 'Now, by lead source',
    arrivals: 'Arrived in the period',
    daily: 'Arrived per day',
  },
  unknownTag: 'Unknown tag',
  noSubTag: 'No sub-tag',
  unassigned: 'Unassigned',
  noNumber: 'No number',
  unknownName: 'Unknown',
  source: (key) => (key === 'none' ? 'Unknown' : key),
};

/**
 * The report as CSV rows under {@link TAG_CSV_HEADER}: current counts
 * per tag and sub-tag, each split, arrivals and daily arrivals. Values
 * go through `buildCsv`, which quotes and neutralises them.
 */
export function tagCsvRows(
  report: ChatTagReport,
  labels: TagCsvLabels = DEFAULT_TAG_CSV_LABELS
): Array<Array<string | number>> {
  const byId = tagIndex(report.tags);
  const main = (id: string) => byId.get(id)?.name || labels.unknownTag;
  const out: Array<Array<string | number>> = [];

  const counts = (section: string, rows: readonly TagCount[]) => {
    for (const g of tagGroups(report.tags, rows)) {
      for (const r of g.rows) {
        out.push([
          section,
          main(g.tagId),
          r.subTagId ? (r.subTagName ?? labels.unknownTag) : labels.noSubTag,
          '',
          '',
          r.chats,
        ]);
      }
    }
  };
  counts(labels.sections.current, report.current);

  const splits: Array<[SplitKind, string]> = [
    ['agent', labels.sections.agent],
    ['number', labels.sections.number],
    ['source', labels.sections.source],
  ];
  const groups = tagGroups(report.tags, report.current);
  for (const [kind, section] of splits) {
    const rows = splitRows(report, kind);
    for (const g of groups) {
      for (const r of splitFor(rows, g.tagId)) {
        out.push([
          section,
          main(g.tagId),
          '',
          splitName(kind, r, labels),
          '',
          r.chats,
        ]);
      }
    }
  }

  counts(labels.sections.arrivals, report.arrivals);

  const daily = [...report.arrivalsDaily].sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      compareTags(byId.get(a.tagId) ?? null, byId.get(b.tagId) ?? null)
  );
  for (const d of daily) {
    out.push([labels.sections.daily, main(d.tagId), '', '', d.day, d.chats]);
  }
  return out;
}

/** A split row's display name. */
export function splitName(
  kind: SplitKind,
  row: SplitCount,
  labels: Pick<
    TagCsvLabels,
    'unassigned' | 'noNumber' | 'unknownName' | 'source'
  >
): string {
  switch (kind) {
    case 'agent':
      return row.key ? (row.name ?? labels.unknownName) : labels.unassigned;
    case 'number':
      return row.key ? (row.name ?? labels.unknownName) : labels.noNumber;
    case 'source':
      return labels.source(row.key ?? 'none');
  }
}
