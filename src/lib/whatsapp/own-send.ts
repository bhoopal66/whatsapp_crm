/**
 * Messages the owner of a personal OpenWA number (migration 190) types
 * on their phone, filed into their personal chat as sent by them.
 *
 * OpenWA reports every send of the number as `message.sent`, the CRM's
 * own sends included, with the id the REST send returned, which the
 * send path stores as `messages.message_id`. So a row already holding
 * that id is the CRM's send (or a replay) and nothing is written. When
 * the echo wins the race, the send path adopts the row instead
 * (send-message.ts, the 23505 branch).
 *
 * Archive only: no unread bump, no reopen, no fan-out, no push, no
 * outbound webhook. Runs on the service role (the webhook has no user).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WhatsAppChannel } from './channels';
import {
  findOrCreateContact,
  findOrCreatePersonalChat,
} from './inbound-pipeline';
import { openwaBaseUrl } from './openwa-api';

export interface OwnSend {
  id: string;
  peerPhone: string;
  text: string;
  /** Epoch seconds, as a string. */
  timestamp: string;
}

export type OwnSendOutcome = 'inserted' | 'exists' | 'skipped';

function isoFromSeconds(seconds: string): string {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0
    ? new Date(n * 1000).toISOString()
    : new Date().toISOString();
}

export async function persistOwnSend(
  db: SupabaseClient,
  channel: WhatsAppChannel,
  send: OwnSend
): Promise<OwnSendOutcome> {
  const ownerId = channel.isPersonal ? channel.personalUserId : null;
  if (!ownerId) return 'skipped';

  const contact = await findOrCreateContact(
    channel.accountId,
    ownerId,
    send.peerPhone,
    send.peerPhone
  );
  if (!contact) return 'skipped';
  const chat = await findOrCreatePersonalChat(
    db,
    channel.accountId,
    contact.contact.id,
    channel
  );
  if (!chat) return 'skipped';
  const conversationId = chat.conversation.id as string;

  const { data: existing, error: readError } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('message_id', send.id)
    .limit(1);
  if (readError) throw readError;
  if (existing && existing.length > 0) return 'exists';

  const createdAt = isoFromSeconds(send.timestamp);
  const { data: inserted, error } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversationId,
        sender_type: 'agent',
        sender_id: ownerId,
        content_type: 'text',
        content_text: send.text,
        message_id: send.id,
        status: 'sent',
        provider: 'openwa',
        channel_id: channel.id,
        created_at: createdAt,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id');
  if (error) throw error;
  if (!inserted || inserted.length === 0) return 'exists';

  const { error: summaryError } = await db
    .from('conversations')
    .update({
      last_message_text: send.text,
      last_message_at: createdAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);
  if (summaryError) {
    console.error('[own-send] summary update failed:', summaryError);
  }
  return 'inserted';
}

/**
 * The phone number behind an `@lid` peer, or null when the gateway has
 * not learned it. Best-effort: any failure is null.
 */
export async function resolveOpenWALidPhone(args: {
  apiKey: string;
  sessionId: string;
  lid: string;
}): Promise<string | null> {
  try {
    const url = `${openwaBaseUrl()}/api/sessions/${encodeURIComponent(
      args.sessionId
    )}/contacts/${encodeURIComponent(args.lid)}/phone`;
    const res = await fetch(url, {
      headers: { 'X-API-Key': args.apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { phone?: string | null };
    const digits = (body?.phone ?? '').replace(/\D/g, '');
    return digits || null;
  } catch {
    return null;
  }
}
