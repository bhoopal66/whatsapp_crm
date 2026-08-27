/**
 * Whapi webhook payload → CRM inbound shape.
 *
 * Whapi and Meta describe the same events with very different
 * envelopes. Meta nests everything under
 * `entry[].changes[].value.{messages,statuses,contacts,metadata}`;
 * Whapi posts a flat `{ messages[], statuses[], event, channel_id }`.
 *
 * Rather than teach the whole inbound pipeline (contact dedup,
 * conversation resolution, Flows, automations, AI auto-reply, public
 * webhook fan-out) a second dialect, this module normalises Whapi into
 * one neutral shape that the webhook route consumes. All the CRM logic
 * downstream stays provider-agnostic.
 *
 * Everything here is pure and synchronous — no network, no database —
 * so the mapping is cheap to unit-test against captured payloads.
 */

import { chatIdToPhone } from './whapi-api'

// ============================================================
// Normalised shapes
// ============================================================

/**
 * CRM-side content types. Deliberately the set allowed by the
 * `messages.content_type` CHECK constraint plus `reaction`, which the
 * route handles separately and never persists as a message row.
 */
export type NormalizedMessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'location'
  | 'interactive'
  | 'contacts'
  | 'reaction'
  | 'unsupported'

export interface NormalizedMedia {
  /** Whapi media id — the fallback handle when `link` is absent. */
  id: string | null
  mimeType: string | null
  /**
   * Direct download URL. Present when the channel has auto-download
   * enabled (which `registerWebhook` turns on). Null otherwise, in
   * which case the caller must resolve `id` via `getMediaUrl`.
   */
  link: string | null
  filename: string | null
  fileSize: number | null
}

export interface NormalizedInboundMessage {
  /** WhatsApp message id — the idempotency key for replayed deliveries. */
  id: string
  /** Sender, digits only (no `+`). */
  from: string
  /** Full chat id, e.g. `919984351847@s.whatsapp.net`. */
  chatId: string
  /** Sender's WhatsApp display name, when the payload carries one. */
  fromName: string | null
  /** Unix seconds as a string — matches what the persistence layer expects. */
  timestamp: string
  type: NormalizedMessageType
  /** Body text, or a media caption. Null when the message carries none. */
  text: string | null
  media: NormalizedMedia | null
  location: {
    latitude: number
    longitude: number
    name?: string
    address?: string
  } | null
  /** Set only for `type === 'reaction'`. */
  reaction: { targetMessageId: string; emoji: string } | null
  /** Button/list tap: the id we set when sending. Drives Flow advancement. */
  interactiveReplyId: string | null
  /** Button/list tap: the visible label the customer saw. */
  interactiveReplyTitle: string | null
  /** Message this one quotes (swipe-reply), if any. */
  contextMessageId: string | null
  /** True for messages sent BY the connected number (from the phone, another tool, or us). */
  fromMe: boolean
  /** True when the chat is a group — the CRM's 1:1 inbox skips these. */
  isGroup: boolean
}

/** Status values the `messages.status` CHECK constraint accepts. */
export type NormalizedStatusValue =
  | 'pending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'

export interface NormalizedStatus {
  messageId: string
  status: NormalizedStatusValue
  /** Recipient, digits only. */
  recipientPhone: string
  /** Unix seconds as a string. */
  timestamp: string
}

export interface NormalizedWhapiWebhook {
  /** Whapi channel that produced the event — the tenancy routing key. */
  channelId: string | null
  eventType: string | null
  eventMethod: string | null
  messages: NormalizedInboundMessage[]
  statuses: NormalizedStatus[]
}

// ============================================================
// Raw Whapi shapes (only the fields we read)
// ============================================================

interface RawWhapiMedia {
  id?: string
  mime_type?: string
  link?: string
  caption?: string
  file_name?: string
  filename?: string
  file_size?: number | string
  seconds?: number
}

interface RawWhapiMessage {
  id?: string
  from_me?: boolean
  type?: string
  chat_id?: string
  chat_name?: string
  timestamp?: number | string
  source?: string
  from?: string
  from_name?: string

  text?: { body?: string }
  link_preview?: { body?: string; url?: string }

  image?: RawWhapiMedia
  video?: RawWhapiMedia
  gif?: RawWhapiMedia
  short?: RawWhapiMedia
  audio?: RawWhapiMedia
  voice?: RawWhapiMedia
  document?: RawWhapiMedia
  sticker?: RawWhapiMedia

  location?: {
    latitude?: number
    longitude?: number
    name?: string
    address?: string
  }
  live_location?: { latitude?: number; longitude?: number; name?: string }

  contact?: { name?: string; vcard?: string }
  contact_list?: { list?: Array<{ name?: string; vcard?: string }> }

  /** Reactions, message deletions, edits — discriminated by `action.type`. */
  action?: {
    type?: string
    /** The message the action applies to (a reaction's target). */
    target?: string
    emoji?: string
    /** Set on group-membership and media-notify actions. */
    participant?: string
  }

  /** Button / list tap. */
  reply?: {
    type?: string
    buttons_reply?: { id?: string; title?: string }
    list_reply?: { id?: string; title?: string; description?: string }
  }

  /** Quoted (swipe-reply) parent. */
  context?: { quoted_id?: string; quoted_author?: string }
}

interface RawWhapiStatus {
  id?: string
  code?: number
  status?: string
  recipient_id?: string
  timestamp?: number | string
}

export interface RawWhapiWebhookPayload {
  messages?: RawWhapiMessage[]
  statuses?: RawWhapiStatus[]
  event?: { type?: string; event?: string }
  channel_id?: string
}

// ============================================================
// Helpers
// ============================================================

/** WhatsApp group chats end in `@g.us`; broadcast lists in `@broadcast`. */
function isGroupChat(chatId: string): boolean {
  return chatId.endsWith('@g.us') || chatId.endsWith('@broadcast')
}

/**
 * Whapi sends timestamps as unix *seconds*, sometimes as a number and
 * sometimes as a string. Downstream persistence does
 * `new Date(parseInt(ts) * 1000)`, so normalise to a seconds string.
 */
function normalizeTimestamp(value: number | string | undefined): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value))
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  return String(Math.trunc(Date.now() / 1000))
}

function toFileSize(value: number | string | undefined): number | null {
  const size = Number(value)
  return Number.isFinite(size) && size >= 0 ? size : null
}

function normalizeMedia(raw: RawWhapiMedia | undefined): NormalizedMedia | null {
  if (!raw) return null
  return {
    id: raw.id ?? null,
    mimeType: raw.mime_type ?? null,
    link: raw.link ?? null,
    filename: raw.file_name ?? raw.filename ?? null,
    fileSize: toFileSize(raw.file_size),
  }
}

/**
 * WhatsApp echoes a quick-reply id back prefixed with its internal
 * button-format marker — the id `p1` comes back as `ButtonsV3:p1`.
 * Flows match on the id they authored, so strip any `Word:` prefix.
 *
 * Only a known marker is stripped: a colon is legal inside a
 * caller-authored id (`order:1234`), and blindly cutting at the first
 * colon would silently break those.
 */
const BUTTON_ID_PREFIX = /^(?:Buttons?V\d+|ListV\d+|InteractiveV\d+|Template(?:Buttons)?V?\d*):/

export function normalizeButtonReplyId(id: string | undefined | null): string | null {
  if (!id) return null
  return id.replace(BUTTON_ID_PREFIX, '')
}

// ============================================================
// Message normalisation
// ============================================================

/**
 * Map one raw Whapi message onto the CRM shape, or null when it is
 * something the CRM has no representation for (a message edit, a group
 * membership change, a poll update).
 */
export function normalizeWhapiMessage(
  raw: RawWhapiMessage,
): NormalizedInboundMessage | null {
  if (!raw?.id) return null

  const chatId = raw.chat_id ?? ''
  const from = raw.from ? chatIdToPhone(raw.from) : chatIdToPhone(chatId)

  const base = {
    id: raw.id,
    from,
    chatId,
    fromName: raw.from_name ?? raw.chat_name ?? null,
    timestamp: normalizeTimestamp(raw.timestamp),
    text: null as string | null,
    media: null as NormalizedMedia | null,
    location: null as NormalizedInboundMessage['location'],
    reaction: null as NormalizedInboundMessage['reaction'],
    interactiveReplyId: null as string | null,
    interactiveReplyTitle: null as string | null,
    contextMessageId: raw.context?.quoted_id ?? null,
    fromMe: raw.from_me === true,
    isGroup: isGroupChat(chatId),
  }

  switch (raw.type) {
    case 'text':
      return { ...base, type: 'text', text: raw.text?.body ?? null }

    // A link preview is a text message WhatsApp decorated with OG
    // metadata. The CRM stores the text; the preview card is WhatsApp's
    // own rendering and isn't ours to reproduce.
    case 'link_preview':
      return { ...base, type: 'text', text: raw.link_preview?.body ?? null }

    case 'image':
      return {
        ...base,
        type: 'image',
        text: raw.image?.caption ?? null,
        media: normalizeMedia(raw.image),
      }

    // `gif` and `short` (PTV / round video) are video files as far as
    // storage and the inbox player are concerned.
    case 'video':
    case 'gif':
    case 'short': {
      const payload = raw.video ?? raw.gif ?? raw.short
      return {
        ...base,
        type: 'video',
        text: payload?.caption ?? null,
        media: normalizeMedia(payload),
      }
    }

    // Voice notes and music files both persist as audio; the inbox
    // renders either with a player.
    case 'audio':
    case 'voice': {
      const payload = raw.audio ?? raw.voice
      return { ...base, type: 'audio', media: normalizeMedia(payload) }
    }

    case 'document':
      return {
        ...base,
        type: 'document',
        text: raw.document?.caption ?? null,
        media: normalizeMedia(raw.document),
      }

    // Stickers have no CRM content type of their own — migration 001's
    // CHECK allows `image`, and a sticker is a (WebP) image.
    case 'sticker':
      return { ...base, type: 'sticker', media: normalizeMedia(raw.sticker) }

    case 'location':
    case 'live_location': {
      const loc = raw.location ?? raw.live_location
      if (
        !loc ||
        typeof loc.latitude !== 'number' ||
        typeof loc.longitude !== 'number'
      ) {
        return { ...base, type: 'unsupported' }
      }
      return {
        ...base,
        type: 'location',
        location: {
          latitude: loc.latitude,
          longitude: loc.longitude,
          name: loc.name,
          address: (loc as { address?: string }).address,
        },
      }
    }

    // A shared contact card. Stored as text so the agent at least sees
    // who was shared rather than an empty bubble.
    case 'contact':
    case 'contact_list': {
      const names = raw.contact_list?.list?.map((c) => c.name).filter(Boolean) ?? []
      const single = raw.contact?.name
      const label = single ? [single] : names
      return {
        ...base,
        type: 'contacts',
        text: label.length ? `[contact] ${label.join(', ')}` : '[contact]',
      }
    }

    // Button / list tap on a message we sent.
    case 'reply': {
      const buttonsReply = raw.reply?.buttons_reply
      const listReply = raw.reply?.list_reply
      const picked = buttonsReply ?? listReply
      if (!picked) return { ...base, type: 'unsupported' }
      return {
        ...base,
        type: 'interactive',
        text: picked.title ?? null,
        interactiveReplyId: normalizeButtonReplyId(picked.id),
        interactiveReplyTitle: picked.title ?? null,
      }
    }

    // `action` is Whapi's catch-all for mutations of an existing
    // message. Only reactions matter to the CRM; edits, deletions and
    // media-notify events are dropped.
    case 'action': {
      if (raw.action?.type !== 'reaction' || !raw.action.target) {
        return { ...base, type: 'unsupported' }
      }
      return {
        ...base,
        type: 'reaction',
        reaction: {
          targetMessageId: raw.action.target,
          // An empty emoji means "reaction removed" — the route deletes
          // the row rather than upserting one.
          emoji: raw.action.emoji ?? '',
        },
      }
    }

    default:
      return { ...base, type: 'unsupported' }
  }
}

// ============================================================
// Status normalisation
// ============================================================

/**
 * Whapi's status vocabulary → the CRM's.
 *
 * `played` (a voice note the recipient listened to) is a strictly
 * stronger signal than `read`, but the schema has no such value, so it
 * collapses to `read`. `deleted` describes the *message*, not its
 * delivery, and has no place on the status ladder — it is dropped.
 */
const STATUS_MAP: Record<string, NormalizedStatusValue | null> = {
  failed: 'failed',
  pending: 'pending',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  played: 'read',
  deleted: null,
}

export function normalizeWhapiStatus(
  raw: RawWhapiStatus,
): NormalizedStatus | null {
  if (!raw?.id || !raw.status) return null

  const mapped = STATUS_MAP[raw.status.toLowerCase()]
  if (!mapped) return null

  return {
    messageId: raw.id,
    status: mapped,
    recipientPhone: raw.recipient_id ? chatIdToPhone(raw.recipient_id) : '',
    timestamp: normalizeTimestamp(raw.timestamp),
  }
}

// ============================================================
// Entry point
// ============================================================

/**
 * Normalise a full Whapi callback body.
 *
 * Inbound messages are filtered down to what the CRM's 1:1 shared inbox
 * can act on:
 *
 *   * `from_me` messages are dropped. Whapi reports messages the
 *     connected number sends from *anywhere* — the operator's phone,
 *     another integration, or this CRM. Persisting them here would
 *     double-insert every message the CRM itself just sent (it already
 *     writes its own row on send) and would bump unread counts for the
 *     agent's own replies.
 *
 *   * Group and broadcast chats are dropped. Every downstream table is
 *     keyed to a single contact; a group thread has no such identity.
 *     Supporting groups is a schema change, not a mapping change.
 *
 *   * `unsupported` types are dropped rather than stored as empty
 *     bubbles — an agent seeing nothing is better than seeing a blank.
 */
export function normalizeWhapiWebhook(
  payload: RawWhapiWebhookPayload,
): NormalizedWhapiWebhook {
  const messages: NormalizedInboundMessage[] = []
  for (const raw of payload?.messages ?? []) {
    const normalized = normalizeWhapiMessage(raw)
    if (!normalized) continue
    if (normalized.fromMe) continue
    if (normalized.isGroup) continue
    if (normalized.type === 'unsupported') continue
    if (!normalized.from) continue
    messages.push(normalized)
  }

  const statuses: NormalizedStatus[] = []
  for (const raw of payload?.statuses ?? []) {
    const normalized = normalizeWhapiStatus(raw)
    if (normalized) statuses.push(normalized)
  }

  return {
    channelId: payload?.channel_id ?? null,
    eventType: payload?.event?.type ?? null,
    eventMethod: payload?.event?.event ?? null,
    messages,
    statuses,
  }
}
