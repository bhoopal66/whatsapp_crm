/**
 * Meta Cloud API webhook payload → the neutral CRM inbound shape.
 *
 * The counterpart to `whapi-webhook.ts`. Meta nests everything under
 * `entry[].changes[].value.{messages,statuses,contacts,metadata}`;
 * Whapi posts a flat `{ messages[], statuses[] }`. Both land on the
 * types in `inbound.ts`, so the ~1200-line inbound pipeline — contact
 * dedup, conversation resolution, Flows, automations, AI auto-reply,
 * public webhook fan-out — runs unchanged for either provider.
 *
 * Everything here is pure and synchronous — no network, no database —
 * so the mapping is cheap to unit-test against captured payloads.
 *
 * ─── Differences that actually matter ─────────────────────────────
 *
 *  * **Tenancy.** Whapi's callback is authenticated by a secret in the
 *    URL and the channel id is only cross-checked. Meta signs the raw
 *    body (`X-Hub-Signature-256`), so here the payload IS the
 *    authenticated fact: `metadata.phone_number_id` selects the config
 *    row and the HMAC proves it. See `webhook-signature.ts`.
 *
 *  * **No echo of our own sends.** Whapi reports everything the number
 *    sends from anywhere, so its normaliser has to drop `from_me`.
 *    The Cloud API never delivers outbound as inbound, so `fromMe` is
 *    always false here.
 *
 *  * **No groups.** The Cloud API is 1:1 only, so `isGroup` is always
 *    false — there is no group envelope to filter out.
 *
 *  * **Media has no link.** Whapi auto-downloads and hands over a
 *    `link`. Meta hands over an id that must be exchanged for a URL via
 *    `GET /{media-id}`, so `media.link` is null and the route resolves
 *    it. That is why `resolveInboundMediaUrl` is provider-aware.
 *
 *  * **TWO button-reply envelopes.** A tap on an *interactive* message
 *    arrives as `interactive.button_reply`; a tap on a *template's*
 *    quick-reply button arrives as a completely different `button`
 *    object carrying `payload`/`text`. Handling only the first is
 *    issue #478, and it is invisible in testing unless a template
 *    button is actually pressed. Both collapse to one reply id here.
 */

import type {
  NormalizedInboundMessage,
  NormalizedMedia,
  NormalizedMessageType,
  NormalizedStatus,
  NormalizedStatusValue,
  NormalizedWebhook,
} from './inbound';

// ============================================================
// Raw Meta shapes (only the fields we read)
// ============================================================

interface RawMetaMedia {
  id?: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
  file_size?: number | string;
}

interface RawMetaMessage {
  id?: string;
  from?: string;
  timestamp?: number | string;
  type?: string;

  text?: { body?: string };

  image?: RawMetaMedia;
  video?: RawMetaMedia;
  audio?: RawMetaMedia & { voice?: boolean };
  document?: RawMetaMedia;
  sticker?: RawMetaMedia;

  location?: {
    latitude?: number;
    longitude?: number;
    name?: string;
    address?: string;
  };

  contacts?: Array<{ name?: { formatted_name?: string } }>;

  reaction?: { message_id?: string; emoji?: string };

  /** Tap on an interactive (button/list) message we sent. */
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };

  /**
   * Tap on a TEMPLATE's quick-reply button. A different envelope
   * entirely from `interactive.button_reply` — `payload` carries what
   * we set as the button id, `text` the visible label.
   */
  button?: { payload?: string; text?: string };

  /** Quoted (swipe-reply) parent, or the message a button belongs to. */
  context?: { id?: string; from?: string };

  /** Present on a type Meta could not deliver to us. */
  errors?: Array<{ code?: number; title?: string; message?: string }>;
}

interface RawMetaStatus {
  id?: string;
  status?: string;
  timestamp?: number | string;
  recipient_id?: string;
  errors?: Array<{ code?: number; title?: string }>;
}

interface RawMetaContact {
  wa_id?: string;
  profile?: { name?: string };
}

interface RawMetaValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: RawMetaContact[];
  messages?: RawMetaMessage[];
  statuses?: RawMetaStatus[];
}

interface RawMetaChange {
  field?: string;
  value?: RawMetaValue;
}

export interface RawMetaWebhookPayload {
  object?: string;
  entry?: Array<{ id?: string; changes?: RawMetaChange[] }>;
}

// ============================================================
// Helpers
// ============================================================

/** Digits only, matching what the CRM stores and compares on. */
function digitsOnly(value: string | undefined | null): string {
  return (value || '').replace(/\D/g, '');
}

/**
 * Meta sends timestamps as unix *seconds*, as a string. Downstream
 * persistence does `new Date(parseInt(ts) * 1000)`, so normalise to a
 * seconds string exactly as the Whapi normaliser does.
 */
function normalizeTimestamp(value: number | string | undefined): string {
  if (typeof value === 'number') return String(Math.floor(value));
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  return String(Math.floor(Date.now() / 1000));
}

function toMedia(raw: RawMetaMedia | undefined): NormalizedMedia | null {
  if (!raw) return null;
  const size =
    typeof raw.file_size === 'string'
      ? parseInt(raw.file_size, 10)
      : raw.file_size;
  return {
    id: raw.id ?? null,
    mimeType: raw.mime_type ?? null,
    // Meta never includes a direct link — the id must be exchanged for
    // a short-lived URL via GET /{media-id}. The route does that.
    link: null,
    filename: raw.filename ?? null,
    fileSize: typeof size === 'number' && !Number.isNaN(size) ? size : null,
  };
}

/**
 * Map Meta's message type onto the CRM's content types.
 *
 * `sticker` and `contacts` have no column value of their own and are
 * narrowed by the route; they are surfaced here so it can.
 */
function toMessageType(raw: RawMetaMessage): NormalizedMessageType {
  switch (raw.type) {
    case 'text':
      return 'text';
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'document':
      return 'document';
    case 'sticker':
      return 'sticker';
    case 'location':
      return 'location';
    case 'contacts':
      return 'contacts';
    case 'reaction':
      return 'reaction';
    case 'interactive':
    case 'button':
      return 'interactive';
    default:
      // 'unsupported', 'system', 'order', 'ephemeral', anything new.
      return 'unsupported';
  }
}

/** Meta's status vocabulary maps 1:1 onto the `messages.status` CHECK values. */
function toStatusValue(raw: string | undefined): NormalizedStatusValue | null {
  switch (raw) {
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'failed':
      return 'failed';
    // 'deleted' and 'warning' carry no state the ladder models.
    default:
      return null;
  }
}

// ============================================================
// Message normalisation
// ============================================================

export function normalizeMetaMessage(
  raw: RawMetaMessage,
  /** `contacts[]` from the same change, for the sender's display name. */
  contacts: RawMetaContact[]
): NormalizedInboundMessage | null {
  const id = raw.id;
  const from = digitsOnly(raw.from);
  if (!id || !from) return null;

  const type = toMessageType(raw);

  // Media lives under a key named for the type.
  const media =
    toMedia(raw.image) ??
    toMedia(raw.video) ??
    toMedia(raw.audio) ??
    toMedia(raw.document) ??
    toMedia(raw.sticker);

  // Both button envelopes collapse here. `interactive.button_reply` is
  // a tap on an interactive message; `button.payload` is a tap on a
  // template's quick-reply button (issue #478).
  const buttonReply = raw.interactive?.button_reply;
  const listReply = raw.interactive?.list_reply;
  const templateButton = raw.button;

  const interactiveReplyId =
    buttonReply?.id ?? listReply?.id ?? templateButton?.payload ?? null;
  const interactiveReplyTitle =
    buttonReply?.title ?? listReply?.title ?? templateButton?.text ?? null;

  // Body text, or a media caption, or the label of whatever was tapped
  // — the same precedence the Whapi normaliser uses, so a flow reading
  // `text` behaves identically on both providers.
  const captionSource =
    raw.image ?? raw.video ?? raw.document ?? raw.audio ?? raw.sticker;
  const text =
    raw.text?.body ??
    captionSource?.caption ??
    interactiveReplyTitle ??
    raw.contacts?.[0]?.name?.formatted_name ??
    null;

  const profileName = contacts.find((c) => digitsOnly(c.wa_id) === from)
    ?.profile?.name;

  return {
    id,
    from,
    // Synthesised so downstream code that parses a chat id (and the
    // `chatIdToPhone` helper) behaves the same on both providers. The
    // Cloud API has no chat-id concept of its own.
    chatId: `${from}@s.whatsapp.net`,
    fromName: profileName || null,
    timestamp: normalizeTimestamp(raw.timestamp),
    type,
    text,
    media,
    location: raw.location
      ? {
          latitude: raw.location.latitude ?? 0,
          longitude: raw.location.longitude ?? 0,
          name: raw.location.name,
          address: raw.location.address,
        }
      : null,
    reaction:
      type === 'reaction' && raw.reaction?.message_id
        ? {
            targetMessageId: raw.reaction.message_id,
            // An empty emoji is Meta's "reaction removed".
            emoji: raw.reaction.emoji ?? '',
          }
        : null,
    interactiveReplyId,
    interactiveReplyTitle,
    // A template-button tap carries `context.id` pointing at the
    // template message; that is a quote for our purposes too.
    contextMessageId: raw.context?.id ?? null,
    // The Cloud API never echoes our own sends back as inbound, and has
    // no group messaging — both filters the Whapi normaliser needs are
    // structurally unnecessary here.
    fromMe: false,
    isGroup: false,
  };
}

export function normalizeMetaStatus(
  raw: RawMetaStatus
): NormalizedStatus | null {
  const messageId = raw.id;
  const status = toStatusValue(raw.status);
  if (!messageId || !status) return null;

  return {
    messageId,
    status,
    recipientPhone: digitsOnly(raw.recipient_id),
    timestamp: normalizeTimestamp(raw.timestamp),
  };
}

// ============================================================
// Envelope
// ============================================================

/**
 * Flatten a Cloud API callback into the neutral shape.
 *
 * One POST can carry several entries and several changes, each with its
 * own `value`. Only `field: 'messages'` changes are handled here —
 * `message_template_status_update` (template review results) is a
 * different concern and belongs to `template-webhook.ts`.
 *
 * `channelId` comes from `metadata.phone_number_id`, which is what the
 * route matches against `whatsapp_config.phone_number_id` to find the
 * account. Unlike Whapi's channel id this is load-bearing rather than a
 * cross-check — but the request's HMAC signature is what makes trusting
 * it safe.
 */
export function normalizeMetaWebhook(
  payload: RawMetaWebhookPayload
): NormalizedWebhook {
  const messages: NormalizedInboundMessage[] = [];
  const statuses: NormalizedStatus[] = [];
  let channelId: string | null = null;

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field && change.field !== 'messages') continue;
      const value = change.value;
      if (!value) continue;

      if (!channelId && value.metadata?.phone_number_id) {
        channelId = value.metadata.phone_number_id;
      }

      const contacts = value.contacts ?? [];

      for (const raw of value.messages ?? []) {
        const normalized = normalizeMetaMessage(raw, contacts);
        if (!normalized) continue;
        // Unsupported types carry nothing renderable and would insert a
        // blank bubble. Dropped, matching the Whapi normaliser.
        if (normalized.type === 'unsupported') continue;
        messages.push(normalized);
      }

      for (const raw of value.statuses ?? []) {
        const normalized = normalizeMetaStatus(raw);
        if (normalized) statuses.push(normalized);
      }
    }
  }

  return {
    channelId,
    eventType: 'messages',
    eventMethod: 'post',
    messages,
    statuses,
  };
}

/**
 * Does this payload carry template review results rather than messages?
 * Those go to `template-webhook.ts`, which updates `message_templates`.
 */
export function isTemplateStatusPayload(
  payload: RawMetaWebhookPayload
): boolean {
  return (payload.entry ?? []).some((entry) =>
    (entry.changes ?? []).some(
      (change) => change.field === 'message_template_status_update'
    )
  );
}
