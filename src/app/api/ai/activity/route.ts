import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  parseActivityDays,
  summarizeAiActivity,
  type AiReplyEventRow,
  type AiUsageLogRow,
} from '@/lib/ai/activity';

/** Newest rows read per table; one more is fetched to detect a cut-off. */
const MAX_ROWS = 5000;

/**
 * GET /api/ai/activity?days=7  (admin+)
 *
 * What the auto-reply bot did over the last `days` (1–90, default 7):
 * outcomes, replies per model tier, how tiers were picked, escalations,
 * and auto-reply token spend per model. Admin-only, like the
 * `ai_reply_events` and `ai_usage_log` SELECT policies. The arithmetic
 * is `summarizeAiActivity`; this route only reads.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');

    const days = parseActivityDays(
      new URL(request.url).searchParams.get('days')
    );
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const [events, usage] = await Promise.all([
      supabase
        .from('ai_reply_events')
        .select('outcome, tier, model, route_source, escalated')
        .eq('account_id', accountId)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(MAX_ROWS + 1),
      supabase
        .from('ai_usage_log')
        .select('model, prompt_tokens, completion_tokens, total_tokens')
        .eq('account_id', accountId)
        .eq('mode', 'auto_reply')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(MAX_ROWS + 1),
    ]);

    if (events.error || usage.error) {
      console.error(
        '[ai/activity GET] fetch error:',
        events.error ?? usage.error
      );
      return NextResponse.json(
        { error: 'Failed to load AI activity' },
        { status: 500 }
      );
    }

    const eventRows = (events.data ?? []) as AiReplyEventRow[];
    const usageRows = (usage.data ?? []) as AiUsageLogRow[];

    return NextResponse.json({
      window_days: days,
      truncated: eventRows.length > MAX_ROWS || usageRows.length > MAX_ROWS,
      ...summarizeAiActivity(
        eventRows.slice(0, MAX_ROWS),
        usageRows.slice(0, MAX_ROWS)
      ),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
