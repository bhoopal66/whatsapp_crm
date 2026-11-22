// ============================================================
// Taamul Compass — status notifications (migration 056).
//
// Compass tells a customer that something happened to their bank
// account application ("documents received", "approved", ...). Three
// rules shape this, each a requirement rather than a preference:
//
//   1. ALWAYS the Meta Cloud API number. These used to go on a
//      linked-device number (Whapi / OpenWA), and the volume of
//      unsolicited updates got those numbers restricted. Meta allows
//      free text only within 24 hours of the customer's last message
//      to the number; outside that window the update goes as the
//      Meta-approved template worded like it (submitted / approved,
//      `meta-template.ts`), with the company and bank read out of
//      Compass's text. A message no template matches, or an image or
//      document, cannot go outside the window
//      (`no_template_for_message`, `outside_service_window`). If the
//      Meta number is not connected the send FAILS
//      (`meta_not_connected`) instead of falling back to a
//      linked-device number.
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
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import {
  compassTemplateFor,
  compassTemplateProblem,
  serviceWindowOpen,
  type CompassTemplateProblem,
} from '@/lib/compass/meta-template';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message';
import {
  SubmissionGroupSentNotRecordedError,
  type SystemSendResult,
} from '@/lib/submission-groups/service';

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
  /** Where it went: the customer's 1:1 chat, or their submission group (170). */
  delivered_to: 'customer' | 'group' | null;
  submission_group_id: string | null;
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
    delivered_to: row.submission_group_id
      ? 'group'
      : row.message_id
        ? 'customer'
        : null,
    submission_group_id: (row.submission_group_id as string | null) ?? null,
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
 * The Meta number this notification would go out on, and the chat this
 * phone already has, or null when the account has no Meta number.
 * Read-only: nothing is created.
 *
 * It asks `resolveSendChannel` exactly what the send core will ask it
 * (surface 'api', provider 'meta', the chat's own numbers), for the
 * chat this phone already has — found the way `resolveConversationByPhone`
 * finds it. A provider pin outranks a chat pinned to a linked-device
 * number, so the answer is the account's one Meta number.
 */
async function metaNumberFor(
  db: SupabaseClient,
  accountId: string,
  phone: string
): Promise<{ channel: WhatsAppChannel; conversationId: string | null } | null> {
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
      .is('personal_owner_id', null)
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
      'meta',
      null,
      numbers
    );
  } catch (err) {
    if (err instanceof ChannelError && err.code === 'whatsapp_not_configured') {
      return null;
    }
    throw err;
  }
  // No Meta number at all: the resolver fell back to another kind,
  // which `requireProvider` would refuse at send time anyway.
  return channel.provider === 'meta' ? { channel, conversationId } : null;
}

/**
 * Is the customer's 24-hour window on this Meta number open? It is when
 * they wrote to that number less than `SERVICE_WINDOW_MS` ago. A read
 * error counts as closed: the template is accepted inside the window
 * too, so that is the send that cannot be refused for timing.
 */
async function metaWindowOpen(
  db: SupabaseClient,
  conversationId: string | null,
  channelId: string
): Promise<boolean> {
  if (!conversationId) return false;
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

const TEMPLATE_PROBLEMS: Record<CompassTemplateProblem, string> = {
  missing: 'is not on this account',
  not_approved: 'is not approved by Meta yet',
  changed: 'was edited and no longer matches the Compass message',
};

/**
 * The template an update goes as outside the 24-hour window: the one
 * worded like this message, with the company and bank read out of it,
 * checked against the local row as it is now. Throws a `NotifyError`
 * (nothing sent, key retryable) when no template matches the message
 * or its row cannot be used.
 */
async function compassTemplateSend(
  db: SupabaseClient,
  accountId: string,
  event: string | null,
  text: string
): Promise<{ name: string; language: string; params: string[] }> {
  const hit = compassTemplateFor(event, text);
  if (!hit) {
    throw new NotifyError(
      'no_template_for_message',
      "The customer hasn't written to the Meta number in the last 24 hours, so WhatsApp only allows an approved template, and this message matches none (only the submitted and approved messages have one, word for word). Nothing was sent.",
      409
    );
  }
  const { name, language } = hit.template;
  const resolved = await resolveTemplateRow(db, accountId, name, language);
  const problem = compassTemplateProblem(
    hit.template,
    resolved.malformed ? null : resolved.row
  );
  if (problem) {
    throw new NotifyError(
      'meta_template_unusable',
      `The WhatsApp template "${name}" ${TEMPLATE_PROBLEMS[problem]}. Nothing was sent — retry later with the same idempotency_key.`,
      409
    );
  }
  return {
    name,
    language: resolved.language,
    // Meta refuses a variable with a line break or a run of spaces.
    params: hit.params.map((p) => p.replace(/\s+/g, ' ')),
  };
}

// ---------- the submission group (170) ----------

/** Posts a status update into a submission group (SubmissionGroupService.sendSystem). */
export type CompassGroupSender = (input: {
  groupId: string;
  kind: 'status_update';
  key: string;
  text: string;
}) => Promise<SystemSendResult>;

export interface NotifyDeps {
  /** Absent: never routed to a group (every notification goes 1:1). */
  groupSender?: CompassGroupSender;
}

const MAX_SYSTEM_KEY_LENGTH = 240;
/**
 * Group attempts per idempotency key. A failed attempt spends its system
 * key (170's unique index), so a retry posts under `<key>#2`, `<key>#3`;
 * after that the update is reported failed rather than sent 1:1.
 */
const MAX_GROUP_ATTEMPTS = 3;

interface GroupCandidate {
  id: string;
  contact_id: string | null;
}

const lookupFailed = () =>
  new NotifyError(
    'group_lookup_failed',
    "The customer's submission group could not be looked up. Nothing was sent — retry later with the same idempotency_key.",
    503
  );

/**
 * The group a text update goes into. The group whose submission_ref is the
 * request's `reference` (Compass sends the submission id there) is the
 * ONLY candidate when it exists, even if it cannot take the update: a
 * refusal there goes 1:1, never into another case's group. Only when the
 * reference names no group is the customer's newest group with a live
 * WhatsApp group used. ACTIVE and ENDED both qualify: sendSystem decides,
 * and allows a status update during 170's hold after a final-status end.
 * A read error throws (retryable) rather than sending 1:1 past a group.
 */
async function groupCandidate(
  db: SupabaseClient,
  accountId: string,
  reference: string | null,
  phone: string
): Promise<GroupCandidate | null> {
  if (reference) {
    const { data, error } = await db
      .from('submission_groups')
      .select('id, contact_id')
      .eq('account_id', accountId)
      .eq('submission_ref', reference)
      .maybeSingle();
    if (error) throw lookupFailed();
    if (data) return data as GroupCandidate;
  }
  const contact = await findExistingContact(
    db,
    accountId,
    sanitizePhoneForMeta(`+${phone}`)
  );
  if (!contact) return null;
  const { data, error } = await db
    .from('submission_groups')
    .select('id, contact_id')
    .eq('account_id', accountId)
    .eq('contact_id', contact.id)
    .eq('wa_mode', 'group')
    .in('status', ['ACTIVE', 'ENDED'])
    .not('wa_group_id', 'is', null)
    .is('wa_closed_at', null)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw lookupFailed();
  return (data as GroupCandidate[] | null)?.[0] ?? null;
}

/**
 * Posts the update into the group. Returns where it went, or null when it
 * should go 1:1 instead: the group refused it (no WhatsApp group, closed,
 * past the hold) and no earlier attempt under this key reached the
 * gateway. Throws otherwise, never falling back to 1:1 once a group
 * attempt may have been delivered: a consent block (422, the customer
 * opted out, on this try or an earlier one), a send in flight (409), a
 * failed send (502, retried under the next attempt key), or the attempts
 * used up.
 */
async function sendToGroup(
  send: CompassGroupSender,
  group: GroupCandidate,
  baseKey: string,
  text: string
): Promise<{
  groupId: string;
  contactId: string | null;
  messageId: string | null;
} | null> {
  const delivered = (messageId: string | null) => ({
    groupId: group.id,
    contactId: group.contact_id,
    messageId,
  });
  const optedOut = () =>
    new NotifyError(
      'customer_opted_out',
      'The customer has opted out of WhatsApp messages. Nothing was sent.',
      422
    );
  const failed = (message: string) =>
    new NotifyError('group_send_failed', message, 502);
  const base = baseKey.slice(0, MAX_SYSTEM_KEY_LENGTH - 2);
  for (let attempt = 1; attempt <= MAX_GROUP_ATTEMPTS; attempt++) {
    const key = attempt === 1 ? base : `${base}#${attempt}`;
    let result: SystemSendResult;
    try {
      result = await send({
        groupId: group.id,
        kind: 'status_update',
        key,
        text,
      });
    } catch (err) {
      if (err instanceof SubmissionGroupSentNotRecordedError) {
        return delivered(err.messageId);
      }
      console.error('[compass/notify] group send failed:', err);
      throw failed(
        "The update could not be sent into the customer's submission group. Retry later with the same idempotency_key."
      );
    }
    switch (result.status) {
      case 'sent':
        return delivered(result.messageId);
      case 'blocked':
        throw optedOut();
      case 'refused':
        // A first attempt the group refused never reached WhatsApp: 1:1 is
        // safe. After a failed attempt it may have, so report instead.
        if (attempt === 1) return null;
        throw failed(
          "An earlier attempt to post this update into the customer's submission group failed, and the group can no longer take it. Nothing more was sent, to avoid a double message."
        );
      case 'duplicate':
        if (result.sendStatus === 'sent' || result.sendStatus === null) {
          return delivered(result.messageId);
        }
        if (result.sendStatus === 'pending') {
          throw new NotifyError(
            'in_progress',
            'This update is being sent into the submission group right now — check its status with GET before retrying',
            409
          );
        }
        if (result.sendStatus === 'blocked') throw optedOut();
        continue; // failed: try the next attempt key
    }
  }
  throw failed(
    `Posting this update into the customer's submission group failed ${MAX_GROUP_ATTEMPTS} times. Nothing more will be sent for this idempotency_key.`
  );
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
  req: NotificationRequest,
  deps: NotifyDeps = {}
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

    // 170: a text update goes ONLY into the customer's submission group
    // when there is a live one; it is sent from the group's own number,
    // so this runs before the Meta number check. Media stays 1:1 (the
    // group send is text-only).
    if (deps.groupSender && req.type === 'text' && req.text) {
      const group = await groupCandidate(db, accountId, req.reference, phone);
      const inGroup = group
        ? await sendToGroup(
            deps.groupSender,
            group,
            `compass:${req.idempotencyKey}`,
            req.text
          )
        : null;
      if (inGroup) {
        await record({
          status: 'sent',
          submission_group_id: inGroup.groupId,
          group_message_id: inGroup.messageId,
          contact_id: inGroup.contactId,
          message_id: null,
          conversation_id: null,
        });
        if (req.compassId && inGroup.contactId) {
          await db
            .from('compass_contacts')
            .update({ contact_id: inGroup.contactId })
            .eq('account_id', accountId)
            .eq('compass_id', req.compassId);
        }
        const row = await loadNotification(db, accountId, {
          id: notificationId,
        });
        return {
          notification: serializeNotification(
            row ?? {
              id: notificationId,
              idempotency_key: req.idempotencyKey,
              status: 'sent',
              submission_group_id: inGroup.groupId,
            }
          ),
          duplicate: false,
          contactCreated: false,
          conversationCreated: false,
        };
      }
    }

    // Checked before a contact or chat is created, so a missing channel
    // leaves nothing behind. The send core re-checks (requireProvider).
    const meta = await metaNumberFor(db, accountId, phone);
    if (!meta) {
      throw new NotifyError(
        'meta_not_connected',
        'No Meta WhatsApp Cloud API number is connected. Status notifications are only sent on the Meta number — connect it in Settings → WhatsApp. Nothing was sent.',
        409
      );
    }
    if (meta.channel.status === 'disconnected') {
      throw new NotifyError(
        'meta_not_connected',
        'The Meta WhatsApp number is marked disconnected. Nothing was sent — retry later with the same idempotency_key.',
        409
      );
    }

    // Free text inside the customer's 24-hour window; outside it, the
    // approved template worded like the message, and media cannot go. Decided
    // before the chat is created, so a refusal leaves nothing behind.
    const windowOpen = await metaWindowOpen(
      db,
      meta.conversationId,
      meta.channel.id
    );
    let template: { name: string; language: string; params: string[] } | null =
      null;
    if (!windowOpen) {
      if (req.type !== 'text' || !req.text) {
        throw new NotifyError(
          'outside_service_window',
          "The customer hasn't written to the Meta number in the last 24 hours, so WhatsApp only allows a template, and an image or document cannot be sent that way. Nothing was sent.",
          409
        );
      }
      template = await compassTemplateSend(db, accountId, req.event, req.text);
    }

    const resolved = await resolveConversationByPhone(
      db,
      accountId,
      `+${phone}`,
      name,
      {
        renameExisting: false,
        leadSource: 'compass',
        leadSourceDetail: { via: 'compass_notify' },
      }
    );

    handedToGateway = true;
    const sent = await sendMessageToConversation(db, accountId, {
      conversationId: resolved.conversationId,
      ...(template
        ? {
            messageType: 'template',
            templateName: template.name,
            templateLanguage: template.language,
            templateParams: template.params,
          }
        : {
            messageType: req.type,
            contentText: req.text,
            mediaUrl: req.mediaUrl,
            filename: req.filename,
          }),
      surface: 'api',
      provider: 'meta',
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
