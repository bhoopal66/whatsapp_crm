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
 * Server-only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

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
  const { data: conv } = await db
    .from('conversations')
    .select('id, contact_id, channel_id, send_channel_id, personal_owner_id')
    .eq('id', claim.conversationId)
    .eq('account_id', claim.accountId)
    .maybeSingle();
  if (!conv || conv.contact_id !== claim.contactId)
    throw new DigestRefusal('conversation_missing');
  if (conv.personal_owner_id) throw new DigestRefusal('personal_number');

  const { data: contact } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', claim.contactId)
    .eq('account_id', claim.accountId)
    .maybeSingle();
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

  const { row } = await resolveTemplateRow(
    db,
    claim.accountId,
    claim.templateName,
    claim.language
  );
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
  if (refused) throw new DigestRefusal('invalid_number');

  // The gateway has the message: nothing below may turn it into a failure.
  try {
    const { data: msg } = await db
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
