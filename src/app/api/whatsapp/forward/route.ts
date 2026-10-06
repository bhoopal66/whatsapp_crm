import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import {
  sendMessageToConversation,
  SendMessageError,
} from '@/lib/whatsapp/send-message';
import {
  loadChannels,
  pickByProvider,
  primaryChannel,
  isWhatsAppProvider,
  ChannelError,
} from '@/lib/whatsapp/channels';
import {
  planForward,
  MAX_FORWARD_TARGETS,
  type ForwardTargetResult,
} from '@/lib/whatsapp/forward';
import { resolveForwardMediaUrl } from '@/lib/whatsapp/forward-media';

// Re-hosting an attachment is a download + upload before the first
// send; give it the same headroom as the webhook routes.
export const maxDuration = 60;

const REASON_TEXT = {
  unsupported_type: 'This kind of message cannot be forwarded',
  empty: 'This message has no content to forward',
  no_media: 'The attachment on this message is unavailable',
} as const;

/**
 * Forward one message into up to `MAX_FORWARD_TARGETS` other chats.
 *
 * Each target is an ordinary agent send through the shared send core,
 * so everything a composer send does still applies per target: the
 * reply follows that customer's number, phone-variant retry, flow
 * pausing, and Meta's 24-hour window — which is the failure to expect,
 * since forwarding to a contact who has not written recently is exactly
 * a business-initiated free-form message.
 *
 * Targets succeed or fail independently; the response lists each, so a
 * closed window on one contact doesn't hide that the other four went.
 */
export async function POST(request: Request) {
  try {
    // Same gate as /api/whatsapp/send — see the comment there for why
    // RLS alone is too late.
    const { supabase, accountId, userId } = await requireRole('agent');

    const body = await request.json().catch(() => null);
    const messageId = body?.message_id;
    const rawTargets = body?.conversation_ids;

    if (typeof messageId !== 'string' || !messageId) {
      return NextResponse.json(
        { error: 'message_id is required' },
        { status: 400 }
      );
    }
    if (
      !Array.isArray(rawTargets) ||
      rawTargets.length === 0 ||
      !rawTargets.every((id) => typeof id === 'string' && id)
    ) {
      return NextResponse.json(
        { error: 'conversation_ids must be a non-empty array of ids' },
        { status: 400 }
      );
    }
    const targets = Array.from(new Set(rawTargets as string[]));
    if (targets.length > MAX_FORWARD_TARGETS) {
      return NextResponse.json(
        {
          error: `A message can be forwarded to at most ${MAX_FORWARD_TARGETS} chats at once`,
        },
        { status: 400 }
      );
    }

    // The source goes through the caller's RLS: a message in a thread
    // they cannot see (migrations 042–044) simply isn't found.
    const { data: source } = await supabase
      .from('messages')
      .select(
        'id, conversation_id, content_type, content_text, media_url, media_type, created_at, provider, channel_id'
      )
      .eq('id', messageId)
      .maybeSingle();
    const { data: sourceConversation } = source
      ? await supabase
          .from('conversations')
          .select('id')
          .eq('id', source.conversation_id)
          .eq('account_id', accountId)
          .maybeSingle()
      : { data: null };

    if (!source || !sourceConversation) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    const plan = planForward(source);
    if (!plan.ok) {
      return NextResponse.json(
        { error: REASON_TEXT[plan.reason] },
        { status: 400 }
      );
    }

    // Same visibility rule for the destinations: a colleague's chat the
    // caller cannot open is reported as not found, never sent to.
    const { data: visible } = await supabase
      .from('conversations')
      .select('id')
      .eq('account_id', accountId)
      .in('id', targets);
    const visibleIds = new Set((visible ?? []).map((c) => c.id as string));

    const results: ForwardTargetResult[] = [];
    const sendable = targets.filter((id) => {
      if (visibleIds.has(id)) return true;
      results.push({
        conversation_id: id,
        ok: false,
        error: 'Conversation not found',
      });
      return false;
    });

    // Attachments: make them fetchable once, before any send, rather
    // than re-hosting per target.
    let mediaUrl = plan.mediaUrl;
    if (mediaUrl && sendable.length > 0) {
      const channels = await loadChannels(supabase, accountId);
      // The exact number that carried the source (migration 060), else
      // one of its provider — media ids belong to the gateway that
      // issued them.
      const channel =
        (source.channel_id
          ? channels.find((c) => c.id === source.channel_id)
          : undefined) ??
        (isWhatsAppProvider(source.provider)
          ? pickByProvider(channels, source.provider)
          : null) ??
        primaryChannel(channels);
      if (!channel) {
        throw new ChannelError(
          'whatsapp_not_configured',
          'WhatsApp is not connected',
          400
        );
      }
      mediaUrl = await resolveForwardMediaUrl({
        accountId,
        sourceMessageId: source.id,
        mediaUrl,
        mimeType: source.media_type,
        filename: plan.filename,
        channel,
      });
      if (!mediaUrl) {
        return NextResponse.json(
          {
            error:
              'The attachment could not be retrieved for forwarding — it may have expired at WhatsApp.',
          },
          { status: 502 }
        );
      }
    }

    // Sequential on purpose: at most five sends, and each draws on the
    // same per-user budget as the composer so Forward can't be used to
    // out-send it.
    for (const conversationId of sendable) {
      const limit = checkRateLimit(`send:${userId}`, RATE_LIMITS.send);
      if (!limit.success) {
        results.push({
          conversation_id: conversationId,
          ok: false,
          error: 'Rate limit exceeded — try again in a minute',
        });
        continue;
      }
      try {
        const sent = await sendMessageToConversation(supabase, accountId, {
          conversationId,
          messageType: plan.messageType,
          contentText: plan.contentText,
          mediaUrl,
          filename: plan.filename,
          senderUserId: userId,
          forwarded: true,
        });
        results.push({
          conversation_id: conversationId,
          ok: true,
          message_id: sent.messageId,
        });
      } catch (err) {
        if (!(err instanceof SendMessageError)) throw err;
        results.push({
          conversation_id: conversationId,
          ok: false,
          error: err.message,
        });
      }
    }

    // Keep the caller's order, not the order failures were discovered in.
    results.sort(
      (a, b) =>
        targets.indexOf(a.conversation_id) - targets.indexOf(b.conversation_id)
    );
    return NextResponse.json({ results });
  } catch (error) {
    if (error instanceof ChannelError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Error in WhatsApp forward POST:', error);
    return toErrorResponse(error);
  }
}
