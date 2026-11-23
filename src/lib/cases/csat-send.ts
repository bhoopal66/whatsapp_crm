/**
 * Sends one case CSAT rating request (migration 246). On the chat's OWN
 * number (its pin, else the number it is on; a chat with no number yet
 * follows the human inbox rule), never a personal chat or number.
 *
 *  * Whapi / OpenWA: the approved wording as plain text (buildCsatText),
 *    "Reply with a number from 1 (not happy) to 5 (very happy)".
 *  * Meta inside the customer's 24-hour window on that number: the same
 *    text. Outside it: the approved utility template for the trigger with
 *    {{1}} = first name, {{2}} = bank and product; with none the request is HELD
 *    ('awaiting_template'), nothing is sent.
 *
 * Recorded as a bot message. Mirrors the desk digest sender
 * (`lib/desk/digest-send.ts`), which mirrors the HR automated messages.
 * A contact opted out since the claim is refused ('opted_out'). On a
 * linked device the number's daily limit of new chats applies (migration
 * 204, as for broadcasts): over it the request is HELD
 * ('number_daily_limit') and SQL retries it hourly. Team activity's other
 * send checks are not run.
 *
 * Server-only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { serviceWindowOpen } from '@/lib/compass/meta-template';
import { checkAutoStartAllowed } from '@/lib/team-activity/auto-guard';
import {
  loadChannels,
  resolveSendChannel,
  type WhatsAppChannel,
} from '@/lib/whatsapp/channels';
import {
  isRecipientNotAllowedError,
  isValidE164,
  phoneVariants,
  sanitizePhoneForMeta,
} from '@/lib/whatsapp/phone-utils';
import { sendTemplate, sendText } from '@/lib/whatsapp/provider';
import {
  renderTemplateBody,
  resolveTemplateRow,
} from '@/lib/whatsapp/template-body';

import {
  buildCsatText,
  csatParams,
  CsatRefusal,
  decideCsatSend,
  type CsatClaim,
  type CsatSendResult,
} from './csat';

async function chatChannel(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  own: string | null
): Promise<WhatsAppChannel> {
  if (own) {
    const channel = (await loadChannels(db, accountId)).find(
      (c) => c.id === own
    );
    if (!channel) throw new CsatRefusal('not_connected');
    return channel;
  }
  return resolveSendChannel(
    db,
    accountId,
    'inbox',
    conversationId,
    null,
    null,
    {
      channelId: null,
      sendChannelId: null,
      personalOwnerId: null,
    }
  );
}

/** The customer wrote to this Meta number less than 24 hours ago. */
async function metaWindowOpen(
  db: SupabaseClient,
  conversationId: string,
  channelId: string
): Promise<boolean> {
  const { data, error } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return false;
  return serviceWindowOpen((data as { created_at?: string }).created_at);
}

export async function sendCaseCsat(
  db: SupabaseClient,
  claim: CsatClaim
): Promise<CsatSendResult> {
  const { data: conv } = await db
    .from('conversations')
    .select('id, contact_id, channel_id, send_channel_id, personal_owner_id')
    .eq('id', claim.conversationId)
    .eq('account_id', claim.accountId)
    .maybeSingle();
  if (!conv || conv.contact_id !== claim.contactId)
    throw new CsatRefusal('conversation_missing');
  if (conv.personal_owner_id) throw new CsatRefusal('personal_number');

  const { data: contact } = await db
    .from('contacts')
    .select('id, phone, opted_out_at, do_not_contact_at')
    .eq('id', claim.contactId)
    .eq('account_id', claim.accountId)
    .maybeSingle();
  // The claim checked this once for its whole batch; a STOP may have
  // arrived since.
  if (contact?.opted_out_at || contact?.do_not_contact_at)
    throw new CsatRefusal('opted_out');
  const sanitized = contact?.phone ? sanitizePhoneForMeta(contact.phone) : '';
  if (!isValidE164(sanitized)) throw new CsatRefusal('invalid_number');

  const channel = await chatChannel(
    db,
    claim.accountId,
    claim.conversationId,
    (conv.send_channel_id as string | null) ??
      (conv.channel_id as string | null) ??
      null
  );
  if (channel.isPersonal) throw new CsatRefusal('personal_number');

  const input = {
    trigger: claim.trigger,
    contactName: claim.contactName,
    bankName: claim.bankName,
    product: claim.product,
    language: claim.language,
  };
  const text = buildCsatText(input);
  // {{1}} = first name, {{2}} = bank and product.
  const params = csatParams(input);

  let decision: 'text' | 'template' | 'hold';
  let templateRow: Awaited<ReturnType<typeof resolveTemplateRow>>['row'] = null;
  const provider = channel.provider;
  switch (provider) {
    case 'meta': {
      const windowOpen = await metaWindowOpen(
        db,
        claim.conversationId,
        channel.id
      );
      if (!windowOpen) {
        templateRow = (
          await resolveTemplateRow(
            db,
            claim.accountId,
            claim.templateName,
            claim.language
          )
        ).row;
      }
      decision = decideCsatSend({
        provider,
        windowOpen,
        templateApproved:
          !!templateRow &&
          String(templateRow.status ?? '').toLowerCase() === 'approved' &&
          String(templateRow.category ?? '').toLowerCase() === 'utility' &&
          String(templateRow.body_text ?? '').includes('{{1}}') &&
          String(templateRow.body_text ?? '').includes('{{2}}'),
      });
      break;
    }
    case 'whapi':
    case 'openwa':
      decision = decideCsatSend({
        provider,
        windowOpen: false,
        templateApproved: false,
      });
      break;
    default: {
      const never: never = provider;
      throw new Error(`unsupported provider ${String(never)}`);
    }
  }
  if (decision === 'hold')
    return { outcome: 'held', reason: 'awaiting_template' };

  const row = templateRow;
  const body =
    decision === 'template' && row
      ? renderTemplateBody(row.body_text, params)
      : text;
  const attempt = async (to: string): Promise<string> =>
    decision === 'template' && row
      ? (await sendTemplate({ channel, to, template: row, bodyParams: params }))
          .messageId
      : (await sendText({ channel, to, text })).messageId;

  // The number's own daily limit of new chats (204): a no-op on Meta,
  // fails open.
  const check = await checkAutoStartAllowed(
    db,
    claim.accountId,
    claim.conversationId,
    channel
  );
  if (check.blocked) return { outcome: 'held', reason: 'number_daily_limit' };

  let waMessageId = '';
  let refused = false;
  for (const v of phoneVariants(sanitized)) {
    try {
      waMessageId = await attempt(v);
      refused = false;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRecipientNotAllowedError(msg)) throw err;
      refused = true;
    }
  }
  if (refused) throw new CsatRefusal('invalid_number');

  const via = decision === 'template' ? 'template' : 'text';
  // The gateway has the message: nothing below may turn it into a failure.
  try {
    const { data: msg } = await db
      .from('messages')
      .insert({
        conversation_id: claim.conversationId,
        sender_type: 'bot',
        content_type: via,
        content_text: body,
        template_name: via === 'template' ? claim.templateName : null,
        message_id: waMessageId,
        status: 'sent',
        provider: channel.provider,
        channel_id: channel.id,
      })
      .select('id')
      .single();
    const now = new Date().toISOString();
    await db
      .from('conversations')
      .update({
        last_message_text: body,
        last_message_at: now,
        updated_at: now,
      })
      .eq('id', claim.conversationId)
      .eq('account_id', claim.accountId);
    return {
      outcome: 'sent',
      via,
      providerMessageId: waMessageId,
      messageId: msg ? String(msg.id) : null,
    };
  } catch {
    return {
      outcome: 'sent',
      via,
      providerMessageId: waMessageId,
      messageId: null,
    };
  }
}
