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
  /** Button/list tap: the id we set when sending. Drives Flow advancement. */
  interactiveReplyId: string | null;
  /** Button/list tap: the visible label the customer saw. */
  interactiveReplyTitle: string | null;
  /** Message this one quotes (swipe-reply), if any. */
  contextMessageId: string | null;
  /** True for messages sent BY the connected number (from the phone, another tool, or us). */
  fromMe: boolean;
  /** True when the chat is a group — the CRM's 1:1 inbox skips these. */
  isGroup: boolean;
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
