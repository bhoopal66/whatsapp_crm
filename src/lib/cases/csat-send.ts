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
 * A chat or contact that cannot be read is HELD ('lookup_failed') too.
 * A contact opted out since the claim is refused ('opted_out'). On a
 * linked device the number's daily limit of new chats applies (migration
 * 204, as for broadcasts): over it the request is HELD
 * ('number_daily_limit') and SQL retries it hourly. Team activity's other
 * send checks are not run.
 *
 * The row is stamped (case_csat_handoff, 281) as the last thing before the
 * gateway. After it, only a definite refusal is a CsatRefusal ('failed'):
 * a timeout, a 5xx or a lost connection may have delivered the request, so
 * it is 'unconfirmed', with its message in the chat (no provider id, shown
 * as still sending) so that a reply to it counts.
 *
 * Server-only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { serviceWindowOpen } from '@/lib/compass/meta-template';
import { checkAutoStartAllowed } from '@/lib/team-activity/auto-guard';
import {
  ChannelError,
  loadChannels,
  resolveSendChannel,
  type WhatsAppChannel,
} from '@/lib/whatsapp/channels';
import {
  checkSend,
  refundSendReservation,
  type SendReservation,
} from '@/lib/whatsapp/meta-health/check-send';
import {
  isRecipientNotAllowedError,
  isValidE164,
  phoneVariants,
  sanitizePhoneForMeta,
} from '@/lib/whatsapp/phone-utils';
import {
  isDefiniteSendRefusal,
  sendTemplate,
  sendText,
} from '@/lib/whatsapp/provider';
import {
  renderTemplateBody,
  resolveTemplateRow,
} from '@/lib/whatsapp/template-body';

import {
  buildCsatText,
  csatFunctionMissing,
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

/** Nothing was sent; SQL retries a held request hourly. */
function lookupFailed(table: string, code: string | undefined): CsatSendResult {
  console.error(`[cases] csat ${table} read failed`, code ?? '');
  return { outcome: 'held', reason: 'lookup_failed' };
}

/**
 * Stamps the row as handed over. Null: go ahead (also before 281, which has
 * no stamp). A failed stamp is tried once more, then held: case_csat_mark
 * takes a stamp whose answer was lost back.
 */
async function handOff(
  db: SupabaseClient,
  claim: CsatClaim
): Promise<CsatSendResult | null> {
  for (let i = 0; ; i++) {
    const { data, error } = await db.rpc('case_csat_handoff', {
      p_id: claim.id,
      p_claimed_at: claim.claimedAt,
    });
    if (!error) return data === true ? null : { outcome: 'lost' };
    if (csatFunctionMissing(error)) return null;
    if (i > 0) return lookupFailed('handoff', error.code);
  }
}

/** The request in the chat, and the chat's preview. Never throws. */
async function recordMessage(
  db: SupabaseClient,
  claim: CsatClaim,
  channel: WhatsAppChannel,
  sent: {
    via: 'template' | 'text';
    body: string;
    waMessageId: string | null;
    status: 'sent' | 'sending';
  }
): Promise<string | null> {
  try {
    const { data: msg, error: msgError } = await db
      .from('messages')
      .insert({
        conversation_id: claim.conversationId,
        sender_type: 'bot',
        content_type: sent.via,
        content_text: sent.body,
        template_name: sent.via === 'template' ? claim.templateName : null,
        message_id: sent.waMessageId,
        status: sent.status,
        provider: channel.provider,
        channel_id: channel.id,
      })
      .select('id')
      .single();
    if (msgError)
      console.error('[cases] csat message not saved', msgError.code ?? '');
    const messageId = msg ? String(msg.id) : null;
    const now = new Date().toISOString();
    try {
      await db
        .from('conversations')
        .update({
          last_message_text: sent.body,
          last_message_at: now,
          updated_at: now,
        })
        .eq('id', claim.conversationId)
        .eq('account_id', claim.accountId);
    } catch {
      // The preview only.
    }
    return messageId;
  } catch {
    return null;
  }
}

export async function sendCaseCsat(
  db: SupabaseClient,
  claim: CsatClaim
): Promise<CsatSendResult> {
  const { data: conv, error: convError } = await db
    .from('conversations')
    .select('id, contact_id, channel_id, send_channel_id, personal_owner_id')
    .eq('id', claim.conversationId)
    .eq('account_id', claim.accountId)
    .maybeSingle();
  if (convError) return lookupFailed('conversations', convError.code);
  if (!conv || conv.contact_id !== claim.contactId)
    throw new CsatRefusal('conversation_missing');
  if (conv.personal_owner_id) throw new CsatRefusal('personal_number');

  const { data: contact, error: contactError } = await db
    .from('contacts')
    .select('id, phone, opted_out_at, do_not_contact_at')
    .eq('id', claim.contactId)
    .eq('account_id', claim.accountId)
    .maybeSingle();
  if (contactError) return lookupFailed('contacts', contactError.code);
  // The claim checked this once for its whole batch; a STOP may have
  // arrived since.
  if (contact?.opted_out_at || contact?.do_not_contact_at)
    throw new CsatRefusal('opted_out');
  const sanitized = contact?.phone ? sanitizePhoneForMeta(contact.phone) : '';
  if (!isValidE164(sanitized)) throw new CsatRefusal('invalid_number');

  let channel: WhatsAppChannel;
  try {
    channel = await chatChannel(
      db,
      claim.accountId,
      claim.conversationId,
      (conv.send_channel_id as string | null) ??
        (conv.channel_id as string | null) ??
        null
    );
  } catch (err) {
    if (!(err instanceof ChannelError)) throw err;
    if (err.code === 'channel_lookup_failed')
      return lookupFailed('channels', err.code);
    throw new CsatRefusal(err.code);
  }
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

  // The send guard (meta-health/check-send.ts) before the template, as in
  // automations/channel-send.ts; a text send is not guarded. While the
  // owner's `enforce` is off it always allows (the decision is only
  // logged). A refusal sends nothing: opt-out and a blocked number are
  // final (failed), any other reason (a pause, unreadable state) is held
  // and retried hourly. SQL keeps only [a-z0-9_] of a reason.
  let reservation: SendReservation | undefined;
  if (decision === 'template' && row) {
    const verdict = await checkSend(db, {
      accountId: claim.accountId,
      configId: channel.id,
      contactId: claim.contactId,
      // Only an approved utility template gets here (decideCsatSend).
      kind: 'UTILITY',
      templateName: claim.templateName,
    });
    if (!verdict.allow) {
      const reason = verdict.reason.toLowerCase();
      if (verdict.reason === 'OPTED_OUT' || verdict.reason === 'TOTAL_BLOCK')
        throw new CsatRefusal(reason);
      return { outcome: 'held', reason };
    }
    reservation = verdict.reservation;
  }

  const lost = await handOff(db, claim);
  if (lost) return lost;

  const via = decision === 'template' ? 'template' : 'text';
  let waMessageId = '';
  let refused = false;
  for (const v of phoneVariants(sanitized)) {
    try {
      waMessageId = await attempt(v);
      refused = false;
      break;
    } catch (err) {
      if (!isDefiniteSendRefusal(err)) {
        // It may have been delivered: no other variant, never resent.
        const reason = err instanceof Error ? err.name.toLowerCase() : 'error';
        const messageId = await recordMessage(db, claim, channel, {
          via,
          body,
          waMessageId: null,
          status: 'sending',
        });
        return { outcome: 'unconfirmed', via, messageId, reason };
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRecipientNotAllowedError(msg)) {
        // Certainly not sent: any held spend goes back.
        await refundSendReservation(db, reservation);
        throw new CsatRefusal(
          err instanceof Error ? err.name.toLowerCase() : 'error'
        );
      }
      refused = true;
    }
  }
  if (refused) {
    await refundSendReservation(db, reservation);
    throw new CsatRefusal('invalid_number');
  }

  // The gateway has the message: nothing below may turn it into a failure.
  return {
    outcome: 'sent',
    via,
    providerMessageId: waMessageId,
    messageId: await recordMessage(db, claim, channel, {
      via,
      body,
      waMessageId,
      status: 'sent',
    }),
  };
}
