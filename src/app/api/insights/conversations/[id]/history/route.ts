import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Migration 153 keeps the newest 30 per conversation. */
const HISTORY_LIMIT = 30;

const loadFailed = () =>
  NextResponse.json(
    { error: 'Failed to load the insight history' },
    { status: 500 }
  );

/**
 * GET /api/insights/conversations/[id]/history (staff)
 *   → { events: { at, figures }[] }, newest first: what Jev judged about
 *   each recent customer message (conversation_insight_events), for the
 *   insights card's trends. Everything goes through the caller's RLS
 *   client, so a chat they cannot see answers 404 — checked on the
 *   conversation first, because an empty history alone cannot tell
 *   "not yours" from "never judged".
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // 'viewer' leaves bank guests out.
    const { supabase, accountId } = await requireRole('viewer');
    const { id } = await params;
    if (!UUID_RE.test(id))
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (convError) {
      console.error('[insights/history GET] conversation:', convError.message);
      return loadFailed();
    }
    if (!conversation)
      return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const { data, error } = await supabase
      .from('conversation_insight_events')
      .select('message_at, figures')
      .eq('conversation_id', id)
      .eq('account_id', accountId)
      .order('message_at', { ascending: false })
      .limit(HISTORY_LIMIT);
    if (error) {
      console.error('[insights/history GET] events:', error.message);
      return loadFailed();
    }
    const rows = (data ?? []) as { message_at: string; figures: unknown }[];
    const events = rows.map((r) => ({
      at: r.message_at,
      figures:
        r.figures && typeof r.figures === 'object' && !Array.isArray(r.figures)
          ? (r.figures as Record<string, unknown>)
          : {},
    }));
    return NextResponse.json({ events });
  } catch (err) {
    return toErrorResponse(err);
  }
}
