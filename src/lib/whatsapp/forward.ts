// ============================================================
// Message forwarding — what a stored message turns into when an agent
// forwards it into another chat.
//
// Pure, and imported by both sides: the inbox uses `planForward` to
// decide whether to offer Forward at all, and `POST
// /api/whatsapp/forward` uses it to build the send-core params. The
// server-only half (making the media fetchable) is `forward-media.ts`.
//
// A forward is a RE-SEND, not a gateway forward. Whapi can forward a
// message natively, but only one that lives on the same channel; Meta's
// Cloud API cannot forward at all. Conversations are one per contact
// across both numbers (migration 046), so the source and target of a
// forward routinely sit on different providers — re-sending is the only
// behaviour that works everywhere. The recipient's WhatsApp therefore
// shows no "Forwarded" label; our own thread does (`is_forwarded`).
// ============================================================

import type { Message } from '@/types';
import { mediaFilename } from '@/lib/media/filename';

/**
 * Most chats one forward may target. WhatsApp's own app caps a forward
 * at five chats as an anti-spam measure; matching it keeps Forward from
 * becoming a way round the broadcast module and its opt-out handling.
 */
export const MAX_FORWARD_TARGETS = 5;

export type ForwardMessageType =
  'text' | 'image' | 'video' | 'audio' | 'document';

export type ForwardPlan =
  | {
      ok: true;
      messageType: ForwardMessageType;
      /** Body for text; caption for media (null when there is none). */
      contentText: string | null;
      mediaUrl: string | null;
      filename: string | null;
    }
  | {
      ok: false;
      /**
       * `unsupported_type` — the send core cannot send this kind
       * (location, shared contact cards).
       * `empty` — a text-like message with no text to send.
       * `no_media` — an attachment whose bytes we never obtained.
       */
      reason: 'unsupported_type' | 'empty' | 'no_media';
    };

/** One destination's outcome, as `POST /api/whatsapp/forward` reports it. */
export interface ForwardTargetResult {
  conversation_id: string;
  ok: boolean;
  /** Our `messages.id` for the new row, on success. */
  message_id?: string;
  error?: string;
  /** Nobody knows whether this copy reached the chat: look before repeating. */
  maybeSent?: boolean;
  /** A Team activity hard restriction (204) refused this target. */
  code?: string;
  rule?: string;
  blockId?: string | null;
  unlockable?: boolean;
  detail?: Record<string, unknown>;
}

export type ForwardSource = Pick<
  Message,
  'content_type' | 'content_text' | 'media_url' | 'media_type' | 'created_at'
>;

/** Captions above this are rejected by WhatsApp (and the send core). */
const MAX_CAPTION = 1024;

/**
 * Map a stored message onto the send-core params that re-create it.
 *
 * Templates and interactive messages go out as their rendered text. A
 * template is only sendable as-is inside its approved (name, language)
 * on Meta, and re-sending a bot's buttons to a different customer would
 * hand them reply ids that route a Flow they are not in.
 */
export function planForward(message: ForwardSource): ForwardPlan {
  const text = message.content_text?.trim() ? message.content_text : null;

  switch (message.content_type) {
    case 'text':
    case 'template':
    case 'interactive':
      return text
        ? {
            ok: true,
            messageType: 'text',
            contentText: text,
            mediaUrl: null,
            filename: null,
          }
        : { ok: false, reason: 'empty' };

    case 'image':
    case 'video':
    case 'audio':
    case 'document': {
      if (!message.media_url) return { ok: false, reason: 'no_media' };

      const filename =
        message.content_type === 'document'
          ? mediaFilename({
              content_type: message.content_type,
              content_text: message.content_text,
              media_url: message.media_url,
              media_type: message.media_type,
              created_at: message.created_at,
            })
          : null;

      // Audio carries no caption. A document with no caption stores its
      // filename as the text — don't send that twice.
      let caption: string | null = text;
      if (message.content_type === 'audio') caption = null;
      if (caption && filename && caption === filename) caption = null;
      if (caption && caption.length > MAX_CAPTION) {
        caption = caption.slice(0, MAX_CAPTION);
      }

      return {
        ok: true,
        messageType: message.content_type,
        contentText: caption,
        mediaUrl: message.media_url,
        filename,
      };
    }

    default:
      return { ok: false, reason: 'unsupported_type' };
  }
}

/** Whether the inbox should offer Forward on this message. */
export function isForwardable(message: ForwardSource): boolean {
  return planForward(message).ok;
}

/** Our public buckets a message's attachment is stored in. */
const OWN_BUCKETS = ['chat-media', 'flow-media'] as const;

/**
 * The URL of an object in our own PUBLIC storage, in this account's
 * folder: the one kind of URL a gateway can fetch unaided. Null for
 * everything else, which is re-hosted before it can be forwarded or
 * refused (`forward-media.ts`):
 *
 *   - `/api/whatsapp/media/<id>` — our auth-gated proxy; relative, and
 *     behind a session cookie.
 *   - a Meta lookaside URL, or a Whapi-hosted link — both require the
 *     receiving channel's bearer token, which the *sending* gateway
 *     does not have (and on a cross-provider forward, never could).
 *
 * Matched on the path and rebuilt on `publicStorageBase`
 * (`publicSupabaseUrl()`; passed in so this stays pure): the public
 * origin of older rows changes with the tunnel, and whatever host the
 * row names is never contacted.
 */
export function ownPublicMediaUrl(
  mediaUrl: string,
  publicStorageBase: string,
  accountId: string
): string | null {
  const base = publicStorageBase.replace(/\/+$/, '');
  if (!base || !accountId) return null;
  let path: string;
  try {
    const url = new URL(mediaUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // `..` segments are collapsed by the parser; an encoded slash is not.
    if (/%2f|%5c/i.test(url.pathname)) return null;
    path = url.pathname;
  } catch {
    return null;
  }
  for (const bucket of OWN_BUCKETS) {
    const prefix = `/storage/v1/object/public/${bucket}/account-${accountId}/`;
    const at = path.indexOf(prefix);
    if (at !== -1 && path.length > at + prefix.length) {
      return `${base}${path.slice(at)}`;
    }
  }
  return null;
}
