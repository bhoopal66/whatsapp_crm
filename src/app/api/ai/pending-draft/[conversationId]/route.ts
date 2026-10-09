// ============================================================
// POST /api/ai/pending-draft/[conversationId]  (agent+)
//
// A person acts on a bot draft the TypeSafe guardrail held
// (`conversations.ai_pending_draft`, migration 077).
//
// Body: { action: 'send' | 'discard', text?: string }
//   - discard → clear the draft.
//   - send    → send `text` (the agent's edit, trimmed) or else the
//               stored draft, through the inbox composer's send core as
//               the calling agent — it is a person's message now, so
//               the 077 trigger pauses the bot like any agent reply —
//               after claiming the draft.
//
// The draft is claimed first: a compare-and-set clear on
// `ai_pending_draft_at`, before anything is sent, so two agents (or a
// double-click) cannot both send it and the loser gets 409. A newer
// draft the bot held in the meantime is a different message and is not
// claimed. A failed send restores the draft (if none replaced it).
//
// Everything runs on the caller's RLS client: a chat they cannot see is
// a 404, and the send core's own checks (role, number allocation) apply.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  sendMessageToConversation,
  SendMessageError,
} from '@/lib/whatsapp/send-message';

type Params = { params: Promise<{ conversationId: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    // The composer's bucket: sending a draft is a send.
    const limit = checkRateLimit(`send:${userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);

    const { conversationId } = await params;
    const body = (await request.json().catch(() => null)) as {
      action?: unknown;
      text?: unknown;
    } | null;
    const action = body?.action;
    if (action !== 'send' && action !== 'discard') {
      return NextResponse.json(
        { error: "action must be 'send' or 'discard'" },
        { status: 400 }
      );
    }
    let editedText: string | null = null;
    if (action === 'send' && body?.text != null) {
      if (typeof body.text !== 'string' || !body.text.trim()) {
        return NextResponse.json(
          { error: 'text must be a non-empty string' },
          { status: 400 }
        );
      }
      editedText = body.text.trim();
    }

    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id, ai_pending_draft, ai_pending_draft_at')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (convErr) {
      console.error('[ai/pending-draft] conversation lookup error:', convErr);
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
    const draft = conv.ai_pending_draft as string | null;
    const draftAt = conv.ai_pending_draft_at as string | null;
    if (!draft) {
      return NextResponse.json(
        { error: 'This chat has no AI draft waiting for review' },
        { status: 409 }
      );
    }

    // Claim the draft before acting on it: a compare-and-set clear on the
    // draft that was read. Two agents (or a double-click) both read it,
    // but only one clear matches a row, so only one goes on to send. A
    // NULL `_at` (a draft written without its time) is matched with
    // IS NULL.
    let claim = supabase
      .from('conversations')
      .update({ ai_pending_draft: null, ai_pending_draft_at: null })
      .eq('id', conversationId)
      .eq('account_id', accountId);
    claim =
      draftAt === null
        ? claim.is('ai_pending_draft_at', null)
        : claim.eq('ai_pending_draft_at', draftAt);
    const { data: claimed, error: claimErr } = await claim.select('id');
    if (claimErr) {
      console.error('[ai/pending-draft] claim error:', claimErr);
      return NextResponse.json(
        {
          error:
            action === 'send'
              ? 'Failed to send the draft'
              : 'Failed to discard the draft',
        },
        { status: 500 }
      );
    }
    if (!Array.isArray(claimed) || claimed.length === 0) {
      return NextResponse.json(
        { error: 'This draft was already sent or discarded.' },
        { status: 409 }
      );
    }

    let sent: { messageId: string; whatsappMessageId: string } | null = null;
    if (action === 'send') {
      try {
        sent = await sendMessageToConversation(supabase, accountId, {
          conversationId,
          messageType: 'text',
          contentText: editedText ?? draft,
          senderUserId: userId,
        });
      } catch (err) {
        // Put the draft back so the agent can retry, but only if the bot
        // has not held a newer one in the meantime.
        const { error: restoreErr } = await supabase
          .from('conversations')
          .update({ ai_pending_draft: draft, ai_pending_draft_at: draftAt })
          .eq('id', conversationId)
          .eq('account_id', accountId)
          .is('ai_pending_draft', null)
          .select('id');
        if (restoreErr) {
          console.error('[ai/pending-draft] restore error:', restoreErr);
        }
        if (err instanceof SendMessageError) {
          return NextResponse.json(
            { error: err.message, code: err.code, retryable: err.definite },
            { status: err.status }
          );
        }
        throw err;
      }
    }

    return NextResponse.json({
      success: true,
      action,
      // Always true now: a lost claim is a 409. Kept for the banner.
      cleared: true,
      ...(sent
        ? {
            message_id: sent.messageId,
            whatsapp_message_id: sent.whatsappMessageId,
          }
        : {}),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
