/**
 * Knowledge-gap topics (migration 152): groups the questions the AI bot
 * could not answer (`ai_knowledge_gaps`, last GAP_WINDOW_DAYS) into
 * topics, asks Jev what each of the largest topics is about and whether
 * an approved answer already covers it, and replaces the account's
 * `kb_gap_topics` in one `kb_gap_topics_replace` call.
 *
 * Server-only, service role. Never throws: the automations cron runs it
 * once a day per process and only logs a failure. A failed replace
 * leaves the previous topics in place (the RPC is atomic).
 *
 * Jev is optional. Without it (layer off, no API key, account not
 * allowed, or a failed request) a topic is stored with coverage
 * 'unknown' and no intent — the grouping itself needs no Jev.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/ai/admin-client';
import { loadAiConfig } from '@/lib/ai/config';
import { embedTexts } from '@/lib/ai/embeddings';
import { getDecisionLayer } from '@/lib/typesafe';
import { accountEnabled } from '@/lib/typesafe/config';
import { mapLimit } from '@/lib/typesafe/checks/common';
import { KB_GAP_MAX_ANSWERS } from '@/lib/typesafe/checks/kb-gap';
import type { Intent } from '@/lib/typesafe/questions/triage';

import {
  GAP_WINDOW_DAYS,
  MAX_GAPS_PER_RUN,
  capGaps,
  carryOverStatus,
  clusterGaps,
  clusterMode,
  type GapRow,
  type GapTopic,
  type PreviousTopic,
} from './gap-topics';
import { shortlistApprovedAnswers } from './shortlist';

/** At most this many topics (the largest) are judged per run. */
export const MAX_JUDGED_TOPICS = 60;
/** Jev requests in flight at once per run. */
export const JUDGE_CONCURRENCY = 3;
/**
 * Coverage bands over Jev's expected level (0 does not answer, 1 answers
 * part, 2 fully answers). UNCALIBRATED: picked from the level scale, not
 * from labelled data. Revisit once owners have reviewed real topics.
 */
export const FULL_COVERAGE_MIN_LEVEL = 1.6;
export const PARTIAL_COVERAGE_MIN_LEVEL = 0.8;
/** The cron recomputes an account only with at least this many gaps. */
export const MIN_GAPS_FOR_RECOMPUTE = 3;
/** The cron recomputes at most this many accounts per pass. */
export const MAX_ACCOUNTS_PER_PASS = 50;

const DAY_MS = 86_400_000;
/** PostgREST answers at most this many rows per request (Supabase's
 *  default max-rows), so the account scan pages by it. */
const PAGE_ROWS = 1000;
/** The account scan reads at most this many gap rows. */
const MAX_SCAN_ROWS = 50_000;

export type GapCoverage = 'unknown' | 'none' | 'partial' | 'full';

/** One element of kb_gap_topics_replace's p_topics (migration 152). */
export interface GapTopicElement {
  label: string;
  intent: Intent | null;
  question_count: number;
  first_seen_at: string;
  last_seen_at: string;
  coverage: GapCoverage;
  covered_by_entry_id: string | null;
  coverage_p: number | null;
  status: 'open' | 'dismissed';
  dismissed_at: string | null;
  gap_ids: string[];
}

export type RecomputeResult =
  | {
      ok: true;
      topics: number;
      mode: 'embedding' | 'lexical';
      /** Topics Jev judged successfully. */
      judged: number;
    }
  | { ok: false; reason: string };

/** Coverage band for Jev's expected level (0..2). */
export function coverageFor(level: number): Exclude<GapCoverage, 'unknown'> {
  if (level >= FULL_COVERAGE_MIN_LEVEL) return 'full';
  if (level >= PARTIAL_COVERAGE_MIN_LEVEL) return 'partial';
  return 'none';
}

interface Judged {
  intent: Intent | null;
  coverage: GapCoverage;
  coveredBy: string | null;
  coverageP: number | null;
}

const UNJUDGED: Judged = {
  intent: null,
  coverage: 'unknown',
  coveredBy: null,
  coverageP: null,
};

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

async function loadGaps(
  db: SupabaseClient,
  accountId: string,
  now: Date
): Promise<GapRow[]> {
  const since = new Date(now.getTime() - GAP_WINDOW_DAYS * DAY_MS);
  const { data, error } = await db
    .from('ai_knowledge_gaps')
    .select('id, question, created_at')
    .eq('account_id', accountId)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false })
    .limit(MAX_GAPS_PER_RUN);
  if (error) throw new Error(`gaps: ${error.message}`);
  const rows = (
    (data ?? []) as {
      id: string;
      question: string | null;
      created_at: string;
    }[]
  ).filter((r) => typeof r.question === 'string' && r.question.trim());
  return capGaps(
    rows.map((r) => ({
      id: r.id,
      question: r.question!,
      createdAt: r.created_at,
    })),
    now
  );
}

async function loadPrevious(
  db: SupabaseClient,
  accountId: string
): Promise<PreviousTopic[]> {
  const [topics, members] = await Promise.all([
    db
      .from('kb_gap_topics')
      .select('id, status, dismissed_at')
      .eq('account_id', accountId),
    db
      .from('kb_gap_topic_members')
      .select('topic_id, gap_id')
      .eq('account_id', accountId),
  ]);
  if (topics.error) throw new Error(`topics: ${topics.error.message}`);
  if (members.error) throw new Error(`members: ${members.error.message}`);
  const byTopic = new Map<string, string[]>();
  for (const m of (members.data ?? []) as {
    topic_id: string;
    gap_id: string;
  }[]) {
    const list = byTopic.get(m.topic_id) ?? [];
    list.push(m.gap_id);
    byTopic.set(m.topic_id, list);
  }
  return (
    (topics.data ?? []) as {
      id: string;
      status: string;
      dismissed_at: string | null;
    }[]
  ).map((t) => ({
    memberIds: byTopic.get(t.id) ?? [],
    status: t.status === 'dismissed' ? 'dismissed' : 'open',
    dismissedAt: t.dismissed_at,
  }));
}

/** Embeds every question when the account has an embeddings key (the
 *  same decision as lib/ai/knowledge.ts); otherwise, or on any failure,
 *  the rows come back as they were and clustering goes lexical. */
async function withEmbeddings(
  db: SupabaseClient,
  accountId: string,
  rows: GapRow[]
): Promise<GapRow[]> {
  if (rows.length === 0) return rows;
  try {
    const config = await loadAiConfig(db, accountId, { requireActive: false });
    if (!config?.embeddingsApiKey) return rows;
    const vectors = await embedTexts(
      config.embeddingsApiKey,
      rows.map((r) => r.question)
    );
    if (vectors.length !== rows.length) return rows;
    return rows.map((r, i) => ({ ...r, embedding: vectors[i] }));
  } catch (err) {
    console.warn(
      `[kb-gap] embeddings failed for account ${accountId}; grouping lexically: ${message(err)}`
    );
    return rows;
  }
}

async function judgeTopics(
  db: SupabaseClient,
  accountId: string,
  topics: GapTopic[]
): Promise<Judged[]> {
  const out: Judged[] = topics.map(() => UNJUDGED);
  const ts = getDecisionLayer();
  if (!ts || !ts.gateway.hasKey() || !accountEnabled(ts.config, accountId))
    return out;
  // Largest first; the sort is stable, so ties keep clusterGaps' order.
  const order = topics
    .map((t, i) => ({ i, count: t.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_JUDGED_TOPICS);
  await mapLimit(order, JUDGE_CONCURRENCY, async ({ i }) => {
    const topic = topics[i]!;
    try {
      const shortlist = (
        await shortlistApprovedAnswers(
          db,
          accountId,
          topic.label,
          KB_GAP_MAX_ANSWERS
        )
      ).slice(0, KB_GAP_MAX_ANSWERS);
      const res = await ts.kbGap({
        accountId,
        question: topic.label,
        answers: shortlist.map((c) => c.answer_en),
      });
      if (!res.ok) return;
      const coverage = coverageFor(res.coverage.level);
      const best =
        res.coverage.index === null ? null : shortlist[res.coverage.index];
      out[i] = {
        intent: res.intent.key,
        coverage,
        // Only an answer that answers at least part of the topic is
        // named as covering it.
        coveredBy: best && coverage !== 'none' ? best.id : null,
        coverageP: res.coverage.level / 2,
      };
    } catch (err) {
      console.warn(
        `[kb-gap] judging a topic failed for account ${accountId}: ${message(err)}`
      );
    }
  });
  return out;
}

/**
 * Recomputes one account's knowledge-gap topics and replaces the stored
 * ones. Never throws.
 */
export async function recomputeKbGapTopics(
  accountId: string,
  opts: { now?: Date } = {}
): Promise<RecomputeResult> {
  const now = opts.now ?? new Date();
  try {
    const db = supabaseAdmin();
    const [gaps, previous] = await Promise.all([
      loadGaps(db, accountId, now),
      loadPrevious(db, accountId),
    ]);
    const rows = await withEmbeddings(db, accountId, gaps);
    const mode = clusterMode(rows);
    const topics = clusterGaps(rows);
    const judged = await judgeTopics(db, accountId, topics);
    const createdAtById = new Map(gaps.map((g) => [g.id, g.createdAt]));
    const elements: GapTopicElement[] = topics.map((t, i) => {
      const j = judged[i]!;
      const carried = carryOverStatus(t, createdAtById, previous);
      return {
        label: t.label,
        intent: j.intent,
        question_count: t.count,
        first_seen_at: t.firstSeenAt,
        last_seen_at: t.lastSeenAt,
        coverage: j.coverage,
        covered_by_entry_id: j.coveredBy,
        coverage_p: j.coverageP,
        status: carried.status,
        dismissed_at: carried.dismissedAt,
        gap_ids: t.memberIds,
      };
    });
    const { error } = await db.rpc('kb_gap_topics_replace', {
      p_account: accountId,
      p_topics: elements,
    });
    if (error) return { ok: false, reason: `replace: ${error.message}` };
    return {
      ok: true,
      topics: elements.length,
      mode,
      judged: judged.filter((j) => j.coverage !== 'unknown').length,
    };
  } catch (err) {
    return { ok: false, reason: message(err) };
  }
}

/**
 * The accounts worth a recompute: at least MIN_GAPS_FOR_RECOMPUTE gaps
 * in the window, most gaps first, at most MAX_ACCOUNTS_PER_PASS. Counted
 * here from the account ids, paged (PostgREST has no GROUP BY without an
 * RPC).
 */
export async function accountsDueForGapRecompute(
  db: SupabaseClient,
  now: Date
): Promise<string[]> {
  const since = new Date(now.getTime() - GAP_WINDOW_DAYS * DAY_MS);
  const counts = new Map<string, number>();
  for (let from = 0; from < MAX_SCAN_ROWS; from += PAGE_ROWS) {
    const { data, error } = await db
      .from('ai_knowledge_gaps')
      .select('account_id')
      .gte('created_at', since.toISOString())
      .order('id', { ascending: true })
      .range(from, from + PAGE_ROWS - 1);
    if (error) throw new Error(`gap accounts: ${error.message}`);
    const rows = (data ?? []) as { account_id: string }[];
    for (const r of rows)
      counts.set(r.account_id, (counts.get(r.account_id) ?? 0) + 1);
    if (rows.length < PAGE_ROWS) break;
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= MIN_GAPS_FOR_RECOMPUTE)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ACCOUNTS_PER_PASS)
    .map(([id]) => id);
}

/**
 * The automations cron's daily pass: every due account, one at a time.
 * A failed account is logged and the pass moves on; it throws only when
 * the account scan itself fails.
 */
export async function runKbGapRecomputePass(
  opts: { now?: Date } = {}
): Promise<{ accounts: number; failed: number }> {
  const now = opts.now ?? new Date();
  const accounts = await accountsDueForGapRecompute(supabaseAdmin(), now);
  let failed = 0;
  for (const accountId of accounts) {
    const res = await recomputeKbGapTopics(accountId, { now });
    if (!res.ok) {
      failed++;
      console.error(
        `[kb-gap] recompute failed for account ${accountId}: ${res.reason}`
      );
    }
  }
  return { accounts: accounts.length, failed };
}
