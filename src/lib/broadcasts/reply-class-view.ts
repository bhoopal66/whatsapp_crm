// ============================================================
// Campaign reply sorting, the broadcast screen's side (docs/jev-insights.md,
// "Campaign reply sorting"; migration 148).
//
// Pure view logic for the Replies card: which classes to draw, in what
// order, with what share, and how the recipients table filters on one.
// Dependency-free on purpose: the detail page is a client component, and
// the server module (`./reply-class`) reaches the admin client. The class
// list is restated here rather than imported from the Jev question file
// (which pulls in the SDK); reply-class-view.test.ts pins the two equal.
// ============================================================

/** In 148's CHECK order, which is also the display order. */
export const REPLY_CLASS_ORDER = [
  'interested',
  'question',
  'not_now',
  'not_interested',
  'wrong_person',
  'stop',
  'other',
] as const;

export type ReplyClassName = (typeof REPLY_CLASS_ORDER)[number];

export function isReplyClass(value: unknown): value is ReplyClassName {
  return (
    typeof value === 'string' &&
    (REPLY_CLASS_ORDER as readonly string[]).includes(value)
  );
}

/** Message key under the `ReplyClasses` namespace for a class's label. */
export const REPLY_CLASS_LABEL_KEY: Record<ReplyClassName, string> = {
  interested: 'interested',
  question: 'question',
  not_now: 'notNow',
  not_interested: 'notInterested',
  wrong_person: 'wrongPerson',
  stop: 'stop',
  other: 'other',
};

/**
 * Identity colours, a shade per mode. Seven distinct hues rather than
 * the status tokens, because two classes sharing a token would draw as
 * one segment in the bar.
 */
export const REPLY_CLASS_TONE: Record<
  ReplyClassName,
  { bar: string; chip: string }
> = {
  interested: {
    bar: 'bg-emerald-500 dark:bg-emerald-400',
    chip: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
  question: {
    bar: 'bg-sky-500 dark:bg-sky-400',
    chip: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  },
  not_now: {
    bar: 'bg-violet-500 dark:bg-violet-400',
    chip: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  },
  not_interested: {
    bar: 'bg-amber-500 dark:bg-amber-400',
    chip: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
  wrong_person: {
    bar: 'bg-pink-500 dark:bg-pink-400',
    chip: 'border-pink-500/30 bg-pink-500/10 text-pink-700 dark:text-pink-300',
  },
  stop: {
    bar: 'bg-red-600 dark:bg-red-500',
    chip: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
  },
  other: {
    bar: 'bg-slate-400 dark:bg-slate-500',
    chip: 'border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300',
  },
};

export interface ReplySegment {
  cls: ReplyClassName;
  count: number;
  /** Exact share of the sorted replies, 0–100: the bar width. */
  share: number;
  /** Whole percent; the segments' percents sum to exactly 100. */
  percent: number;
}

/**
 * One segment per class with any replies, in display order. Percents
 * use largest-remainder rounding so the legend always adds up to 100;
 * equal remainders go to the class that comes first. Unknown keys and
 * non-positive or non-finite counts are ignored.
 */
export function buildReplySegments(
  counts: Partial<Record<string, number>> | null | undefined
): ReplySegment[] {
  const present = REPLY_CLASS_ORDER.flatMap((cls) => {
    const n = counts?.[cls];
    return typeof n === 'number' && Number.isFinite(n) && n > 0
      ? [{ cls, count: Math.floor(n) }]
      : [];
  }).filter((s) => s.count > 0);
  const total = present.reduce((sum, s) => sum + s.count, 0);
  if (total === 0) return [];

  const raw = present.map((s, i) => {
    const exact = (s.count * 100) / total;
    return { ...s, i, exact, floor: Math.floor(exact) };
  });
  let left = 100 - raw.reduce((sum, s) => sum + s.floor, 0);
  const bonus = new Set<number>();
  for (const s of [...raw].sort(
    (a, b) => b.exact - b.floor - (a.exact - a.floor) || a.i - b.i
  )) {
    if (left <= 0) break;
    bonus.add(s.i);
    left -= 1;
  }
  return raw.map((s) => ({
    cls: s.cls,
    count: s.count,
    share: s.exact,
    percent: s.floor + (bonus.has(s.i) ? 1 : 0),
  }));
}

/** "31%", or "<1%" for a class that has replies but rounds to nothing. */
export function formatSegmentPercent(segment: ReplySegment): string {
  return segment.percent === 0 && segment.count > 0
    ? '<1%'
    : `${segment.percent}%`;
}

/** Does a recipient row pass the class filter (null = no filter)? */
export function matchesReplyClassFilter(
  row: { reply_class?: string | null },
  filter: ReplyClassName | null
): boolean {
  return filter === null || row.reply_class === filter;
}

export interface ReplyClassSummary {
  enabled: boolean;
  available: boolean;
  unclassifiedReplies: number;
}

/**
 * What the card offers under the bar: the backfill button, or why there
 * is none. The switch comes first: with it off, Jev's availability is
 * not the person's problem yet.
 */
export function replySortAction(
  s: ReplyClassSummary
): 'sort' | 'turn_on' | 'unavailable' | null {
  if (!s.enabled) return 'turn_on';
  if (!s.available) return 'unavailable';
  return s.unclassifiedReplies > 0 ? 'sort' : null;
}

/**
 * The backfill loop. Calls `classifyOnce` until a call sorts nothing —
 * not until `remaining` is 0, because some replies can never be sorted
 * (no text, no local template row) and would keep it above zero
 * forever. Reports the running total after each call; stops early when
 * `shouldStop` says so (the card unmounted). A thrown error propagates.
 */
export async function sortPastReplies(
  classifyOnce: () => Promise<{ classified: number }>,
  onProgress: (sortedSoFar: number) => void,
  shouldStop: () => boolean = () => false
): Promise<number> {
  let sorted = 0;
  while (!shouldStop()) {
    const { classified } = await classifyOnce();
    if (!(classified > 0)) break;
    sorted += classified;
    onProgress(sorted);
  }
  return sorted;
}
