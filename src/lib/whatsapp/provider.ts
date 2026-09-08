// ============================================================
// Provider-neutral send layer.
//
// Two gateways, one shape. Everything that sends a WhatsApp message
// goes through here with a `WhatsAppChannel` (from `channels.ts`) and
// never learns which upstream it is talking to:
//
//   whapi -> lib/whatsapp/whapi-api.ts   (linked-device channel)
//   meta  -> lib/whatsapp/meta-api.ts    (Cloud API number)
//
// This is the same containment `whapi-webhook.ts` provides on the way
// IN — normalise at the boundary so the CRM logic in the middle stays
// provider-agnostic. Without it, every send site would grow a
// `if (provider === 'meta')` branch and the two engines' senders would
// double again.
//
// ─── What genuinely differs, and how it is handled ────────────────
//
//   * Credentials. Whapi: one channel token. Meta: (phone number id,
//     access token). Absorbed by taking a channel, not raw strings.
//   * Quoting. Whapi calls it `quotedMessageId`, Meta `contextMessageId`.
//     Same concept, renamed at the boundary.
//   * Media kinds. Whapi has `voice` and `sticker`; the Cloud API
//     client does not. Mapped, with the degradation documented on
//     `toMetaMediaKind`.
//   * Templates. On Whapi a template is a local definition rendered at
//     send time. On Meta it must already exist in the WABA's registry,
//     approved, and is addressed by (name, language). Both are driven
//     from the same `message_templates` row.
// ============================================================

import type { MessageTemplate } from '@/types';

import type { WhatsAppChannel, WhatsAppProvider } from './channels';
import * as meta from './meta-api';
import * as whapi from './whapi-api';

export interface ProviderSendResult {
  /** The gateway's message id — persisted as `messages.message_id`. */
  messageId: string;
  /** Which gateway carried it — persisted as `messages.provider`. */
  provider: WhatsAppProvider;
}

/** The union of both gateways' media kinds. */
export type ProviderMediaKind =
  'image' | 'video' | 'document' | 'audio' | 'voice' | 'sticker';

/**
 * Narrow a media kind to what the Cloud API client accepts.
 *
 * `voice` is a WhatsApp presentation detail rather than a distinct
 * upload type — an OGG/Opus file sent as `audio` renders as a playable
 * voice note either way, so the mapping is lossless.
 *
 * `sticker` is NOT lossless: it arrives as an ordinary image rather
 * than a sticker bubble. Accepted deliberately — a marketing number
 * has no reason to send stickers, and failing the send outright would
 * be a worse outcome than a slightly different bubble.
 */
function toMetaMediaKind(kind: ProviderMediaKind): meta.MediaKind {
  if (kind === 'voice') return 'audio';
  if (kind === 'sticker') return 'image';
  return kind;
}

export interface SendTextArgs {
  channel: WhatsAppChannel;
  to: string;
  text: string;
  quotedMessageId?: string | null;
}

export async function sendText(
  args: SendTextArgs
): Promise<ProviderSendResult> {
  const { channel, to, text, quotedMessageId } = args;

  if (channel.provider === 'meta') {
    const res = await meta.sendTextMessage({
      phoneNumberId: channel.phoneNumberId,
      accessToken: channel.accessToken,
      to,
      text,
      contextMessageId: quotedMessageId ?? undefined,
    });
    return { messageId: res.messageId, provider: 'meta' };
  }

  const res = await whapi.sendTextMessage({
    token: channel.accessToken,
    to,
    text,
    quotedMessageId,
  });
  return { messageId: res.messageId, provider: 'whapi' };
}

export interface SendMediaArgs {
  channel: WhatsAppChannel;
  to: string;
  kind: ProviderMediaKind;
  /** Public URL the gateway fetches at send time. */
  link: string;
  caption?: string;
  filename?: string;
  quotedMessageId?: string | null;
}

export async function sendMedia(
  args: SendMediaArgs
): Promise<ProviderSendResult> {
  const { channel, to, kind, link, caption, filename, quotedMessageId } = args;

  if (channel.provider === 'meta') {
    const res = await meta.sendMediaMessage({
      phoneNumberId: channel.phoneNumberId,
      accessToken: channel.accessToken,
      to,
      kind: toMetaMediaKind(kind),
      link,
      caption,
      filename,
      contextMessageId: quotedMessageId ?? undefined,
    });
    return { messageId: res.messageId, provider: 'meta' };
  }

  const res = await whapi.sendMediaMessage({
    token: channel.accessToken,
    to,
    kind,
    link,
    caption,
    filename,
    quotedMessageId,
  });
  return { messageId: res.messageId, provider: 'whapi' };
}

export interface SendTemplateArgs {
  channel: WhatsAppChannel;
  to: string;
  /** The local `message_templates` row driving both providers. */
  template: MessageTemplate;
  /** Positional `{{1}}`, `{{2}}` … body substitutions. */
  bodyParams?: string[];
  /** Structured per-send values (header text, media, button params) — Meta only. */
  messageParams?: unknown;
  /** Runtime override for a media header's URL. */
  headerMediaUrl?: string | null;
  quotedMessageId?: string | null;
}

/**
 * Send a template row.
 *
 * The asymmetry worth knowing: on Meta this addresses a template that
 * must already be registered and APPROVED in the WABA — an unapproved
 * or misnamed one is a hard gateway rejection (`MetaError.isTemplateError`).
 * On Whapi the same row is simply rendered and posted, so it always
 * works. That is exactly why a marketing surface is worth routing to
 * Meta and a conversational one is not.
 */
export async function sendTemplate(
  args: SendTemplateArgs
): Promise<ProviderSendResult> {
  const {
    channel,
    to,
    template,
    bodyParams = [],
    messageParams,
    headerMediaUrl,
    quotedMessageId,
  } = args;

  if (channel.provider === 'meta') {
    const res = await meta.sendTemplateMessage({
      phoneNumberId: channel.phoneNumberId,
      accessToken: channel.accessToken,
      to,
      templateName: template.name,
      language: template.language,
      params: bodyParams,
      template,
      messageParams: (messageParams ?? undefined) as never,
      contextMessageId: quotedMessageId ?? undefined,
    });
    return { messageId: res.messageId, provider: 'meta' };
  }

  const res = await whapi.sendTemplateMessage({
    token: channel.accessToken,
    to,
    template,
    bodyParams,
    headerMediaUrl,
    quotedMessageId,
  });
  return { messageId: res.messageId, provider: 'whapi' };
}

export interface InteractiveButton {
  id: string;
  title: string;
}

export interface InteractiveListRow {
  id: string;
  title: string;
  description?: string;
}

export interface InteractiveListSection {
  title?: string;
  rows: InteractiveListRow[];
}

export interface SendInteractiveButtonsArgs {
  channel: WhatsAppChannel;
  to: string;
  bodyText: string;
  headerText?: string;
  footerText?: string;
  buttons: InteractiveButton[];
  quotedMessageId?: string | null;
}

export async function sendInteractiveButtons(
  args: SendInteractiveButtonsArgs
): Promise<ProviderSendResult> {
  const {
    channel,
    to,
    bodyText,
    headerText,
    footerText,
    buttons,
    quotedMessageId,
  } = args;

  if (channel.provider === 'meta') {
    const res = await meta.sendInteractiveButtons({
      phoneNumberId: channel.phoneNumberId,
      accessToken: channel.accessToken,
      to,
      bodyText,
      headerText,
      footerText,
      buttons,
      contextMessageId: quotedMessageId ?? undefined,
    });
    return { messageId: res.messageId, provider: 'meta' };
  }

  const res = await whapi.sendInteractiveButtons({
    token: channel.accessToken,
    to,
    bodyText,
    headerText,
    footerText,
    buttons,
    quotedMessageId,
  });
  return { messageId: res.messageId, provider: 'whapi' };
}

export interface SendInteractiveListArgs {
  channel: WhatsAppChannel;
  to: string;
  bodyText: string;
  buttonLabel: string;
  headerText?: string;
  footerText?: string;
  sections: InteractiveListSection[];
  quotedMessageId?: string | null;
}

export async function sendInteractiveList(
  args: SendInteractiveListArgs
): Promise<ProviderSendResult> {
  const {
    channel,
    to,
    bodyText,
    buttonLabel,
    headerText,
    footerText,
    sections,
    quotedMessageId,
  } = args;

  if (channel.provider === 'meta') {
    const res = await meta.sendInteractiveList({
      phoneNumberId: channel.phoneNumberId,
      accessToken: channel.accessToken,
      to,
      bodyText,
      buttonLabel,
      headerText,
      footerText,
      sections,
      contextMessageId: quotedMessageId ?? undefined,
    });
    return { messageId: res.messageId, provider: 'meta' };
  }

  const res = await whapi.sendInteractiveList({
    token: channel.accessToken,
    to,
    bodyText,
    buttonLabel,
    headerText,
    footerText,
    sections,
    quotedMessageId,
  });
  return { messageId: res.messageId, provider: 'whapi' };
}

export interface SendReactionArgs {
  channel: WhatsAppChannel;
  /** Required by Meta, ignored by Whapi (the target id identifies the chat). */
  to: string;
  targetMessageId: string;
  /** Single emoji, or an empty string to remove an existing reaction. */
  emoji: string;
}

export async function sendReaction(
  args: SendReactionArgs
): Promise<ProviderSendResult> {
  const { channel, to, targetMessageId, emoji } = args;

  if (channel.provider === 'meta') {
    const res = await meta.sendReactionMessage({
      phoneNumberId: channel.phoneNumberId,
      accessToken: channel.accessToken,
      to,
      targetMessageId,
      emoji,
    });
    return { messageId: res.messageId, provider: 'meta' };
  }

  const res = await whapi.sendReactionMessage({
    token: channel.accessToken,
    targetMessageId,
    emoji,
  });
  return { messageId: res.messageId, provider: 'whapi' };
}

// ============================================================
// Inbound media
// ============================================================

/**
 * Exchange a gateway media id for a downloadable URL.
 *
 * Both gateways return the same triple, but they reach it very
 * differently, and the difference is why this indirection exists at
 * all:
 *
 *   * Whapi auto-downloads (webhook registration turns that on), so an
 *     inbound attachment usually arrives with a `link` already set and
 *     this is never called.
 *   * Meta NEVER sends a link — only a media id — so every inbound
 *     attachment on the Cloud API goes through here.
 *
 * Either way the resulting URL is short-lived, which is what
 * `mirrorInboundMedia` exists to fix.
 */
export async function getMediaUrl(args: {
  channel: WhatsAppChannel;
  mediaId: string;
}): Promise<{ url: string; mimeType: string; fileSize: number | null }> {
  const { channel, mediaId } = args;

  if (channel.provider === 'meta') {
    return meta.getMediaUrl({ mediaId, accessToken: channel.accessToken });
  }
  return whapi.getMediaUrl({ token: channel.accessToken, mediaId });
}

/**
 * Download media bytes the gateway is hosting.
 *
 * Both gateways require the account's own bearer token on the download
 * URL, which is why this cannot be a bare `fetch` at the call site.
 */
export async function downloadMedia(args: {
  channel: WhatsAppChannel;
  downloadUrl: string;
}): Promise<{ buffer: Buffer; contentType: string }> {
  const { channel, downloadUrl } = args;

  if (channel.provider === 'meta') {
    return meta.downloadMedia({
      downloadUrl,
      accessToken: channel.accessToken,
    });
  }
  return whapi.downloadMedia({ downloadUrl, token: channel.accessToken });
}

// ============================================================
// Failure interpretation
// ============================================================

/**
 * Turn a gateway failure into something an operator can act on.
 *
 * Both error classes carry `status` and capability getters, but the
 * *causes* differ enough that a shared translation is worth having:
 * the single most common Meta failure (a closed 24-hour window) has no
 * Whapi equivalent at all, and reads as an incomprehensible numeric
 * code unless it is named.
 */
export function describeSendFailure(error: unknown): string {
  if (error instanceof meta.MetaError) {
    if (error.isOutsideServiceWindow) {
      return (
        'This number can only send an approved template right now: the customer ' +
        "has not messaged in the last 24 hours, so Meta's service window is closed."
      );
    }
    if (error.isTemplateError) {
      return `Meta rejected the template: ${error.message}. Check it is submitted and APPROVED for this WABA.`;
    }
    if (error.isAuthError) {
      return 'The Meta access token is invalid, expired, or missing permissions. Reconnect the number in Settings → WhatsApp.';
    }
    if (error.isRateLimited) {
      return 'Meta is rate-limiting this WhatsApp Business Account. Retry shortly.';
    }
    if (error.isUndeliverable) {
      return 'That number is not reachable on WhatsApp.';
    }
    return error.message;
  }

  if (error instanceof whapi.WhapiError) {
    if (error.isUnknownChannel) {
      return 'Whapi does not recognise this channel token. Check it in Settings → WhatsApp.';
    }
    if (error.isAuthError) {
      return 'The Whapi channel token is invalid or revoked. Reconnect the channel in Settings → WhatsApp.';
    }
    if (error.isBillingError) {
      return 'The Whapi subscription has lapsed. Renew it to resume sending.';
    }
    return error.message;
  }

  return error instanceof Error ? error.message : String(error);
}
