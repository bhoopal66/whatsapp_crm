/**
 * Knowledge-gap topics (job I, docs/jev-insights.md): groups the
 * questions the bot refused to answer (ai_knowledge_gaps, migration 052)
 * into topics, so an admin reviews "POS without a trade licence ×37"
 * instead of 37 near-identical rows.
 *
 * Pure and deterministic: no I/O, clock or randomness. The same rows in
 * any order give the same topics, so a recompute re-forms the same
 * topics and an admin's dismissal can be carried over (`carryOverStatus`).
 */

export interface GapRow {
  id: string;
  question: string;
  /** ISO timestamp. */
  createdAt: string;
  /** Present only when the account has an embeddings key. */
  embedding?: number[] | null;
}

export interface GapTopic {
  /** Newest first. */
  memberIds: string[];
  /** The medoid's question: the member most like all the others. */
  label: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Only gaps this recent are grouped. */
export const GAP_WINDOW_DAYS = 30;
/** At most this many gaps (the newest) are grouped per run. */
export const MAX_GAPS_PER_RUN = 1000;
/** Two questions are one topic at this cosine similarity or above. */
export const COSINE_THRESHOLD = 0.82;
/** Lexical fallback: token-set Jaccard at or above this. */
export const JACCARD_THRESHOLD = 0.5;
/** A dismissed topic and a re-formed one are the same topic when at
 *  least this share of the dismissed topic's questions is in it. */
export const CARRY_OVER_MIN_OVERLAP = 0.5;
/** A dismissed topic reopens once this many questions arrived after the
 *  dismissal. */
export const REOPEN_AFTER_NEW_QUESTIONS = 5;

const DAY_MS = 86_400_000;

/** Words that carry no topic (en + ar). Kept small on purpose. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  // English
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'from',
  'by',
  'about',
  'is',
  'are',
  'was',
  'were',
  'be',
  'am',
  'do',
  'does',
  'did',
  'can',
  'could',
  'will',
  'would',
  'should',
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'it',
  'its',
  'this',
  'that',
  'there',
  'what',
  'how',
  'when',
  'where',
  'which',
  'who',
  'please',
  'pls',
  'hi',
  'hello',
  'any',
  'get',
  'have',
  'has',
  'need',
  'want',
  // Arabic
  'في',
  'من',
  'على',
  'الى',
  'إلى',
  'عن',
  'مع',
  'هل',
  'ما',
  'ماذا',
  'كيف',
  'متى',
  'اين',
  'أين',
  'هذا',
  'هذه',
  'ذلك',
  'انا',
  'أنا',
  'نحن',
  'انت',
  'أنت',
  'او',
  'أو',
  'و',
  'لو',
  'ان',
  'أن',
  'إن',
  'لا',
  'يا',
  'مرحبا',
  'ممكن',
  'اريد',
  'أريد',
  'عندي',
]);

/**
 * Lowercased tokens of Latin and Arabic letters and digits, stop words
 * and one-character tokens dropped. Arabic diacritics and the tatweel are
 * removed so the same word written two ways is one token.
 */
export function normaliseTokens(text: string): Set<string> {
  const cleaned = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[^a-z0-9ء-ي٠-٩]+/g, ' ');
  const out = new Set<string>();
  for (const t of cleaned.split(' ')) {
    if (t.length < 2 || STOP_WORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Newest first, ties by id: the order every step below relies on. */
const newestFirst = (x: GapRow, y: GapRow): number =>
  x.createdAt === y.createdAt
    ? x.id.localeCompare(y.id)
    : x.createdAt < y.createdAt
      ? 1
      : -1;

/** The last GAP_WINDOW_DAYS, at most MAX_GAPS_PER_RUN rows, newest first. */
export function capGaps(rows: GapRow[], now: Date): GapRow[] {
  const since = new Date(
    now.getTime() - GAP_WINDOW_DAYS * DAY_MS
  ).toISOString();
  return rows
    .filter((r) => new Date(r.createdAt).toISOString() >= since)
    .sort(newestFirst)
    .slice(0, MAX_GAPS_PER_RUN);
}

/** 'embedding' only when every row carries one of the same length. */
export function clusterMode(rows: GapRow[]): 'embedding' | 'lexical' {
  if (rows.length === 0) return 'lexical';
  const dim = rows[0]!.embedding?.length ?? 0;
  return dim > 0 && rows.every((r) => r.embedding?.length === dim)
    ? 'embedding'
    : 'lexical';
}

/**
 * Greedy clustering: rows newest first; each joins the topic whose seed
 * (first member) it is most similar to, at or above the threshold, else
 * starts a topic. Topics sorted by size, then most recently seen.
 */
export function clusterGaps(input: GapRow[]): GapTopic[] {
  const rows = [...input].sort(newestFirst);
  const mode = clusterMode(rows);
  const tokens =
    mode === 'lexical' ? rows.map((r) => normaliseTokens(r.question)) : [];
  const sim = (i: number, j: number): number =>
    mode === 'embedding'
      ? cosine(rows[i]!.embedding!, rows[j]!.embedding!)
      : jaccard(tokens[i]!, tokens[j]!);
  const threshold = mode === 'embedding' ? COSINE_THRESHOLD : JACCARD_THRESHOLD;

  const clusters: number[][] = [];
  for (let i = 0; i < rows.length; i++) {
    let best = -1;
    let bestSim = threshold;
    for (let c = 0; c < clusters.length; c++) {
      const s = sim(i, clusters[c]![0]!);
      if (s >= bestSim && (best === -1 || s > bestSim)) {
        best = c;
        bestSim = s;
      }
    }
    if (best === -1) clusters.push([i]);
    else clusters[best]!.push(i);
  }

  const topics = clusters.map((members): GapTopic => {
    let medoid = members[0]!;
    let medoidSum = -1;
    for (const i of members) {
      let sum = 0;
      for (const j of members) if (i !== j) sum += sim(i, j);
      if (sum > medoidSum) {
        medoid = i;
        medoidSum = sum;
      }
    }
    return {
      memberIds: members.map((i) => rows[i]!.id),
      label: rows[medoid]!.question,
      count: members.length,
      lastSeenAt: rows[members[0]!]!.createdAt,
      firstSeenAt: rows[members[members.length - 1]!]!.createdAt,
    };
  });
  return topics.sort((a, b) =>
    a.count !== b.count
      ? b.count - a.count
      : a.lastSeenAt !== b.lastSeenAt
        ? a.lastSeenAt < b.lastSeenAt
          ? 1
          : -1
        : a.memberIds[0]!.localeCompare(b.memberIds[0]!)
  );
}

export interface PreviousTopic {
  memberIds: string[];
  status: 'open' | 'dismissed';
  /** ISO timestamp; set while dismissed. */
  dismissedAt: string | null;
}

/**
 * Whether a re-formed topic keeps an earlier dismissal. It matches a
 * dismissed topic when at least CARRY_OVER_MIN_OVERLAP of that topic's
 * questions are among its members (the best match wins), and stays
 * dismissed unless REOPEN_AFTER_NEW_QUESTIONS of its questions arrived
 * after the dismissal.
 */
export function carryOverStatus(
  topic: { memberIds: string[] },
  createdAtById: ReadonlyMap<string, string>,
  previous: PreviousTopic[]
): { status: 'open' | 'dismissed'; dismissedAt: string | null } {
  const members = new Set(topic.memberIds);
  let match: PreviousTopic | null = null;
  let matchShare = 0;
  for (const p of previous) {
    if (p.status !== 'dismissed' || p.memberIds.length === 0) continue;
    const share =
      p.memberIds.filter((id) => members.has(id)).length / p.memberIds.length;
    if (share >= CARRY_OVER_MIN_OVERLAP && share > matchShare) {
      match = p;
      matchShare = share;
    }
  }
  if (!match?.dismissedAt) return { status: 'open', dismissedAt: null };
  const since = new Date(match.dismissedAt).getTime();
  const arrivedAfter = topic.memberIds.filter((id) => {
    const at = createdAtById.get(id);
    return at !== undefined && new Date(at).getTime() > since;
  }).length;
  return arrivedAfter >= REOPEN_AFTER_NEW_QUESTIONS
    ? { status: 'open', dismissedAt: null }
    : { status: 'dismissed', dismissedAt: match.dismissedAt };
}
