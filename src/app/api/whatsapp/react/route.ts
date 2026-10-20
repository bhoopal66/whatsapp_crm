import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { sendReaction, describeSendFailure } from '@/lib/whatsapp/provider';
import {
  ChannelError,
  isWhatsAppProvider,
  loadChannels,
  pickByProvider,
  resolveReplyChannel,
} from '@/lib/whatsapp/channels';
import { reachesOnlyByShare } from '@/lib/whatsapp/send-message';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/**
 * POST /api/whatsapp/react
 *
 * Body: { message_id: <internal UUID>, emoji: <single emoji or "" to remove> }
 *
 * Sends the reaction through Whapi and mirrors it into
 * `message_reactions` (delete on empty emoji). Customer-side reactions
 * are handled by the webhook — this route only writes
 * `actor_type = 'agent'` rows.
 */
export async function POST(request: Request) {
  try {
    // Reacting is a write operation (`canSendMessages`), and it pushes the
    // reaction to WhatsApp before mirroring it locally — so, as on /send, a
    // missing role check let a read-only viewer put a visible reaction on
    // the customer's message even though RLS blocked the local mirror.
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`react:${userId}`, RATE_LIMITS.react);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const body = await request.json();
    const { message_id, emoji } = body as {
      message_id?: string;
      emoji?: string;
    };

    if (!message_id || typeof emoji !== 'string') {
      return NextResponse.json(
        { error: 'message_id and emoji are required' },
        { status: 400 },
      );
    }

    // Resolve target message + its conversation; verify ownership.
    const { data: targetMessage, error: msgError } = await supabase
      .from('messages')
      .select('id, message_id, conversation_id, provider, channel_id')
      .eq('id', message_id)
      .maybeSingle();

    if (msgError || !targetMessage) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    if (!targetMessage.message_id) {
      // No WhatsApp id yet — usually a sending/failed agent message. We
      // can't react to a message WhatsApp never received.
      return NextResponse.json(
        { error: 'Cannot react to a message that has not been sent to WhatsApp' },
        { status: 400 },
      );
    }

    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select(
        'id, account_id, user_id, assigned_agent_id, channel_id, send_channel_id, contact:contacts(phone)',
      )
      .eq('id', targetMessage.conversation_id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (convError || !conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 },
      );
    }

    // A coordinator who reaches the chat only through a share (130) may
    // read and reply on the chat's number, nothing more: the database
    // refuses their reaction write, so refuse before the gateway has
    // shown it to the customer.
    if (
      await reachesOnlyByShare(supabase, accountId, userId, {
        id: conversation.id,
        user_id: conversation.user_id as string | null,
        assigned_agent_id: conversation.assigned_agent_id as string | null,
        channel_id: conversation.channel_id as string | null,
        send_channel_id: conversation.send_channel_id as string | null,
      })
    ) {
      return NextResponse.json(
        { error: 'Reactions are not available in a shared chat' },
        { status: 403 },
      );
    }

    const contact = Array.isArray(conversation.contact)
      ? conversation.contact[0]
      : conversation.contact;
    if (!contact?.phone) {
      return NextResponse.json(
        { error: 'Contact phone number not found' },
        { status: 400 },
      );
    }

    // React through the number that CARRIED the message being reacted
    // to. A WhatsApp message id only exists on the gateway that sent or
    // received it — reacting through another number (the customer has
    // since written to a second one, or an agent pinned the chat, 061)
    // is refused. Exact number first (060+), then the provider of an
    // older row, and only for a row that records neither, the number
    // the customer is on now.
    let channel;
    try {
      const channels = await loadChannels(supabase, accountId);
      channel =
        (targetMessage.channel_id
          ? channels.find((c) => c.id === targetMessage.channel_id)
          : undefined) ??
        (isWhatsAppProvider(targetMessage.provider)
          ? pickByProvider(channels, targetMessage.provider, [
              conversation.channel_id as string | null,
            ])
          : null) ??
        (await resolveReplyChannel(
          supabase,
          accountId,
          targetMessage.conversation_id,
        ));
    } catch (err) {
      if (err instanceof ChannelError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }

    try {
      // Whapi addresses a reaction by the target message id alone (the
      // id identifies the chat); Meta needs the recipient too. The
      // provider layer absorbs the difference — `to` is ignored on Whapi.
      await sendReaction({
        channel,
        to: contact.phone,
        targetMessageId: targetMessage.message_id,
        emoji,
      });
    } catch (err) {
      const message = describeSendFailure(err);
      console.error('[whatsapp/react] send failed:', message);
      return NextResponse.json(
        { error: `WhatsApp API error: ${message}` },
        { status: 502 },
      );
    }

    // Mirror into DB. Empty emoji = removal.
    if (emoji === '') {
      const { error: delError } = await supabase
        .from('message_reactions')
        .delete()
        .eq('message_id', targetMessage.id)
        .eq('actor_type', 'agent')
        .eq('actor_id', userId);

      if (delError) {
        console.error('[whatsapp/react] DB delete failed:', delError.message);
        return NextResponse.json(
          { error: 'Reaction sent to WhatsApp but DB delete failed' },
          { status: 500 },
        );
      }
    } else {
      // Upsert. The unique constraint (message_id, actor_type, actor_id)
      // lets us swap emoji in a single statement.
      const { error: upsertError } = await supabase.from('message_reactions').upsert(
        {
          message_id: targetMessage.id,
          conversation_id: targetMessage.conversation_id,
          actor_type: 'agent',
          actor_id: userId,
          emoji,
        },
        { onConflict: 'message_id,actor_type,actor_id' },
      );

      if (upsertError) {
        console.error('[whatsapp/react] DB upsert failed:', upsertError.message);
        return NextResponse.json(
          { error: 'Reaction sent to WhatsApp but DB upsert failed' },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    // requireRole throws Unauthorized/Forbidden; toErrorResponse maps
    // those to 401/403 and collapses anything else to a generic 500.
    console.error('Error in WhatsApp react POST:', error);
    return toErrorResponse(error);
  }
}
