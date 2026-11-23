/**
 * OpenWA webhook payload → CRM inbound shape.
 *
 * OpenWA posts one event per request:
 * `{ event, timestamp (ISO), sessionId, idempotencyKey, deliveryId, data }`
 * (OpenWA v0.25.0 `docs/06-api-specification.md` §6.6). Only three
 * events reach the inbox: `message.received` becomes a message, and
 * `message.ack` / `message.failed` become a status. Group chats and
 * `group.*` events become group traffic (migration 114), kept apart
 * from the inbox. Everything else (`session.*`, reactions, edits,
 * revokes) normalises to an empty webhook, which the route answers 200.
 *
 * Pure and synchronous, like `whapi-webhook.ts`, whose filtering
 * decisions this mirrors.
 */

import { contactCardsText, parseVcard } from './contact-card';
import type {
  NormalizedInboundMessage,
  NormalizedMedia,
  NormalizedStatus,
  NormalizedStatusValue,
  NormalizedWebhook,
} from './inbound';
import { toOpenWAMediaId } from './openwa-api';
import { fromOpenWAParticipantId } from './openwa-groups';
import type { GroupInboundMessage } from '@/lib/groups/inbound';
import type {
  GroupParticipantAction,
  WhapiGroupEvent,
} from './whapi-group-events';

// ============================================================
// Raw shapes (only the fields read here)
// ============================================================

export interface RawOpenWAMedia {
  mimetype?: string;
  filename?: string;
  /** Inline base64. Never read: media is fetched from the gateway. */
  data?: string;
  omitted?: boolean;
  sizeBytes?: number;
}

export interface RawOpenWAMessage {
  id?: string;
  from?: string;
  to?: string;
  body?: string;
  type?: string;
  /** Epoch SECONDS. */
  timestamp?: number;
  isGroup?: boolean;
  kind?: string;
  fromMe?: boolean;
  chatId?: string;
  /** A group message's sender: `<phone>@c.us` or `<lid>@lid`. */
  author?: string;
  media?: RawOpenWAMedia;
  contact?: { name?: string; pushName?: string };
  /** MSISDN digits for an `@lid` sender (RESOLVE_LID_TO_PHONE), or null. */
  senderPhone?: string | null;
  quotedMessage?: { id?: string; body?: string };
  location?: {
    latitude?: number;
    longitude?: number;
    description?: string;
    address?: string;
  };
}

export interface RawOpenWAAck {
  id?: string;
  messageId?: string;
  status?: string;
  ack?: number;
  chatId?: string;
}

export interface RawOpenWAWebhookPayload {
  event?: string;
  timestamp?: string;
  sessionId?: string;
  idempotencyKey?: string;
  deliveryId?: string;
  data?: unknown;
}

export interface NormalizedOpenWAWebhook extends NormalizedWebhook {
  /**
   * Inbound messages dropped because the sender was a privacy id
   * (`@lid`) the gateway could not map to a phone number. Counted so the
   * route can log them: a lid's digits are not a phone number, and
   * filing one as a contact would mint a customer nobody can reach.
   */
  unmappedLidSenders: number;
  /**
   * `message.sent`: the number's own sends, typed on the phone or sent
   * by the CRM. Kept apart from `messages`: only a personal number files
   * them (own-send.ts), and never through the inbound pipeline.
   */
  ownSends: NormalizedOpenWAOwnSend[];
  /**
   * Group traffic (migration 114), for `lib/groups/inbound.ts`; never
   * the inbound pipeline. The route keeps it only on a company number.
   */
  groupMessages: GroupInboundMessage[];
  groupEvents: WhapiGroupEvent[];
  /**
   * The envelope's `idempotencyKey`: stable across redeliveries of one
   * event, so the route can replay-screen group events (which carry no
   * id of their own). Null when the gateway sent none.
   */
  envelopeKey: string | null;
}

export interface RawOpenWAGroupEvent {
  groupId?: string;
  participantIds?: unknown;
  timestamp?: number;
  actorId?: string;
  changes?: {
    subject?: string;
    description?: string;
    announce?: boolean;
    locked?: boolean;
  };
}

/** One own send. The peer is a phone, or an `@lid` the route resolves. */
export interface NormalizedOpenWAOwnSend {
  id: string;
  peerPhone: string | null;
  peerLid: string | null;
  text: string;
  /** Epoch seconds, as a string (like the inbound shape). */
  timestamp: string;
}

// ============================================================
// Helpers
// ============================================================

const digitsOf = (id: string) => id.split('@')[0].replace(/\D/g, '');

/**
 * `kind` is OpenWA's chat discriminator and always present on 0.25; the
 * suffix fallback keeps an older gateway's payload from being read as a
 * 1:1 chat when it is not one.
 */
function chatKind(raw: RawOpenWAMessage): string {
  if (typeof raw.kind === 'string') return raw.kind;
  const chatId = raw.chatId ?? raw.from ?? '';
  if (raw.isGroup) return 'group';
  return chatId.endsWith('@c.us') || chatId.endsWith('@lid')
    ? 'individual'
    : 'unknown';
}

/** Seconds as a string, which is what persistence parses. */
function secondsString(value: number | undefined): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return String(Math.trunc(value));
  }
  return String(Math.trunc(Date.now() / 1000));
}

function isoToSeconds(value: string | undefined): string {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms)
    ? String(Math.trunc(ms / 1000))
    : String(Math.trunc(Date.now() / 1000));
}

function nonEmpty(value: string | undefined | null): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The neutral handle for an attachment. Never the inline `data`: it is
 * absent above OpenWA's inline cap (`omitted: true`), so the pipeline
 * always resolves the bytes through `getMediaUrl` / `downloadMedia`,
 * which address the gateway's stored copy by (chat, message).
 */
function mediaOf(
  raw: RawOpenWAMessage,
  chatId: string,
  id: string
): NormalizedMedia {
  const size = Number(raw.media?.sizeBytes);
  return {
    id: toOpenWAMediaId(chatId, id),
    link: null,
    mimeType: raw.media?.mimetype ?? null,
    filename: raw.media?.filename ?? null,
    fileSize: Number.isFinite(size) && size >= 0 ? size : null,
  };
}

// ============================================================
// Message normalisation
// ============================================================

export type OpenWAMessageResult =
  | { message: NormalizedInboundMessage }
  | {
      message: null;
      reason:
        | 'invalid'
        | 'from_me'
        | 'not_individual'
        | 'unmapped_lid'
        | 'unsupported';
    };

/**
 * Map one `message.received` data object, or say why it was dropped.
 *
 *  * `fromMe` is dropped: the gateway echoes the number's own sends, and
 *    the CRM already wrote its row on send (the Whapi rule).
 *  * Any `kind` but `individual` is dropped: groups, status posts,
 *    channels and broadcasts have no single contact to file under.
 *  * An `@lid` sender is used only through `senderPhone`; without one
 *    the message is dropped, never guessed.
 *  * Types the CRM cannot show (poll, call, revoked, order, product,
 *    masked, unknown) are dropped rather than stored as blank bubbles.
 */
export function normalizeOpenWAMessage(
  raw: RawOpenWAMessage
): OpenWAMessageResult {
  if (!raw || typeof raw.id !== 'string' || !raw.id) {
    return { message: null, reason: 'invalid' };
  }
  if (raw.fromMe === true) return { message: null, reason: 'from_me' };
  if (chatKind(raw) !== 'individual') {
    return { message: null, reason: 'not_individual' };
  }

  const fromId = raw.from ?? raw.chatId ?? '';
  let from: string;
  if (fromId.endsWith('@lid')) {
    from = raw.senderPhone ? raw.senderPhone.replace(/\D/g, '') : '';
    if (!from) return { message: null, reason: 'unmapped_lid' };
  } else {
    from = digitsOf(fromId);
  }
  if (!from) return { message: null, reason: 'invalid' };

  const chatId = raw.chatId ?? fromId;
  const body = nonEmpty(raw.body);
  const base: Omit<NormalizedInboundMessage, 'type'> = {
    id: raw.id,
    from,
    chatId,
    fromName: nonEmpty(raw.contact?.pushName) ?? nonEmpty(raw.contact?.name),
    timestamp: secondsString(raw.timestamp),
    text: null,
    media: null,
    location: null,
    reaction: null,
    contacts: null,
    interactiveReplyId: null,
    interactiveReplyTitle: null,
    contextMessageId: nonEmpty(raw.quotedMessage?.id),
    // The webhook carries no forward marker.
    forwarded: false,
    fromMe: false,
    isGroup: false,
    // Meta's free-entry window has no linked-device equivalent.
    freeEntry: false,
  };

  switch (raw.type) {
    case 'text':
      return body
        ? { message: { ...base, type: 'text', text: body } }
        : { message: null, reason: 'unsupported' };

    // For a media message whatsapp-web.js puts the caption in `body`.
    case 'image':
    case 'video':
    case 'document':
      return {
        message: {
          ...base,
          type: raw.type,
          text: body,
          media: mediaOf(raw, chatId, raw.id),
        },
      };

    // Voice notes and music files both persist as audio, as on Whapi.
    case 'audio':
    case 'voice':
      return {
        message: {
          ...base,
          type: 'audio',
          media: mediaOf(raw, chatId, raw.id),
        },
      };

    case 'sticker':
      return {
        message: {
          ...base,
          type: 'sticker',
          media: mediaOf(raw, chatId, raw.id),
        },
      };

    case 'location': {
      const loc = raw.location;
      if (
        !loc ||
        typeof loc.latitude !== 'number' ||
        typeof loc.longitude !== 'number'
      ) {
        return { message: null, reason: 'unsupported' };
      }
      return {
        message: {
          ...base,
          type: 'location',
          location: {
            latitude: loc.latitude,
            longitude: loc.longitude,
            name: loc.description,
            address: loc.address,
          },
        },
      };
    }

    // whatsapp-web.js delivers a shared contact card as its vCard text
    // in `body`. Parsed once here, as the Whapi normaliser does.
    case 'contact': {
      const card = body ? parseVcard(body) : null;
      if (!card) return { message: null, reason: 'unsupported' };
      return {
        message: {
          ...base,
          type: 'contacts',
          text: contactCardsText([card]),
          contacts: [card],
        },
      };
    }

    default:
      return { message: null, reason: 'unsupported' };
  }
}

const OWN_SEND_PLACEHOLDER: Record<string, string> = {
  image: '[photo]',
  video: '[video]',
  audio: '[audio]',
  voice: '[voice note]',
  document: '[document]',
  sticker: '[sticker]',
};

/**
 * Map one `message.sent` data object, or null. Only the number's own
 * 1:1 sends; media is stored as a text placeholder plus its caption,
 * because the phone's copy of the bytes is not fetched.
 */
export function normalizeOpenWAOwnSend(
  raw: RawOpenWAMessage
): NormalizedOpenWAOwnSend | null {
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
  if (raw.fromMe !== true) return null;
  if (typeof raw.kind === 'string' && raw.kind !== 'individual') return null;
  if (raw.isGroup) return null;

  const peer = raw.to ?? raw.chatId ?? '';
  let peerPhone: string | null = null;
  let peerLid: string | null = null;
  if (peer.endsWith('@lid')) peerLid = peer;
  else if (peer.endsWith('@c.us')) peerPhone = digitsOf(peer) || null;
  if (!peerPhone && !peerLid) return null;

  const body = nonEmpty(raw.body);
  let text: string | null = null;
  const type = raw.type ?? '';
  if (type === 'text') {
    text = body;
  } else if (OWN_SEND_PLACEHOLDER[type]) {
    // A voice note has no caption; whatsapp-web.js may put noise there.
    const caption = type === 'voice' || type === 'audio' ? null : body;
    text = caption
      ? `${OWN_SEND_PLACEHOLDER[type]} ${caption}`
      : OWN_SEND_PLACEHOLDER[type];
  } else if (type === 'location') {
    text = '[location]';
  } else if (type === 'contact') {
    const card = body ? parseVcard(body) : null;
    text = card ? contactCardsText([card]) : null;
  }
  if (!text) return null;

  return {
    id: raw.id,
    peerPhone,
    peerLid,
    text,
    timestamp: secondsString(raw.timestamp),
  };
}

// ============================================================
// Group normalisation (migration 114)
// ============================================================

const GROUP_CHAT = /@g\.us$/;
/** 114's CHECK on participant and sender wa ids. */
const GROUP_WA_ID = /^[0-9]{5,25}(@lid)?$/;

/**
 * A group sender as 114 stores it: phone digits, else `<digits>@lid`.
 * A lid sender with a `senderPhone` is filed under the phone, which is
 * how the group's participant rows are keyed.
 */
function groupSenderOf(raw: RawOpenWAMessage): string | null {
  const author = raw.author ?? '';
  let id: string | null = null;
  if (author.endsWith('@lid')) {
    const phone = raw.senderPhone ? raw.senderPhone.replace(/\D/g, '') : '';
    id = phone || `${digitsOf(author)}@lid`;
  } else if (author) {
    id = digitsOf(author);
  }
  return id && GROUP_WA_ID.test(id) ? id : null;
}

const GROUP_TYPES: Record<string, string> = {
  text: 'text',
  image: 'image',
  video: 'video',
  document: 'document',
  audio: 'audio',
  voice: 'audio',
  sticker: 'sticker',
  location: 'location',
  contact: 'contacts',
};

/**
 * Map one `message.received` / `message.sent` data object of a group
 * chat, or null. The gateway's copy of an attachment has no
 * browser-loadable link, so a file's `media` carries its handle with
 * `link` null; `lib/groups/inbound-media.ts` copies the bytes after the
 * row is stored and fills the link.
 */
export function normalizeOpenWAGroupMessage(
  raw: RawOpenWAMessage
): GroupInboundMessage | null {
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
  if (chatKind(raw) !== 'group') return null;
  const chatId = raw.chatId ?? (raw.fromMe === true ? raw.to : raw.from) ?? '';
  if (!GROUP_CHAT.test(chatId)) return null;
  const type = GROUP_TYPES[raw.type ?? ''];
  if (!type) return null;

  let body = nonEmpty(raw.body);
  let media: Record<string, unknown> | null = null;
  if (type === 'location') {
    const loc = raw.location;
    if (
      !loc ||
      typeof loc.latitude !== 'number' ||
      typeof loc.longitude !== 'number'
    ) {
      return null;
    }
    media = {
      location: {
        latitude: loc.latitude,
        longitude: loc.longitude,
        name: loc.description,
        address: loc.address,
      },
    };
    body = nonEmpty(loc.description);
  } else if (type === 'contacts') {
    const card = body ? parseVcard(body) : null;
    if (!card) return null;
    body = contactCardsText([card]);
    media = { contacts: [card] };
  } else if (type === 'text') {
    if (!body) return null;
  } else {
    if (type === 'audio') body = null;
    const file = mediaOf(raw, chatId, raw.id);
    media = {
      id: file.id,
      link: file.link,
      mime_type: file.mimeType,
      filename: file.filename,
      file_size: file.fileSize,
    };
  }

  return {
    id: raw.id,
    waGroupId: chatId,
    fromMe: raw.fromMe === true,
    senderWaId: groupSenderOf(raw),
    senderName: nonEmpty(raw.contact?.pushName) ?? nonEmpty(raw.contact?.name),
    type,
    body,
    media,
    sentAt: new Date(Number(secondsString(raw.timestamp)) * 1000).toISOString(),
  };
}

const GROUP_EVENT_ACTIONS: Record<string, GroupParticipantAction> = {
  'group.join': 'add',
  'group.leave': 'remove',
  'group.join_request': 'request',
};

/**
 * Map one `group.*` event, or null. OpenWA has no promote/demote event.
 * A participant with no phone (`@lid`) is counted, not listed, as in
 * the Whapi parser.
 */
export function normalizeOpenWAGroupEvent(
  event: string,
  raw: RawOpenWAGroupEvent
): WhapiGroupEvent | null {
  const groupId = raw?.groupId;
  if (typeof groupId !== 'string' || !GROUP_CHAT.test(groupId)) return null;

  if (event === 'group.update') {
    const c = raw.changes;
    if (!c || typeof c !== 'object') return null;
    const changes: Extract<
      WhapiGroupEvent,
      { kind: 'group_update' }
    >['changes'] = {};
    if (typeof c.subject === 'string') changes.name = c.subject;
    if (typeof c.description === 'string') {
      changes.description = c.description || null;
    }
    const settings: NonNullable<typeof changes.settings> = {};
    if (typeof c.announce === 'boolean') {
      settings.send_messages = c.announce ? 'admins' : 'anyone';
    }
    if (typeof c.locked === 'boolean') {
      settings.edit_group_info = c.locked ? 'admins' : 'anyone';
    }
    if (Object.keys(settings).length > 0) changes.settings = settings;
    if (Object.keys(changes).length === 0) return null;
    return { kind: 'group_update', groupId, changes };
  }

  const action = GROUP_EVENT_ACTIONS[event];
  if (!action || !Array.isArray(raw.participantIds)) return null;
  const waIds: string[] = [];
  let unresolved = 0;
  for (const p of raw.participantIds) {
    // The same mapping Sync stores participants under (digits, or
    // `<digits>@lid`), so a leave finds the row Sync wrote.
    const id =
      typeof p === 'string' ? (fromOpenWAParticipantId(p).waId ?? '') : '';
    if (id && GROUP_WA_ID.test(id)) waIds.push(id);
    else unresolved++;
  }
  if (waIds.length === 0 && unresolved === 0) return null;
  return {
    kind: 'participants',
    groupId,
    action,
    waIds: [...new Set(waIds)],
    unresolved,
    performedBy: null,
  };
}

// ============================================================
// Status normalisation
// ============================================================

/**
 * OpenWA's `status` is already the neutral ladder. `pending` passes
 * through as Whapi's does: the forward-only check in
 * `handleStatusUpdate` never lets it move a row backwards.
 */
const STATUS_MAP: Record<string, NormalizedStatusValue> = {
  pending: 'pending',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

export function normalizeOpenWAAck(
  raw: RawOpenWAAck,
  dispatchedAt: string | undefined
): NormalizedStatus | null {
  const messageId = nonEmpty(raw?.messageId) ?? nonEmpty(raw?.id);
  const status =
    typeof raw?.status === 'string'
      ? STATUS_MAP[raw.status.toLowerCase()]
      : undefined;
  if (!messageId || !status) return null;
  const chatId = raw.chatId ?? '';
  return {
    messageId,
    status,
    // A lid's digits are not a phone number, so none is reported.
    recipientPhone: chatId.endsWith('@c.us') ? digitsOf(chatId) : '',
    // An ack carries no time of its own; the dispatch time is the
    // nearest the gateway gives.
    timestamp: isoToSeconds(dispatchedAt),
  };
}

// ============================================================
// Entry point
// ============================================================

export function normalizeOpenWAWebhook(
  payload: RawOpenWAWebhookPayload
): NormalizedOpenWAWebhook {
  const out: NormalizedOpenWAWebhook = {
    channelId:
      typeof payload?.sessionId === 'string' ? payload.sessionId : null,
    eventType: typeof payload?.event === 'string' ? payload.event : null,
    eventMethod: null,
    messages: [],
    statuses: [],
    unmappedLidSenders: 0,
    ownSends: [],
    groupMessages: [],
    groupEvents: [],
    envelopeKey:
      typeof payload?.idempotencyKey === 'string' && payload.idempotencyKey
        ? payload.idempotencyKey
        : null,
  };
  const data = payload?.data;
  if (!data || typeof data !== 'object') return out;

  switch (out.eventType) {
    case 'message.received': {
      const result = normalizeOpenWAMessage(data as RawOpenWAMessage);
      if (result.message) out.messages.push(result.message);
      else if (result.reason === 'unmapped_lid') out.unmappedLidSenders++;
      else if (
        result.reason === 'not_individual' ||
        result.reason === 'from_me'
      ) {
        const group = normalizeOpenWAGroupMessage(data as RawOpenWAMessage);
        if (group) out.groupMessages.push(group);
      }
      break;
    }
    case 'message.sent': {
      const own = normalizeOpenWAOwnSend(data as RawOpenWAMessage);
      if (own) out.ownSends.push(own);
      else {
        // A send into a group: recorded as ours (deduped on its id).
        const group = normalizeOpenWAGroupMessage(data as RawOpenWAMessage);
        if (group?.fromMe) out.groupMessages.push(group);
      }
      break;
    }
    case 'group.join':
    case 'group.leave':
    case 'group.join_request':
    case 'group.update': {
      const group = normalizeOpenWAGroupEvent(
        out.eventType,
        data as RawOpenWAGroupEvent
      );
      if (group) out.groupEvents.push(group);
      break;
    }
    // `message.failed` is sent in addition to the `message.ack` with
    // status `failed`; both normalise to the same status, and the
    // forward-only write makes the second a no-op.
    case 'message.ack':
    case 'message.failed': {
      const status = normalizeOpenWAAck(
        data as RawOpenWAAck,
        payload.timestamp
      );
      if (status) out.statuses.push(status);
      break;
    }
  }
  return out;
}
