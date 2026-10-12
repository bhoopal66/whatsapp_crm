import type { SharedContact } from './contact-card';
// ============================================================
// The neutral inbound shape.
//
// Both gateways describe the same events with very different
// envelopes, so each has a normaliser that lands on the types below
// and nothing downstream ever learns which one produced an event:
//
//   whapi-webhook.ts  Whapi's flat { messages[], statuses[] }
//   meta-webhook.ts   Meta's entry[].changes[].value.{...}
//
// These types lived in `whapi-webhook.ts` while Whapi was the only
// transport. They moved here when the Cloud API was added back
// (migration 046) so the Meta normaliser could target them without
// importing from a provider-specific module. `whapi-webhook.ts`
// re-exports them, so existing import sites keep working.
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
  | 'unsupported';

export interface NormalizedMedia {
  /** Whapi media id — the fallback handle when `link` is absent. */
  id: string | null;
  mimeType: string | null;
  /**
   * Direct download URL. Present when the channel has auto-download
   * enabled (which `registerWebhook` turns on). Null otherwise, in
   * which case the caller must resolve `id` via `getMediaUrl`.
   */
  link: string | null;
  filename: string | null;
  fileSize: number | null;
}

export interface NormalizedInboundMessage {
  /** WhatsApp message id — the idempotency key for replayed deliveries. */
  id: string;
  /** Sender, digits only (no `+`). */
  from: string;
  /** Full chat id, e.g. `919984351847@s.whatsapp.net`. */
  chatId: string;
  /** Sender's WhatsApp display name, when the payload carries one. */
  fromName: string | null;
  /** Unix seconds as a string — matches what the persistence layer expects. */
  timestamp: string;
  type: NormalizedMessageType;
  /** Body text, or a media caption. Null when the message carries none. */
  text: string | null;
  media: NormalizedMedia | null;
  location: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  } | null;
  /** Set only for `type === 'reaction'`. */
  reaction: { targetMessageId: string; emoji: string } | null;
  /** Set only for `type === 'contacts'`: the card(s) the customer shared. */
  contacts: SharedContact[] | null;
  /** Button/list tap: the id we set when sending. Drives Flow advancement. */
  interactiveReplyId: string | null;
  /** Button/list tap: the visible label the customer saw. */
  interactiveReplyTitle: string | null;
  /** Message this one quotes (swipe-reply), if any. */
  contextMessageId: string | null;
  /** The sender forwarded this from another chat (migration 055). */
  forwarded: boolean;
  /** True for messages sent BY the connected number (from the phone, another tool, or us). */
  fromMe: boolean;
  /** True when the chat is a group — the CRM's 1:1 inbox skips these. */
  isGroup: boolean;
  /**
   * Meta only: the ad, post or link the customer tapped to open the chat
   * (`messages[].referral`). Whapi never sets it.
   */
  referral?: InboundReferral;
  /**
   * The chat was opened from a Click-to-WhatsApp ad (`referral.source_type
   * === 'ad'`), which opens Meta's 72-hour free-entry window. QR codes,
   * website links and posts do not. Always false on Whapi.
   */
  freeEntry: boolean;
  /**
   * Meta's business-scoped user id for the sender, when the callback
   * carries one (`from_user_id`, else the sender's `contacts[].user_id`).
   */
  bsuid?: string;
}

/** `messages[].referral`, renamed; only the fields Meta sent are set. */
export interface InboundReferral {
  sourceType: string;
  sourceId?: string;
  sourceUrl?: string;
  headline?: string;
  body?: string;
  /** Click-to-WhatsApp click id, for ad attribution. */
  ctwaClid?: string;
}

/** Status values the `messages.status` CHECK constraint accepts. */
export type NormalizedStatusValue =
  'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface NormalizedStatus {
  messageId: string;
  status: NormalizedStatusValue;
  /** Recipient, digits only. */
  recipientPhone: string;
  /** Unix seconds as a string. */
  timestamp: string;
  /**
   * Why the gateway failed the message, when it said. Meta attaches an
   * `errors[]` to a `failed` receipt; without it a failed broadcast
   * recipient is a bare "failed" nobody can act on. Only the Meta
   * normaliser fills it — Whapi's receipts carry no comparable detail.
   */
  error?: { code?: number; title?: string; details?: string };
}

export interface NormalizedWebhook {
  /**
   * The gateway's own identifier for the number that produced the
   * event, and the tenancy routing key on both providers:
   *
   *   whapi -> the channel id from the payload, cross-checked against
   *            the config the callback secret already resolved;
   *   meta  -> `metadata.phone_number_id`, which is what SELECTS the
   *            config, with the HMAC signature proving the payload.
   *
   * Either way it matches `whatsapp_config.phone_number_id`.
   */
  channelId: string | null;
  eventType: string | null;
  eventMethod: string | null;
  messages: NormalizedInboundMessage[];
  statuses: NormalizedStatus[];
}
