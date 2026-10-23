import { NextResponse, after } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import type { WhatsAppProvider } from '@/lib/whatsapp/channels';

// `reply_now` answers the customer's last message in after(), which
// calls the model and sends.
export const maxDuration = 60;

const META_WINDOW_MS = 24 * 60 * 60 * 1000;

type Params = { params: Promise<{ conversationId: string }> };

/**
 * POST /api/ai/autoreply/[conversationId]  (agent+)
 *
 * Toggle the AI auto-reply bot for one conversation from the inbox — the
 * "Take over" / "Resume AI" banner.
 *
 * Body: { paused: boolean, assign_to_me?: boolean, reply_now?: boolean }
 *   - paused: true  → pause the bot here (a human is taking over). When
 *                     `assign_to_me` is set, also assign the thread to the
 *                     caller (the usual "Take over" flow). Assignment
 *                     fires the `on_conversation_assigned` trigger.
 *   - paused: false → hand the thread back to the bot: clear the pause,
 *                     reset the per-conversation reply count so it gets
 *                     fresh slots, and clear the handoff note. If the
 *                     caller currently owns the thread, unassign it too so
 *                     the bot isn't blocked by the "human owns this" gate.
 *                     Also clears the pause reason (migration 077), a
 *                     held draft and the hand-off reason.
 *   - reply_now: true (with paused: false) → when the chat's latest
 *                     message is the customer's and has text, answer it
 *                     now, in after(), the way the inbound pipeline
 *                     would have. Otherwise the bot waits for the next
 *                     message, as before.
 *
 * Answers { success, paused, replying } — `replying` says whether a
 * reply_now dispatch was scheduled.
 *
 * Writes go through the RLS-scoped SSR client, so a conversation outside
 * the caller's account simply isn't found (404).
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    // Reuse the send bucket: this is a cheap per-user inbox action and
    // toggling it in a tight loop has no legitimate use.
    const limit = checkRateLimit(`ai-takeover:${userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);

    const { conversationId } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body.paused !== 'boolean') {
      return NextResponse.json(
        { error: 'paused (boolean) is required' },
        { status: 400 }
      );
    }
    const paused = body.paused as boolean;
    const assignToMe = body.assign_to_me === true;
    const replyNow = !paused && body.reply_now === true;

    // Confirm the conversation is in the caller's account before writing.
    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id, contact_id, channel_id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (convErr) {
      console.error('[ai/autoreply] conversation lookup error:', convErr);
      return NextResponse.json(
        { error: 'Failed to load conversation' },
        { status: 500 }
      );
    }
    if (!conv) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // Either way a person has acted on the chat: it no longer needs
    // attention (migration 078's Important pin).
    const update: Record<string, unknown> = {
      ai_autoreply_disabled: paused,
      ai_attention_at: null,
    };

    if (paused) {
      update.ai_paused_reason = 'take_over';
      update.ai_paused_at = new Date().toISOString();
      if (assignToMe) update.assigned_agent_id = userId;
    } else {
      // Resuming hands the thread *back to the bot*. Clear the pause and
      // the handoff note, and — crucially — release ANY assignment, not
      // just the caller's own: the auto-reply eligibility gate stands
      // down whenever a human is assigned, so leaving a stale assignee
      // (e.g. the agent a prior handoff routed to) would silently keep
      // the bot muted and make "Resume AI" a no-op. This is the explicit
      // choice to let the bot own the thread again.
      update.assigned_agent_id = null;
      // Give the bot a fresh reply budget on this thread. This is a
      // deliberate, manual, rate-limited action (not automatable), so it
      // can't be used to bypass the per-conversation cap at scale — it's
      // a human choosing to re-engage the assistant.
      update.ai_reply_count = 0;
      update.ai_handoff_summary = null;
      update.ai_handoff_reason = null;
      update.ai_paused_reason = null;
      update.ai_paused_at = null;
      // A held draft was the bot's answer to a message it is now free to
      // answer again; leaving it would show a stale draft next to the
      // new reply.
      update.ai_pending_draft = null;
      update.ai_pending_draft_at = null;
    }

    const { data: updated, error: upErr } = await supabase
      .from('conversations')
      .update(update)
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .select('id');
    if (upErr) {
      console.error('[ai/autoreply] update error:', upErr);
      return NextResponse.json(
        { error: 'Failed to update conversation' },
        { status: 500 }
      );
    }
    // Seeing a chat is not editing it (a coordinator's share reads but
    // does not update): RLS then filters the UPDATE to zero rows with no
    // error, and this used to answer success and even queue reply_now.
    if (!updated || updated.length === 0) {
      return NextResponse.json(
        { error: 'You cannot change the AI setting of this conversation' },
        { status: 403 }
      );
    }

    // The RLS lookup above proved the caller can see this chat; the
    // reads below need the channel owner's id and the number's provider,
    // which an agent's RLS does not hand out, so they run on the service
    // role.
    const dispatch = replyNow
      ? await loadReplyNowDispatch(accountId, {
          id: conv.id as string,
          contact_id: conv.contact_id as string,
          channel_id: (conv.channel_id as string | null) ?? null,
        })
      : null;

    if (dispatch) {
      // Awaited inside after(): a floating promise is killed with the
      // request (issue #301). The dispatcher never throws.
      after(async () => {
        await dispatchInboundToAiReply(dispatch);
      });
    }

    return NextResponse.json({ success: true, paused, replying: !!dispatch });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * The dispatch that answers the chat's latest message, or null when
 * there is nothing for the bot to answer: the latest message is not the
 * customer's, has no text, its number is gone, or it came in on a Meta
 * number more than 24 hours ago (the service window is closed). Mirrors
 * what `processMessage` in the inbound pipeline passes: the number the
 * message arrived on, its provider, and that number's owner as the
 * sender of record.
 */
async function loadReplyNowDispatch(
  accountId: string,
  conv: { id: string; contact_id: string; channel_id: string | null }
): Promise<Parameters<typeof dispatchInboundToAiReply>[0] | null> {
  const admin = supabaseAdmin();
  const { data: last, error: lastErr } = await admin
    .from('messages')
    .select('sender_type, content_text, message_id, channel_id, created_at')
    .eq('conversation_id', conv.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastErr) {
    console.error('[ai/autoreply] latest message lookup error:', lastErr);
    return null;
  }
  const text =
    typeof last?.content_text === 'string' ? last.content_text.trim() : '';
  if (!last || last.sender_type !== 'customer' || !text) return null;

  const channelId = (last.channel_id as string | null) ?? conv.channel_id;
  if (!channelId) return null;
  const { data: channel, error: channelErr } = await admin
    .from('whatsapp_config')
    .select('provider, user_id')
    .eq('id', channelId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (channelErr) {
    console.error('[ai/autoreply] channel lookup error:', channelErr);
    return null;
  }
  if (!channel) return null;

  // Meta only lets a reply through for 24 hours after the customer's
  // last message; an older one would only fail at the gateway.
  if (channel.provider === 'meta') {
    const sentAt = Date.parse((last.created_at as string | null) ?? '');
    if (Number.isFinite(sentAt) && Date.now() - sentAt > META_WINDOW_MS) {
      return null;
    }
  }

  return {
    accountId,
    conversationId: conv.id,
    contactId: conv.contact_id,
    configOwnerUserId: channel.user_id as string,
    inboundProvider: channel.provider as WhatsAppProvider,
    inboundChannelId: channelId,
    inboundMessageId: (last.message_id as string | null) ?? null,
    inboundText: last.content_text as string,
  };
}
