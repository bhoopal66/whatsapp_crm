/**
 * Pure view helpers for the knowledge-gap Topics view (migration 152):
 * the shape `GET /api/ai/knowledge/gaps/topics` answers, its ordering,
 * which coverage badge a topic gets, and how examples are trimmed.
 *
 * Dependency-free on purpose: the settings card (a client component)
 * imports this file, and a client graph must never reach a server
 * module (the recompute, the admin client, the TypeSafe layer).
 */

export type GapTopicCoverage = 'unknown' | 'none' | 'partial' | 'full';
export type GapTopicStatus = 'open' | 'dismissed';

/** One topic as the topics route answers it. */
export interface GapTopicView {
  id: string;
  /** The representative question (already redacted). */
  label: string;
  /** A triage intent key, or null when Jev did not judge the topic. */
  intent: string | null;
  question_count: number;
  first_seen_at: string;
  last_seen_at: string;
  coverage: GapTopicCoverage;
  covered_by_entry_id: string | null;
  /** The covering approved answer's question, when it still exists. */
  covered_by_title: string | null;
  status: GapTopicStatus;
  dismissed_at: string | null;
  /** Up to MAX_TOPIC_EXAMPLES member questions, newest first. */
  examples: string[];
}

/** Examples kept per topic. */
export const MAX_TOPIC_EXAMPLES = 3;

/**
 * The triage intents the topics carry (src/lib/typesafe/questions/
 * triage.ts `INTENTS`), restated here so the client never imports the
 * server-side module. An unknown key gets no chip.
 */
export const GAP_TOPIC_INTENTS = [
  'account_opening',
  'pos_terminal',
  'business_loan',
  'trade_working_capital',
  'application_status',
  'other_banking',
  'complaint',
  'smalltalk',
  'unclear',
  'other_request',
] as const;
export type GapTopicIntent = (typeof GAP_TOPIC_INTENTS)[number];

export function knownIntent(intent: string | null): GapTopicIntent | null {
  return intent && (GAP_TOPIC_INTENTS as readonly string[]).includes(intent)
    ? (intent as GapTopicIntent)
    : null;
}

function time(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Open first, then dismissed; within each, most questions, then newest. */
export function compareTopics(a: GapTopicView, b: GapTopicView): number {
  if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
  if (a.question_count !== b.question_count) {
    return b.question_count - a.question_count;
  }
  return time(b.last_seen_at) - time(a.last_seen_at);
}

export function sortTopics(topics: readonly GapTopicView[]): GapTopicView[] {
  return [...topics].sort(compareTopics);
}

/** The open and dismissed groups, each in display order. */
export function splitTopics(topics: readonly GapTopicView[]): {
  open: GapTopicView[];
  dismissed: GapTopicView[];
} {
  const sorted = sortTopics(topics);
  return {
    open: sorted.filter((t) => t.status === 'open'),
    dismissed: sorted.filter((t) => t.status === 'dismissed'),
  };
}

export type CoverageBadge =
  | { kind: 'none'; tone: 'warning' }
  | { kind: 'partial'; tone: 'info'; entry: string | null }
  | { kind: 'full'; tone: 'success'; entry: string | null };

/** The badge a topic shows; null (no badge) while coverage is unknown. */
export function coverageBadge(
  topic: Pick<GapTopicView, 'coverage' | 'covered_by_title'>
): CoverageBadge | null {
  switch (topic.coverage) {
    case 'none':
      return { kind: 'none', tone: 'warning' };
    // Coverage names the answer that covers the topic. With no answer
    // left (it was deleted after the last recompute, which nulls the
    // link), "answered" would hide a real gap until the next run, so
    // say nothing rather than claim coverage.
    case 'partial':
      return topic.covered_by_title
        ? { kind: 'partial', tone: 'info', entry: topic.covered_by_title }
        : null;
    case 'full':
      return topic.covered_by_title
        ? { kind: 'full', tone: 'success', entry: topic.covered_by_title }
        : null;
    case 'unknown':
      return null;
    default: {
      const never: never = topic.coverage;
      return never;
    }
  }
}

/**
 * Examples worth showing: trimmed, blank ones and repeats of the
 * representative question (or of each other) dropped, at most `max`.
 */
export function trimExamples(
  label: string,
  examples: readonly string[],
  max = MAX_TOPIC_EXAMPLES
): string[] {
  const seen = new Set([label.trim().toLowerCase()]);
  const out: string[] = [];
  for (const raw of examples) {
    const text = raw.trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/** Topics is the default view whenever any topic exists. */
export function defaultGapView(topicCount: number): 'topics' | 'questions' {
  return topicCount > 0 ? 'topics' : 'questions';
}

/** The latest `computed_at` among topic rows, or null when there are none. */
export function latestComputedAt(
  rows: readonly { computed_at: string | null }[]
): string | null {
  let best: string | null = null;
  for (const row of rows) {
    if (
      row.computed_at &&
      (best === null || time(row.computed_at) > time(best))
    ) {
      best = row.computed_at;
    }
  }
  return best;
}
