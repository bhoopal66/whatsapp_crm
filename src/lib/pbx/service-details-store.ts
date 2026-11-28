// Call service details (migration 336): the database and gateway side of
// runServiceDetails. Every port reads or writes with the client it is
// given, which is the service-role client process.ts runs with (claim and
// settle are granted to service_role only). The send follows the case
// CSAT sender (lib/cases/csat-send.ts): the contact's company chat, its
// number, Meta only, an approved utility template, recorded in the chat.
//
// Server-only.
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  resolveSendChannel,
  type WhatsAppChannel,
} from '@/lib/whatsapp/channels';
import {
  isRecipientNotAllowedError,
  phoneVariants,
  sanitizePhoneForMeta,
} from '@/lib/whatsapp/phone-utils';
import { isDefiniteSendRefusal, sendTemplate } from '@/lib/whatsapp/provider';
import {
  renderTemplateBody,
  resolveTemplateRow,
} from '@/lib/whatsapp/template-body';

import { storedPhoneCandidates } from './phone';
import {
  DEFAULT_SERVICE_DETAILS_SETTINGS,
  runServiceDetails,
  type ContactHit,
  type FinishedCall,
  type ServiceDetailsOutcome,
  type ServiceDetailsPorts,
  type ServiceDetailsSettings,
  type ServiceMapRow,
} from './service-details';

type Row = Record<string, unknown>;
const MATCH_TYPES = new Set(['queue', 'did', 'extension']);

function fail(what: string, error: { code?: string; message?: string }) {
  // The code only: a message can quote the row.
  throw new Error(`${what} failed ${error.code ?? ''}`.trim());
}

/** The sent template in the chat, and the chat's preview. Never throws. */
async function recordMessage(
  db: SupabaseClient,
  m: {
    accountId: string;
    conversationId: string;
    channel: WhatsAppChannel;
    templateName: string;
    body: string;
    waMessageId: string | null;
    status: 'sent' | 'sending';
  }
): Promise<void> {
  try {
    const { error } = await db.from('messages').insert({
      conversation_id: m.conversationId,
      sender_type: 'bot',
      content_type: 'template',
      content_text: m.body,
      template_name: m.templateName,
      message_id: m.waMessageId,
      status: m.status,
      provider: m.channel.provider,
      channel_id: m.channel.id,
    });
    if (error)
      console.error(
        '[pbx] service details message not saved',
        error.code ?? ''
      );
    const now = new Date().toISOString();
    await db
      .from('conversations')
      .update({
        last_message_text: m.body,
        last_message_at: now,
        updated_at: now,
      })
      .eq('id', m.conversationId)
      .eq('account_id', m.accountId);
  } catch {
    // The chat's copy only: the customer has the message.
  }
}

async function send(
  db: SupabaseClient,
  args: Parameters<ServiceDetailsPorts['send']>[0]
): Promise<boolean> {
  const { accountId, contactId, templateName, language, params } = args;
  const conv = await db
    .from('conversations')
    .select('id, channel_id, send_channel_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .is('personal_owner_id', null)
    .order('created_at', { ascending: false })
    .limit(1);
  if (conv.error) fail('conversations read', conv.error);
  const chat = ((conv.data ?? []) as Row[])[0];
  if (!chat) return false;
  const conversationId = String(chat.id);

  const channel = await resolveSendChannel(
    db,
    accountId,
    'inbox',
    conversationId,
    null,
    null,
    {
      channelId: (chat.channel_id as string | null) ?? null,
      sendChannelId: (chat.send_channel_id as string | null) ?? null,
      personalOwnerId: null,
    }
  );
  // Only Meta sends an approved template outside the 24-hour window.
  if (channel.isPersonal || channel.provider !== 'meta') return false;

  const { row } = await resolveTemplateRow(
    db,
    accountId,
    templateName,
    language
  );
  if (
    !row ||
    String(row.status ?? '').toLowerCase() !== 'approved' ||
    String(row.category ?? '').toLowerCase() !== 'utility'
  )
    return false;

  const bodyParams = [...params];
  const body = renderTemplateBody(String(row.body_text ?? ''), bodyParams);
  const record = (waMessageId: string | null, status: 'sent' | 'sending') =>
    recordMessage(db, {
      accountId,
      conversationId,
      channel,
      templateName,
      body,
      waMessageId,
      status,
    });

  for (const to of phoneVariants(sanitizePhoneForMeta(args.phone))) {
    try {
      const { messageId } = await sendTemplate({
        channel,
        to,
        template: row,
        bodyParams,
      });
      await record(messageId, 'sent');
      return true;
    } catch (err) {
      if (!isDefiniteSendRefusal(err)) {
        // It may have been delivered: never another variant, never
        // resent. Counted as sent (the daily cap counts it) and shown in
        // the chat as still sending, as an unconfirmed CSAT request is.
        await record(null, 'sending');
        return true;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRecipientNotAllowedError(msg)) return false;
    }
  }
  return false;
}

export function serviceDetailsPorts(db: SupabaseClient): ServiceDetailsPorts {
  return {
    async loadSettings(accountId): Promise<ServiceDetailsSettings> {
      const { data, error } = await db
        .from('pbx_service_details_settings')
        .select(
          'enabled, template_name, language, min_seconds, inbound, outbound'
        )
        .eq('account_id', accountId)
        .maybeSingle();
      if (error) fail('service details settings read', error);
      const r = data as Row | null;
      if (!r) return DEFAULT_SERVICE_DETAILS_SETTINGS;
      return {
        enabled: r.enabled === true,
        templateName: (r.template_name as string | null) ?? null,
        language: (r.language as string | null) ?? null,
        minSeconds: Number(
          r.min_seconds ?? DEFAULT_SERVICE_DETAILS_SETTINGS.minSeconds
        ),
        inbound: r.inbound === true,
        outbound: r.outbound === true,
      };
    },

    async loadMap(accountId): Promise<ServiceMapRow[]> {
      const { data, error } = await db
        .from('pbx_service_map')
        .select('match_type, match_value, label')
        .eq('account_id', accountId);
      if (error) fail('service map read', error);
      return ((data ?? []) as Row[])
        .filter((r) => MATCH_TYPES.has(String(r.match_type)))
        .map((r) => ({
          matchType: r.match_type as ServiceMapRow['matchType'],
          matchValue: String(r.match_value ?? ''),
          label: String(r.label ?? ''),
        }));
    },

    async findContacts(accountId, phone): Promise<ContactHit[]> {
      const candidates = storedPhoneCandidates(phone);
      if (!candidates.length) return [];
      const { data, error } = await db
        .from('contacts')
        .select('id, name, opted_out_at, do_not_contact_at')
        .eq('account_id', accountId)
        .in('phone_normalized', candidates)
        .limit(10);
      if (error) fail('contacts read', error);
      return ((data ?? []) as Row[]).map((r) => ({
        id: String(r.id),
        name: (r.name as string | null) ?? null,
        optedOutAt: (r.opted_out_at as string | null) ?? null,
        doNotContactAt: (r.do_not_contact_at as string | null) ?? null,
      }));
    },

    async claim(call: FinishedCall, outcome, contactId) {
      const { data, error } = await db.rpc('pbx_service_details_claim', {
        p_account: call.accountId,
        p_call: call.callRowId,
        p_outcome: outcome,
        p_contact: contactId,
      });
      if (error) fail('pbx_service_details_claim', error);
      // 'opted_out' (a STOP since the lookup) and anything unknown take
      // nothing: never a send.
      return data === 'claimed' || data === 'daily_cap' ? data : 'duplicate';
    },

    send: (args) => send(db, args),

    async settle(call: FinishedCall, outcome) {
      const { error } = await db.rpc('pbx_service_details_settle', {
        p_account: call.accountId,
        p_call: call.callRowId,
        p_outcome: outcome,
      });
      if (error) fail('pbx_service_details_settle', error);
    },
  };
}

/** The finished call's service details message. Never throws. */
export function sendCallServiceDetails(
  db: SupabaseClient,
  call: FinishedCall
): Promise<ServiceDetailsOutcome> {
  return runServiceDetails(serviceDetailsPorts(db), call);
}
