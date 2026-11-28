/**
 * Sends one desk reminder digest (migration 234). Template only, on the
 * chat's OWN number (its pin, else the number it is on; a chat with no
 * number yet follows the human inbox rule), never a personal chat or
 * number. Meta sends the approved registry template with {{1}} = the
 * application number and {{2}} = the summary; Whapi and OpenWA have no
 * registry, so the rendered template body goes out as text. Recorded as
 * a bot message. Mirrors the HR automated-message sender
 * (`lib/hr/automsg/send.ts`).
 *
 * A contact opted out since the claim is refused ('opted_out'), and on a
 * linked device so is a start over the number's daily limit of new chats
 * ('number_daily_limit', migration 204). Team activity's other send
 * checks are not run. The send guard (meta-health/check-send.ts) runs
 * last, as a utility send ('send_protection_<reason>' when it refuses).
 *
 * Server-only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

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
import {
  checkSend,
  refundSendReservation,
} from '@/lib/whatsapp/meta-health/check-send';
import {
  isDefiniteSendRefusal,
  sendTemplate,
  sendText,
} from '@/lib/whatsapp/provider';
import {
  renderTemplateBody,
  resolveTemplateRow,
} from '@/lib/whatsapp/template-body';

import { DigestRefusal, type DigestClaim } from './digest';

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
    if (!channel) throw new DigestRefusal('not_connected');
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

export async function sendDeskDigest(
  db: SupabaseClient,
  claim: DigestClaim
): Promise<{ providerMessageId: string | null; messageId: string | null }> {
  const { data: conv, error: convError } = await db
    .from('conversations')
    .select('id, contact_id, channel_id, send_channel_id, personal_owner_id')
    .eq('id', claim.conversationId)
    .eq('account_id', claim.accountId)
    .maybeSingle();
  // A read of ours that failed says nothing about the chat: 316's enqueue
  // does not count it towards gap_days.
  if (convError) throw new DigestRefusal('read_failed');
  if (!conv || conv.contact_id !== claim.contactId)
    throw new DigestRefusal('conversation_missing');
  if (conv.personal_owner_id) throw new DigestRefusal('personal_number');

  const { data: contact, error: contactError } = await db
    .from('contacts')
    .select('id, phone, opted_out_at, do_not_contact_at')
    .eq('id', claim.contactId)
    .eq('account_id', claim.accountId)
    .maybeSingle();
  if (contactError) throw new DigestRefusal('read_failed');
  // The claim checked this once for its whole batch; a STOP may have
  // arrived since.
  if (contact?.opted_out_at || contact?.do_not_contact_at)
    throw new DigestRefusal('opted_out');
  const sanitized = contact?.phone ? sanitizePhoneForMeta(contact.phone) : '';
  if (!isValidE164(sanitized)) throw new DigestRefusal('invalid_number');

  const channel = await chatChannel(
    db,
    claim.accountId,
    claim.conversationId,
    (conv.send_channel_id as string | null) ??
      (conv.channel_id as string | null) ??
      null
  );
  if (channel.isPersonal) throw new DigestRefusal('personal_number');

  const { row, readFailed } = await resolveTemplateRow(
    db,
    claim.accountId,
    claim.templateName,
    claim.language
  );
  if (readFailed) throw new DigestRefusal('read_failed');
  if (!row) throw new DigestRefusal('template_not_found');
  if (
    String(row.status ?? '').toLowerCase() !== 'approved' ||
    String(row.category ?? '').toLowerCase() !== 'utility'
  )
    throw new DigestRefusal('template_rejected');
  const params = [claim.appNumber, claim.summary];
  const text = renderTemplateBody(row.body_text, params);

  let attempt: (phone: string) => Promise<string>;
  let contentType: 'template' | 'text';
  const provider = channel.provider;
  switch (provider) {
    case 'meta':
      attempt = async (to) =>
        (await sendTemplate({ channel, to, template: row, bodyParams: params }))
          .messageId;
      contentType = 'template';
      break;
    case 'whapi':
    case 'openwa':
      attempt = async (to) => (await sendText({ channel, to, text })).messageId;
      contentType = 'text';
      break;
    default: {
      const never: never = provider;
      throw new Error(`unsupported provider ${String(never)}`);
    }
  }

  // The number's own daily limit of new chats (204): a no-op on Meta,
  // fails open.
  const check = await checkAutoStartAllowed(
    db,
    claim.accountId,
    claim.conversationId,
    channel
  );
  // No held state here: this one fails, and counts as a try for gap_days.
  if (check.blocked) throw new DigestRefusal('number_daily_limit');

  // The send guard (meta-health/check-send.ts), as the automation sender
  // runs it: a digest is a utility template whichever provider carries
  // it. While the owner's `enforce` is off it always allows (the decision
  // is only logged). A refusal fails like the daily limit above, with the
  // guard's reason.
  const verdict = await checkSend(db, {
    accountId: claim.accountId,
    configId: channel.id,
    contactId: claim.contactId,
    kind: 'UTILITY',
    templateName: claim.templateName,
  });
  if (!verdict.allow)
    throw new DigestRefusal(`send_protection_${verdict.reason.toLowerCase()}`);

  let waMessageId = '';
  let lastError: unknown = null;
  try {
    for (const v of phoneVariants(sanitized)) {
      try {
        waMessageId = await attempt(v);
        lastError = null;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!isRecipientNotAllowedError(msg)) throw err;
        lastError = err;
      }
    }
  } catch (err) {
    // Any held spend goes back only when the gateway certainly did not
    // send it; a timeout or a 5xx may have reached the customer.
    if (isDefiniteSendRefusal(err))
      await refundSendReservation(db, verdict.reservation);
    throw err;
  }
  if (lastError) {
    if (isDefiniteSendRefusal(lastError))
      await refundSendReservation(db, verdict.reservation);
    throw new DigestRefusal('invalid_number');
  }

  // The gateway has the message: nothing below may turn it into a failure.
  try {
    const { data: msg, error: msgError } = await db
      .from('messages')
      .insert({
        conversation_id: claim.conversationId,
        sender_type: 'bot',
        content_type: contentType,
        content_text: text,
        template_name: contentType === 'template' ? claim.templateName : null,
        message_id: waMessageId,
        status: 'sent',
        provider: channel.provider,
        channel_id: channel.id,
      })
      .select('id')
      .single();
    if (msgError)
      console.error(
        `[desk] digest ${claim.id} was sent but not recorded (${msgError.code ?? '-'})`
      );
    const now = new Date().toISOString();
    await db
      .from('conversations')
      .update({
        last_message_text: text,
        last_message_at: now,
        updated_at: now,
      })
      .eq('id', claim.conversationId)
      .eq('account_id', claim.accountId);
    return {
      providerMessageId: waMessageId,
      messageId: msg ? String(msg.id) : null,
    };
  } catch {
    return { providerMessageId: waMessageId, messageId: null };
  }
}
