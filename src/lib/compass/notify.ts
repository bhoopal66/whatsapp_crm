// ============================================================
// Taamul Compass — status notifications (migration 056).
//
// Compass tells a customer that something happened to their bank
// account application ("documents received", "approved", ...). Three
// rules shape this, each a requirement rather than a preference:
//
//   1. ALWAYS the Whapi number. These are free-form messages; on the
//      Meta Cloud API number a free-form message outside the 24-hour
//      window is refused, and templates are not what Compass sends.
//      If Whapi is not connected the send FAILS (`whapi_not_connected`)
//      instead of quietly falling back to Meta.
//
//   2. Land in the EXISTING chat and leave it where it is. The message
//      goes into the contact's one conversation (resolved exactly as the
//      public messages API does), and nothing here writes
//      `conversations.user_id` / `assigned_agent_id` or the contact's
//      owner. The agent handling that customer sees the update appear in
//      their own thread. The message carries no `sender_id`, so the
//      Inbox does not name a human as its sender either, and an existing
//      contact's name is not overwritten with the ERP's spelling.
//
//   3. At most once per `idempotency_key`. Compass will retry on a
//      timeout; the customer must not hear "approved" twice. The key is
//      claimed (row inserted as `sending`) before the gateway call.
//      Only a `failed` claim, or a `sending` claim abandoned for longer
//      than STALE_CLAIM_MS (the process died mid-send), may be retried.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { parseCompassId, normalizeCompassPhone } from '@/lib/compass/contacts';
import {
  ChannelError,
  resolveSendChannel,
  type ConversationNumbers,
  type WhatsAppChannel,
} from '@/lib/whatsapp/channels';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message';

/** A `sending` claim older than this is presumed dead and may be retried. */
export const STALE_CLAIM_MS = 2 * 60_000;

export const NOTIFICATION_TYPES = ['text', 'image', 'document'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

const MAX_KEY_LENGTH = 200;
const MAX_LABEL_LENGTH = 200;
/** WhatsApp's text body limit. */
const MAX_TEXT_LENGTH = 4096;

export class NotifyError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'NotifyError';
    this.code = code;
    this.status = status;
  }
}

export interface NotificationRequest {
  idempotencyKey: string;
  compassId: string | null;
  /** Digits-only phone, when given explicitly. */
  to: string | null;
  type: NotificationType;
  text: string | null;
  mediaUrl: string | null;
  filename: string | null;
  event: string | null;
  reference: string | null;
  /** Names a contact created by this send (ignored for existing ones). */
  name: string | null;
}

function label(
  body: Record<string, unknown>,
  field: string,
  max = MAX_LABEL_LENGTH
): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new NotifyError('bad_request', `'${field}' must be a string`, 400);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new NotifyError(
      'bad_request',
      `'${field}' exceeds ${max} characters`,
      400
    );
  }
  return trimmed || null;
}

/** Validate a POST body. Pure; throws `NotifyError` (400) on bad input. */
export function parseNotificationRequest(input: unknown): NotificationRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new NotifyError(
      'bad_request',
      'Request body must be a JSON object',
      400
    );
  }
  const body = input as Record<string, unknown>;

  const idempotencyKey = label(body, 'idempotency_key', MAX_KEY_LENGTH);
  if (!idempotencyKey) {
    throw new NotifyError(
      'bad_request',
      '\'idempotency_key\' is required — use something unique to this status change, e.g. "APP-2291:approved"',
      400
    );
  }

  const compassId =
    body.compass_id === undefined || body.compass_id === null
      ? null
      : parseCompassId(body.compass_id);
  if (body.compass_id !== undefined && body.compass_id !== null && !compassId) {
    throw new NotifyError('bad_request', "'compass_id' is invalid", 400);
  }

  let to: string | null = null;
  if (body.to !== undefined && body.to !== null && body.to !== '') {
    const phone = normalizeCompassPhone(body.to);
    if (!phone.ok) {
      throw new NotifyError(
        'bad_request',
        phone.error.replace("'phone'", "'to'"),
        400
      );
    }
    to = phone.phone;
  }

  if (!to && !compassId) {
    throw new NotifyError(
      'bad_request',
      "Either 'to' (a phone number) or 'compass_id' is required",
      400
    );
  }

  const type = (body.type ?? 'text') as NotificationType;
  if (!(NOTIFICATION_TYPES as readonly string[]).includes(type)) {
    throw new NotifyError(
      'bad_request',
      `'type' must be one of: ${NOTIFICATION_TYPES.join(', ')}`,
      400
    );
  }

  const text = label(body, 'text', MAX_TEXT_LENGTH);
  const mediaUrl = label(body, 'media_url', 2048);
  if (mediaUrl && !/^https:\/\//i.test(mediaUrl)) {
    throw new NotifyError(
      'bad_request',
      "'media_url' must be an https:// URL",
      400
    );
  }

  // Same shape rules the send core enforces (text needs text, media
  // needs a URL, captions ≤ 1024), checked before anything is claimed.
  try {
    validateSendMessageParams({
      messageType: type,
      contentText: text,
      mediaUrl,
    });
  } catch (err) {
    if (err instanceof SendMessageError) {
      throw new NotifyError(
        'bad_request',
        err.message
          .replace('content_text', "'text'")
          .replace('media_url', "'media_url'"),
        400
      );
    }
    throw err;
  }

  return {
    idempotencyKey,
    compassId,
    to,
    type,
    text,
    mediaUrl,
    filename: label(body, 'filename'),
    event: label(body, 'event'),
    reference: label(body, 'reference'),
    name: label(body, 'name'),
  };
}

// ---------- the stored log row ----------

export const NOTIFICATION_SELECT = '*, message:messages(status, message_id)';

export interface ApiCompassNotification {
  id: string;
  idempotency_key: string;
  status: 'sending' | 'sent' | 'failed';
  /** WhatsApp delivery progress once sent: sent → delivered → read, or failed. */
  delivery_status: string | null;
  compass_id: string | null;
  event: string | null;
  reference: string | null;
  phone: string | null;
  text: string | null;
  message_id: string | null;
  whatsapp_message_id: string | null;
  conversation_id: string | null;
  contact_id: string | null;
  error: { code: string; message: string } | null;
  created_at: string;
  updated_at: string;
}

export function serializeNotification(
  row: Record<string, unknown>
): ApiCompassNotification {
  const message = row.message as {
    status?: string;
    message_id?: string;
  } | null;
  return {
    id: row.id as string,
    idempotency_key: row.idempotency_key as string,
    status: row.status as ApiCompassNotification['status'],
    delivery_status: message?.status ?? null,
    compass_id: (row.compass_id as string | null) ?? null,
    event: (row.event as string | null) ?? null,
    reference: (row.reference as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    text: (row.content_text as string | null) ?? null,
    message_id: (row.message_id as string | null) ?? null,
    whatsapp_message_id: message?.message_id ?? null,
    conversation_id: (row.conversation_id as string | null) ?? null,
    contact_id: (row.contact_id as string | null) ?? null,
    error: row.error_code
      ? {
          code: row.error_code as string,
          message: (row.error_message as string | null) ?? '',
        }
      : null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * May a stored claim be taken over by a retry? `sent` never; `failed`
 * always; `sending` only once it has been abandoned.
 */
export function isClaimRetryable(
  row: { status: string; updated_at: string },
  now = Date.now()
): boolean {
  if (row.status === 'failed') return true;
  if (row.status === 'sending') {
    return now - new Date(row.updated_at).getTime() > STALE_CLAIM_MS;
  }
  return false;
}

// ---------- orchestration ----------

export interface NotificationOutcome {
  notification: ApiCompassNotification;
  /** True when this key had already been sent; nothing was sent now. */
  duplicate: boolean;
  contactCreated: boolean;
  conversationCreated: boolean;
}

async function loadNotification(
  db: SupabaseClient,
  accountId: string,
  where: { id: string } | { idempotency_key: string }
): Promise<Record<string, unknown> | null> {
  let query = db
    .from('compass_notifications')
    .select(NOTIFICATION_SELECT)
    .eq('account_id', accountId);
  query =
    'id' in where
      ? query.eq('id', where.id)
      : query.eq('idempotency_key', where.idempotency_key);
  const { data } = await query.maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

export async function getNotificationByKey(
  db: SupabaseClient,
  accountId: string,
  idempotencyKey: string
): Promise<ApiCompassNotification | null> {
  const row = await loadNotification(db, accountId, {
    idempotency_key: idempotencyKey,
  });
  return row ? serializeNotification(row) : null;
}

/**
 * Claim the key. Returns the claimed row id, or the already-sent row
 * when this is a duplicate. Throws `in_progress` (409) while another
 * request holds a live claim.
 */
async function claim(
  db: SupabaseClient,
  accountId: string,
  req: NotificationRequest
): Promise<{ id: string } | { duplicateOf: Record<string, unknown> }> {
  const fields = {
    compass_id: req.compassId,
    event: req.event,
    reference: req.reference,
    phone: req.to,
    content_text: req.text,
    status: 'sending',
    error_code: null,
    error_message: null,
    updated_at: new Date().toISOString(),
  };

  const { data: inserted, error } = await db
    .from('compass_notifications')
    .insert({
      ...fields,
      account_id: accountId,
      idempotency_key: req.idempotencyKey,
    })
    .select('id')
    .single();

  if (inserted) return { id: inserted.id as string };
  if (!isUniqueViolation(error)) {
    throw new NotifyError('internal', 'Failed to record the notification', 500);
  }

  const existing = await loadNotification(db, accountId, {
    idempotency_key: req.idempotencyKey,
  });
  if (!existing) {
    throw new NotifyError('internal', 'Failed to record the notification', 500);
  }
  if (existing.status === 'sent') return { duplicateOf: existing };

  const retryable = isClaimRetryable(
    existing as { status: string; updated_at: string }
  );
  if (retryable) {
    // Compare-and-set on updated_at: of two retries racing for the same
    // failed/stale claim, exactly one matches the old timestamp.
    const { data: reclaimed } = await db
      .from('compass_notifications')
      .update(fields)
      .eq('id', existing.id as string)
      .eq('updated_at', existing.updated_at as string)
      .select('id');
    if (reclaimed && reclaimed.length > 0) {
      return { id: reclaimed[0].id as string };
    }
  }

  throw new NotifyError(
    'in_progress',
    'A notification with this idempotency_key is being sent right now — check its status with GET before retrying',
    409
  );
}

/**
 * The Whapi number this notification would go out on, or null when the
 * account has none. Read-only: nothing is created.
 *
 * It asks `resolveSendChannel` exactly what the send core will ask it
 * (surface 'api', provider 'whapi', the chat's own numbers), for the
 * chat this phone already has — found the way `resolveConversationByPhone`
 * finds it. So the answer is the chat's pin, else the Whapi number the
 * chat is on, else the default Whapi number (a new contact's chat has
 * neither). Checking the default number instead refused every
 * notification to a customer whose chat is on a healthy second number
 * while the default one was logged out.
 */
async function whapiNumberFor(
  db: SupabaseClient,
  accountId: string,
  phone: string
): Promise<WhatsAppChannel | null> {
  let conversationId: string | null = null;
  let numbers: ConversationNumbers | undefined;
  const contact = await findExistingContact(
    db,
    accountId,
    sanitizePhoneForMeta(`+${phone}`)
  );
  if (contact) {
    const { data } = await db
      .from('conversations')
      .select('id, channel_id, send_channel_id')
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .order('created_at', { ascending: true })
      .limit(1);
    const chat = (
      data as Array<{
        id: string;
        channel_id: string | null;
        send_channel_id: string | null;
      }> | null
    )?.[0];
    if (chat) {
      conversationId = chat.id;
      numbers = {
        channelId: chat.channel_id ?? null,
        sendChannelId: chat.send_channel_id ?? null,
      };
    }
  }

  let channel: WhatsAppChannel;
  try {
    channel = await resolveSendChannel(
      db,
      accountId,
      'api',
      conversationId,
      'whapi',
      null,
      numbers
    );
  } catch (err) {
    if (err instanceof ChannelError && err.code === 'whatsapp_not_configured') {
      return null;
    }
    throw err;
  }
  // No Whapi number at all: the resolver fell back to another kind,
  // which `requireProvider` would refuse at send time anyway.
  return channel.provider === 'whapi' ? channel : null;
}

/**
 * Send one status notification. Returns the stored row; throws
 * `NotifyError` / `SendMessageError` on failure, after recording the
 * failure against the key so a retry is allowed and the admin screen
 * shows why.
 */
export async function sendCompassNotification(
  db: SupabaseClient,
  accountId: string,
  req: NotificationRequest
): Promise<NotificationOutcome> {
  const claimed = await claim(db, accountId, req);
  if ('duplicateOf' in claimed) {
    return {
      notification: serializeNotification(claimed.duplicateOf),
      duplicate: true,
      contactCreated: false,
      conversationCreated: false,
    };
  }
  const notificationId = claimed.id;

  const record = async (fields: Record<string, unknown>) => {
    const { error } = await db
      .from('compass_notifications')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', notificationId);
    if (error) {
      console.error('[compass/notify] could not record outcome:', error);
    }
  };

  // Once the gateway has accepted the message, a later failure must
  // not free the key for a retry — that would be the double send the
  // key exists to prevent.
  let handedToGateway = false;
  try {
    let phone = req.to;
    let name = req.name;
    if (req.compassId) {
      const { data: customer } = await db
        .from('compass_contacts')
        .select('name, phone')
        .eq('account_id', accountId)
        .eq('compass_id', req.compassId)
        .maybeSingle();
      if (!customer) {
        throw new NotifyError(
          'compass_contact_not_found',
          `No synced Compass customer has compass_id "${req.compassId}". Sync it first, or pass 'to'.`,
          404
        );
      }
      name = name ?? (customer.name as string | null);
      if (!phone) {
        // The synced phone is re-checked: a row stored before the sync
        // enforced the CRM-wide rule (a 9-digit local number, say) would
        // otherwise be created as a contact and "sent" to a JID that is
        // nobody. `to` was checked when the request was parsed.
        const synced = normalizeCompassPhone(customer.phone);
        if (!synced.ok) {
          throw new NotifyError(
            'invalid_phone',
            `Compass customer "${req.compassId}" has a synced phone that is not a valid international number (${synced.error}). Re-sync it with the country code, or pass 'to'.`,
            422
          );
        }
        phone = synced.phone;
      }
    }
    if (!phone) {
      throw new NotifyError(
        'no_phone',
        `Compass customer "${req.compassId}" has no phone number on file. Sync one, or pass 'to'.`,
        422
      );
    }
    if (phone !== req.to) await record({ phone });

    // Checked before a contact or chat is created, so a missing channel
    // leaves nothing behind. The send core re-checks (requireProvider).
    const whapi = await whapiNumberFor(db, accountId, phone);
    if (!whapi) {
      throw new NotifyError(
        'whapi_not_connected',
        'No Whapi channel is connected. Status notifications are only sent on the Whapi number — connect it in Settings → WhatsApp.',
        409
      );
    }
    // A number the health monitor has marked down (its phone logged out
    // of WhatsApp) is the same case for Compass: nothing can be sent
    // until someone fixes it, and the key stays retryable. Before this,
    // each attempt failed at the gateway as a 502 and still left an
    // empty new chat in the inbox. It is the number this send would
    // use, so another Whapi number being down does not block it.
    if (whapi.status === 'disconnected') {
      throw new NotifyError(
        'whapi_not_connected',
        'The Whapi WhatsApp number is not connected to WhatsApp right now (its phone may have been logged out). Nothing was sent — retry later with the same idempotency_key.',
        409
      );
    }

    const resolved = await resolveConversationByPhone(
      db,
      accountId,
      `+${phone}`,
      name,
      { renameExisting: false }
    );

    handedToGateway = true;
    const sent = await sendMessageToConversation(db, accountId, {
      conversationId: resolved.conversationId,
      messageType: req.type,
      contentText: req.text,
      mediaUrl: req.mediaUrl,
      filename: req.filename,
      surface: 'api',
      provider: 'whapi',
      requireProvider: true,
      pauseActiveFlows: false,
    });

    await record({
      status: 'sent',
      message_id: sent.messageId,
      conversation_id: resolved.conversationId,
      contact_id: resolved.contactId,
    });

    if (req.compassId) {
      await db
        .from('compass_contacts')
        .update({ contact_id: resolved.contactId })
        .eq('account_id', accountId)
        .eq('compass_id', req.compassId);
    }

    const row = await loadNotification(db, accountId, { id: notificationId });
    return {
      notification: serializeNotification(
        row ?? {
          id: notificationId,
          idempotency_key: req.idempotencyKey,
          status: 'sent',
        }
      ),
      duplicate: false,
      contactCreated: resolved.contactCreated,
      conversationCreated: resolved.conversationCreated,
    };
  } catch (err) {
    const code =
      err instanceof NotifyError || err instanceof SendMessageError
        ? err.code
        : 'internal';
    const message =
      err instanceof NotifyError || err instanceof SendMessageError
        ? err.message
        : 'Internal error';
    // The send core throws `db_error` only AFTER the gateway accepted
    // the message (persisting it failed). The customer has it; keep
    // the key spent.
    const delivered =
      handedToGateway &&
      err instanceof SendMessageError &&
      err.code === 'db_error';
    await record({
      status: delivered ? 'sent' : 'failed',
      error_code: code,
      error_message: message,
    });
    throw err;
  }
}
