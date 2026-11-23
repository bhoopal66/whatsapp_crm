// ============================================================
// POST /api/ai/pending-draft/[conversationId]  (agent+)
//
// A person acts on a bot draft the TypeSafe guardrail held
// (`conversations.ai_pending_draft`, migration 077).
//
// Body: { action: 'send' | 'discard', draft_at: string | null, text?: string }
//   - draft_at → the `ai_pending_draft_at` of the draft on the person's
//               screen. Another draft stored by now is answered 409
//               `draft_changed` with that draft, and is left alone.
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
// claimed. A send that certainly did not go out restores the draft (if
// none replaced it). One that may have reached the customer (a timeout, a
// gateway 5xx, a message row that did not save) does not: a restored draft
// is one click from a second copy.
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
  DRAFT_CHANGED,
  DRAFT_GONE,
  DRAFT_SENT_UNSAVED,
  DRAFT_SEND_UNCONFIRMED,
  sameDraftTime,
  type DraftFields,
} from '@/lib/ai/pending-draft';
import {
  sendMessageToConversation,
  SendMessageError,
  RestrictedSendError,
} from '@/lib/whatsapp/send-message';

/** 409: the draft on the person's screen is not the one held now. */
function draftConflict(held: DraftFields | null): NextResponse {
  return held?.ai_pending_draft
    ? NextResponse.json(
        {
          error: 'The AI held a newer draft meanwhile. Read it first.',
          code: DRAFT_CHANGED,
          ai_pending_draft: held.ai_pending_draft,
          ai_pending_draft_at: held.ai_pending_draft_at,
        },
        { status: 409 }
      )
    : NextResponse.json(
        {
          error: 'This draft was already sent or discarded.',
          code: DRAFT_GONE,
        },
        { status: 409 }
      );
}

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
      draft_at?: unknown;
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

    // Which draft the person read. Required, so a tab loaded before the
    // banner sent it cannot act on a draft it never showed.
    const shownAt = body?.draft_at;
    if (shownAt !== null && typeof shownAt !== 'string') {
      return NextResponse.json(
        { error: 'This page is out of date. Reload it and try again.' },
        { status: 400 }
      );
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
        {
          error: 'This chat has no AI draft waiting for review',
          code: DRAFT_GONE,
        },
        { status: 409 }
      );
    }
    if (!sameDraftTime(shownAt, draftAt)) {
      return draftConflict({
        ai_pending_draft: draft,
        ai_pending_draft_at: draftAt,
      });
    }

    // Claim the draft before acting on it: a compare-and-set clear on the
    // draft that was read. Two agents (or a double-click) both read it,
    // but only one clear matches a row, so only one goes on to send. A
    // NULL `_at` (a draft written without its time) is matched with
    // IS NULL.
    // The claim also clears the Important pin (migration 078): sending or
    // discarding the held draft is a person acting on the chat.
    let claim = supabase
      .from('conversations')
      .update({
        ai_pending_draft: null,
        ai_pending_draft_at: null,
        ai_attention_at: null,
      })
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
      // Gone, or replaced between the read and the claim.
      const { data: now } = await supabase
        .from('conversations')
        .select('ai_pending_draft, ai_pending_draft_at')
        .eq('id', conversationId)
        .eq('account_id', accountId)
        .maybeSingle();
      return draftConflict(now as DraftFields | null);
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
        if (!(err instanceof SendMessageError)) {
          console.error('[ai/pending-draft] send outcome unknown:', err);
        }
        if (!(err instanceof SendMessageError) || !err.definite) {
          const unsaved =
            err instanceof SendMessageError && err.code === DRAFT_SENT_UNSAVED;
          return NextResponse.json(
            {
              error: unsaved
                ? err.message
                : 'The draft may have been sent: check the chat before sending it again',
              code: unsaved ? DRAFT_SENT_UNSAVED : DRAFT_SEND_UNCONFIRMED,
              retryable: false,
            },
            { status: err instanceof SendMessageError ? err.status : 500 }
          );
        }
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
        if (err instanceof RestrictedSendError) {
          return NextResponse.json(err.toBody(), { status: err.status });
        }
        return NextResponse.json(
          { error: err.message, code: err.code, retryable: true },
          { status: err.status }
        );
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
