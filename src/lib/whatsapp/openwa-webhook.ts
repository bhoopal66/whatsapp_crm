/**
 * OpenWA webhook payload → CRM inbound shape.
 *
 * OpenWA posts one event per request:
 * `{ event, timestamp (ISO), sessionId, idempotencyKey, deliveryId, data }`
 * (OpenWA v0.25.0 `docs/06-api-specification.md` §6.6). Only three
 * events reach the inbox: `message.received` becomes a message, and
 * `message.ack` / `message.failed` become a status. Everything else
 * (`session.*`, groups, reactions, edits, revokes) normalises to an
 * empty webhook, which the route answers 200.
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
  };
  const data = payload?.data;
  if (!data || typeof data !== 'object') return out;

  switch (out.eventType) {
    case 'message.received': {
      const result = normalizeOpenWAMessage(data as RawOpenWAMessage);
      if (result.message) out.messages.push(result.message);
      else if (result.reason === 'unmapped_lid') out.unmappedLidSenders++;
      break;
    }
    case 'message.sent': {
      const own = normalizeOpenWAOwnSend(data as RawOpenWAMessage);
      if (own) out.ownSends.push(own);
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
