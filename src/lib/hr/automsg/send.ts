/**
 * HR automated messages: the real WhatsApp sender. Template only, and on
 * the chat's OWN number (its pin, else the number it is on), never the
 * account's automation route: a candidate hears from the number the
 * recruiter talks to them on. A chat with no number yet follows the
 * human inbox rule (the number the customer last wrote to).
 *
 * Never from a personal chat (migration 191) or a personal number (190):
 * SQL never enqueues one, and this refuses again before any gateway call.
 *
 * Meta sends the approved registry template named by the HR template,
 * with {name}/{slot} as positional body params in the stored template's
 * token order (`templateBody`); Whapi and OpenWA have no
 * registry, so the rendered body goes out as text. Either way the message
 * is recorded like an automation send (sender_type 'bot').
 *
 * Server-only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendTemplate, sendText } from '@/lib/whatsapp/provider';
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
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import type { SendPort, TemplateSendRequest } from './ports';

type Param = keyof TemplateSendRequest['params'];
const TOKEN = /\{(name|slot)\}/g;

/**
 * The Meta body params, in the order the stored HR template uses its
 * {name}/{slot} tokens (first use of each), read from `templateBody` only:
 * the rendered text cannot say which value came from which token.
 */
export function metaBodyParams(req: TemplateSendRequest): string[] {
  const tokens = [...req.templateBody.matchAll(TOKEN)].map(
    (m) => m[1] as Param
  );
  return [...new Set(tokens)].map((k) => req.params[k]);
}

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
    if (!channel)
      throw new Error("the chat's WhatsApp number is not connected");
    return channel;
  }
  // No number yet: the human inbox rule, which follows the customer.
  return resolveSendChannel(
    db,
    accountId,
    'inbox',
    conversationId,
    null,
    null,
    { channelId: null, sendChannelId: null, personalOwnerId: null }
  );
}

async function sendHrTemplate(
  db: SupabaseClient,
  req: TemplateSendRequest
): Promise<{ providerMessageId: string | null; messageId: string | null }> {
  const { data: conv, error: convErr } = await db
    .from('conversations')
    .select(
      'id, account_id, contact_id, channel_id, send_channel_id, personal_owner_id'
    )
    .eq('id', req.conversationId)
    .eq('account_id', req.accountId)
    .maybeSingle();
  if (convErr || !conv)
    throw new Error('conversation not found for this account');
  if (conv.personal_owner_id) {
    throw new Error('automated messages are never sent from a personal chat');
  }
  if (conv.contact_id !== req.contactId) {
    throw new Error('the contact is not this conversation’s contact');
  }

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', req.contactId)
    .eq('account_id', req.accountId)
    .maybeSingle();
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account');
  }
  const sanitized = sanitizePhoneForMeta(contact.phone);
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`);
  }

  const channel = await chatChannel(
    db,
    req.accountId,
    req.conversationId,
    (conv.send_channel_id as string | null) ??
      (conv.channel_id as string | null) ??
      null
  );
  if (channel.isPersonal) {
    throw new Error('automated messages are never sent from a personal number');
  }

  const text = req.body;
  let attempt: (phone: string) => Promise<string>;
  let contentType: 'template' | 'text';
  let templateName: string | null;
  const provider = channel.provider;
  switch (provider) {
    case 'meta': {
      const { row } = await resolveTemplateRow(
        db,
        req.accountId,
        req.metaTemplateName,
        req.language
      );
      if (!row) {
        throw new Error(
          `no local template named "${req.metaTemplateName}" for this account`
        );
      }
      const bodyParams = metaBodyParams(req);
      attempt = async (to) =>
        (await sendTemplate({ channel, to, template: row, bodyParams }))
          .messageId;
      contentType = 'template';
      templateName = req.metaTemplateName;
      break;
    }
    case 'whapi':
    case 'openwa':
      attempt = async (to) => (await sendText({ channel, to, text })).messageId;
      contentType = 'text';
      templateName = null;
      break;
    default: {
      const never: never = provider;
      throw new Error(`unsupported provider ${String(never)}`);
    }
  }

  // Same phone-variant retry as the automation sender: numbers registered
  // with and without a trunk 0 both need it to land.
  let workingPhone = sanitized;
  let waMessageId = '';
  let lastError: unknown = null;
  for (const v of phoneVariants(sanitized)) {
    try {
      waMessageId = await attempt(v);
      workingPhone = v;
      lastError = null;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRecipientNotAllowedError(msg)) throw err;
      lastError = err;
    }
  }
  if (lastError) throw lastError;

  // The gateway has the message: nothing below may turn this into a
  // failure, or the engine would mark a delivered message failed.
  try {
    if (workingPhone !== sanitized) {
      await db
        .from('contacts')
        .update({ phone: workingPhone })
        .eq('id', contact.id)
        .eq('account_id', req.accountId);
    }

    const { data: msg, error: msgErr } = await db
      .from('messages')
      .insert({
        conversation_id: req.conversationId,
        sender_type: 'bot',
        content_type: contentType,
        content_text: text,
        template_name: templateName,
        message_id: waMessageId,
        status: 'sent',
        provider: channel.provider,
        channel_id: channel.id,
      })
      .select('id')
      .single();
    if (msgErr || !msg) {
      console.error(
        '[hr-automsg] sent but the message row failed:',
        msgErr?.message ?? 'no row'
      );
      return { providerMessageId: waMessageId, messageId: null };
    }

    const now = new Date().toISOString();
    await db
      .from('conversations')
      .update({
        last_message_text: text,
        last_message_at: now,
        updated_at: now,
      })
      .eq('id', req.conversationId)
      .eq('account_id', req.accountId);

    return { providerMessageId: waMessageId, messageId: String(msg.id) };
  } catch (err) {
    console.error(
      '[hr-automsg] sent but recording it failed:',
      err instanceof Error ? err.message : err
    );
    return { providerMessageId: waMessageId, messageId: null };
  }
}

export function createHrSendPort(db: SupabaseClient): SendPort {
  return { send: (req) => sendHrTemplate(db, req) };
}
