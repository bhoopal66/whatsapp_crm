// ============================================================
// POST /api/insights/tag-suggest
//
// "Suggest a tag" in the chat header (docs/jev-insights.md, "Chat tag
// suggestions"). Body: { conversationId }.
//
// Agent and up (viewers cannot tag). The chat must be visible through
// the caller's own RLS client, or the answer is 404: the suggestion
// itself runs on the service role (`suggestTagForConversation`), so
// this read is the only access check. Rate-limited per person, because
// every click is a Jev request.
//
// 200 { suggestion: { mainId, subId, p } | null, reason? } — the
// suggestion is stored on the chat (or cleared) by the helper; it never
// tags the chat. Refusals answer { error, reason }: 409 off, 503
// unavailable, 502 when the judgment failed.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { suggestTagForConversation } from '@/lib/insights/suggest-now';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId, role } = await requireRole('agent');

    const body = (await request.json().catch(() => null)) as {
      conversationId?: unknown;
    } | null;
    const conversationId = body?.conversationId;
    if (typeof conversationId !== 'string' || !UUID.test(conversationId)) {
      return NextResponse.json(
        { error: 'conversationId is required' },
        { status: 400 }
      );
    }

    const { data: visible, error: readError } = await supabase
      .from('conversations')
      .select(
        'id, account_id, user_id, assigned_agent_id, channel_id, send_channel_id'
      )
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (readError) {
      console.error('[insights/tag-suggest] read failed:', readError.message);
      return NextResponse.json(
        { error: 'Could not read the chat' },
        { status: 500 }
      );
    }
    if (!visible) {
      return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
    }
    // The RLS read also passes a coordinator who sees the chat only
    // through a share (migration 133), but Apply and Dismiss need
    // can_view_conversation, which leaves shares out on purpose. Ask the
    // same question dismiss_tag_suggestion asks, so a share-only viewer
    // spends no Jev request on a chip they couldn't act on.
    if (!hasMinRole(role, 'admin')) {
      const { data: canView, error: viewError } = await supabase.rpc(
        'can_view_conversation',
        {
          p_account_id: visible.account_id,
          p_owner_id: visible.user_id,
          p_assigned_id: visible.assigned_agent_id,
          p_channel_id: visible.channel_id,
          p_send_channel_id: visible.send_channel_id,
        }
      );
      if (viewError) {
        console.error(
          '[insights/tag-suggest] visibility check failed:',
          viewError.message
        );
        return NextResponse.json(
          { error: 'Could not read the chat' },
          { status: 500 }
        );
      }
      if (canView !== true) {
        return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
      }
    }

    const limit = checkRateLimit(
      `tag-suggest:${userId}`,
      RATE_LIMITS.tagSuggestUser
    );
    if (!limit.success) return rateLimitResponse(limit);

    const result = await suggestTagForConversation(accountId, conversationId);
    if (!result.ok) {
      if (result.reason === 'off') {
        return NextResponse.json(
          { error: 'Tag suggestions are turned off', reason: 'off' },
          { status: 409 }
        );
      }
      if (result.reason === 'unavailable') {
        return NextResponse.json(
          {
            error: 'Tag suggestions are not available',
            reason: 'unavailable',
          },
          { status: 503 }
        );
      }
      return NextResponse.json(
        { error: 'Could not suggest a tag', reason: 'error' },
        { status: 502 }
      );
    }

    return NextResponse.json(
      result.reason
        ? { suggestion: result.suggestion, reason: result.reason }
        : { suggestion: result.suggestion }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
