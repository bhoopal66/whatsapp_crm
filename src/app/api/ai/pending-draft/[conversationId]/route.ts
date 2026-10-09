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
//               then clear the draft.
//
// Both clears are compare-and-set on `ai_pending_draft_at`: a newer
// draft the bot held in the meantime is a different message, and stays
// for someone to look at. A failed send leaves the draft in place.
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
        if (err instanceof SendMessageError) {
          return NextResponse.json(
            { error: err.message, code: err.code, retryable: err.definite },
            { status: err.status }
          );
        }
        throw err;
      }
    }

    // Clear only the draft that was read. A NULL `_at` (a draft written
    // without its time) is matched with IS NULL.
    let clear = supabase
      .from('conversations')
      .update({ ai_pending_draft: null, ai_pending_draft_at: null })
      .eq('id', conversationId)
      .eq('account_id', accountId);
    clear =
      draftAt === null
        ? clear.is('ai_pending_draft_at', null)
        : clear.eq('ai_pending_draft_at', draftAt);
    const { data: cleared, error: clearErr } = await clear.select('id');
    if (clearErr) {
      // After a send the message is out; say so rather than failing it.
      console.error('[ai/pending-draft] clear error:', clearErr);
      if (!sent) {
        return NextResponse.json(
          { error: 'Failed to discard the draft' },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      action,
      // False when a newer draft replaced this one meanwhile (it stays).
      cleared: !clearErr && Array.isArray(cleared) && cleared.length > 0,
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
