import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { recomputeKbGapTopics } from '@/lib/kb/gap-recompute';
import { MAX_GAPS_PER_RUN, clipTopicLabel } from '@/lib/kb/gap-topics';
import {
  MAX_TOPIC_EXAMPLES,
  latestComputedAt,
  sortTopics,
  trimExamples,
  type GapTopicView,
} from '@/lib/kb/gap-topics-view';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

interface TopicRow extends Omit<GapTopicView, 'covered_by_title' | 'examples'> {
  computed_at: string | null;
}

interface MemberRow {
  topic_id: string;
  gap: { question: string; created_at: string } | null;
}

/** The Refresh button's recompute budget. */
const REFRESH_BUDGET_MS = 25_000;

const TOPIC_COLUMNS =
  'id, label, intent, question_count, first_seen_at, last_seen_at, coverage, covered_by_entry_id, status, dismissed_at, computed_at';

/**
 * GET /api/ai/knowledge/gaps/topics  (admin+)
 *
 * The account's knowledge-gap topics (migration 152) in display order,
 * each with up to three of its newest questions and the covering
 * approved answer's question, plus when they were last computed. Read
 * with the caller's RLS client: both tables are admin+ under RLS.
 * Topic ids change on every recompute, so the client re-reads after a
 * Refresh rather than patching.
 *
 * Counts are live: a deleted gap drops its member row (cascade), so
 * `question_count` is the topic's remaining members, a topic with none
 * left is not answered, and when the representative question itself was
 * deleted the newest remaining one stands in as the label.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { data: topicData, error: topicError } = await supabase
      .from('kb_gap_topics')
      .select(TOPIC_COLUMNS)
      .eq('account_id', accountId);
    if (topicError) {
      console.error('[ai/knowledge/gaps/topics GET] topics error:', topicError);
      return NextResponse.json(
        { error: 'Failed to load topics' },
        { status: 500 }
      );
    }
    const topics = (topicData ?? []) as TopicRow[];
    if (topics.length === 0) {
      return NextResponse.json({ topics: [], computed_at: null });
    }

    const entryIds = [
      ...new Set(
        topics
          .map((t) => t.covered_by_entry_id)
          .filter((id): id is string => typeof id === 'string')
      ),
    ];
    // One recompute groups at most MAX_GAPS_PER_RUN gaps, so one page
    // holds every member row. The FK is named: the embed is otherwise
    // resolved by PostgREST guesswork.
    const [membersRes, entriesRes] = await Promise.all([
      supabase
        .from('kb_gap_topic_members')
        .select(
          'topic_id, gap:ai_knowledge_gaps!kb_gap_topic_members_gap_fkey(question, created_at)'
        )
        .eq('account_id', accountId)
        .limit(MAX_GAPS_PER_RUN),
      entryIds.length > 0
        ? supabase
            .from('kb_entries')
            .select('id, question')
            .eq('account_id', accountId)
            .in('id', entryIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (membersRes.error || entriesRes.error) {
      console.error(
        '[ai/knowledge/gaps/topics GET] detail error:',
        membersRes.error ?? entriesRes.error
      );
      return NextResponse.json(
        { error: 'Failed to load topics' },
        { status: 500 }
      );
    }

    const byTopic = new Map<string, { question: string; at: number }[]>();
    for (const m of (membersRes.data ?? []) as unknown as MemberRow[]) {
      if (!m.gap) continue;
      const list = byTopic.get(m.topic_id) ?? [];
      list.push({
        question: m.gap.question,
        at: Date.parse(m.gap.created_at) || 0,
      });
      byTopic.set(m.topic_id, list);
    }
    const titles = new Map<string, string>();
    for (const e of (entriesRes.data ?? []) as {
      id: string;
      question: string;
    }[]) {
      titles.set(e.id, e.question);
    }

    const views: GapTopicView[] = [];
    for (const { computed_at, ...rest } of topics) {
      void computed_at; // stripped: the response carries one computed_at
      const newest = (byTopic.get(rest.id) ?? [])
        .sort((a, b) => b.at - a.at)
        .map((g) => g.question);
      if (newest.length === 0) continue;
      const label = newest.some((q) => clipTopicLabel(q) === rest.label)
        ? rest.label
        : clipTopicLabel(newest[0]!);
      views.push({
        ...rest,
        label,
        question_count: newest.length,
        covered_by_title: rest.covered_by_entry_id
          ? (titles.get(rest.covered_by_entry_id) ?? null)
          : null,
        examples: trimExamples(label, newest, MAX_TOPIC_EXAMPLES),
      });
    }

    return NextResponse.json({
      topics: sortTopics(views),
      computed_at: latestComputedAt(topics),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/ai/knowledge/gaps/topics  (admin+)
 *
 * Recompute the account's topics now (the daily cron does the same).
 * Once per 10 minutes per account: a run embeds every gap and asks Jev
 * about the largest topics. Answers the recompute's summary. The run
 * gets REFRESH_BUDGET_MS: past it, topics are stored unjudged rather
 * than holding the request open.
 */
export async function POST() {
  try {
    const { accountId } = await requireRole('admin');
    const limit = checkRateLimit(
      `kb-gap-recompute:${accountId}`,
      RATE_LIMITS.kbGapRecompute
    );
    if (!limit.success) return rateLimitResponse(limit);

    const result = await recomputeKbGapTopics(accountId, {
      deadlineAt: Date.now() + REFRESH_BUDGET_MS,
    });
    if (!result.ok) {
      console.error('[ai/knowledge/gaps/topics POST] failed:', result.reason);
      return NextResponse.json(
        { error: 'Failed to refresh topics' },
        { status: 500 }
      );
    }
    return NextResponse.json({
      topics: result.topics,
      mode: result.mode,
      judged: result.judged,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
