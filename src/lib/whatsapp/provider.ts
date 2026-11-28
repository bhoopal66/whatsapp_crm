// ============================================================
// Provider-neutral send layer.
//
// Three gateways, one shape. Everything that sends a WhatsApp message
// goes through here with a `WhatsAppChannel` (from `channels.ts`) and
// never learns which upstream it is talking to:
//
//   whapi  -> lib/whatsapp/whapi-api.ts   (linked-device channel)
//   meta   -> lib/whatsapp/meta-api.ts    (Cloud API number)
//   openwa -> lib/whatsapp/openwa-api.ts  (self-hosted linked device)
//
// Every function switches on `channel.provider` with a `never` default,
// so a fourth provider fails typecheck here instead of silently falling
// into another gateway's client (an `else` branch once sent every
// OpenWA row to Whapi with the session key as a channel token).
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
//     access token). OpenWA: (session id, session-scoped key), stored
//     in `phone_number_id` / `access_token`. Absorbed by taking a
//     channel, not raw strings.
//   * Quoting. Whapi calls it `quotedMessageId`, Meta `contextMessageId`.
//     Same concept, renamed at the boundary.
//   * Media kinds. Whapi has `voice` and `sticker`; the Cloud API
//     client does not. Mapped, with the degradation documented on
//     `toMetaMediaKind`.
//   * Templates. On Whapi a template is a local definition rendered at
//     send time. On Meta it must already exist in the WABA's registry,
//     approved, and is addressed by (name, language). Both are driven
//     from the same `message_templates` row. OpenWA is Whapi's case.
// ============================================================

import { gatewayMediaLink } from '@/lib/storage/chat-media-sign';
import { streamCapped, streamDeadline } from '@/lib/media/capped-body';
import type { MessageTemplate } from '@/types';

import {
  describeChannel,
  type WhatsAppChannel,
  type WhatsAppProvider,
} from './channels';
import * as meta from './meta-api';
import * as openwa from './openwa-api';
import { neverConnected } from './never-connected';
import { TemplateParamError } from './template-send-builder';
import * as whapi from './whapi-api';
import { renderedForLinkedDevice } from './template-body';

export interface ProviderSendResult {
  /** The gateway's message id — persisted as `messages.message_id`. */
  messageId: string;
  /** Which gateway carried it — persisted as `messages.provider`. */
  provider: WhatsAppProvider;
}

/** The union of the gateways' media kinds (Whapi's and OpenWA's agree). */
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

/**
 * An OpenWA row keeps its session id in `phone_number_id` and its
 * session-scoped key in `access_token` (`wabaId` is only the display
 * number), so the pair is read from there.
 */
function openwaCredentials(channel: WhatsAppChannel): {
  apiKey: string;
  sessionId: string;
} {
  return { apiKey: channel.accessToken, sessionId: channel.phoneNumberId };
}

/**
 * The `default` of every provider switch. Typed `never` so that adding a
 * provider to the union fails typecheck at each switch; at run time it
 * catches a row whose `provider` column holds something unexpected.
 */
function unknownProvider(provider: never): never {
  throw new Error(`Unknown WhatsApp provider: ${String(provider)}`);
}

export interface SendTextArgs {
  /**
   * OpenWA only: stable for one logical send, so a retry of it carries
   * the same `Idempotency-Key` (`openwaSendKey`). Whapi and Meta ignore it.
   */
  idempotencyKey?: string;
  channel: WhatsAppChannel;
  to: string;
  text: string;
  quotedMessageId?: string | null;
}

export async function sendText(
  args: SendTextArgs
): Promise<ProviderSendResult> {
  const { channel, to, text, quotedMessageId } = args;

  switch (channel.provider) {
    case 'whapi': {
      const res = await whapi.sendTextMessage({
        token: channel.accessToken,
        to,
        text,
        quotedMessageId,
      });
      return { messageId: res.messageId, provider: 'whapi' };
    }
    case 'meta': {
      const res = await meta.sendTextMessage({
        phoneNumberId: channel.phoneNumberId,
        accessToken: channel.accessToken,
        to,
        text,
        contextMessageId: quotedMessageId ?? undefined,
      });
      return { messageId: res.messageId, provider: 'meta' };
    }
    case 'openwa': {
      const res = await openwa.sendTextMessage({
        ...openwaCredentials(channel),
        idempotencyKey: args.idempotencyKey,
        to,
        text,
        quotedMessageId,
      });
      return { messageId: res.messageId, provider: 'openwa' };
    }
    default:
      return unknownProvider(channel.provider);
  }
}

export interface SendMediaArgs {
  /**
   * OpenWA only: stable for one logical send, so a retry of it carries
   * the same `Idempotency-Key` (`openwaSendKey`). Whapi and Meta ignore it.
   */
  idempotencyKey?: string;
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
  const { channel, to, kind, caption, filename, quotedMessageId } = args;
  // chat-media is private (migration 321): the gateway gets a link signed
  // for this send, never the stored one (lib/storage/chat-media-sign.ts).
  const link = await gatewayMediaLink(args.link);

  switch (channel.provider) {
    case 'whapi': {
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
    case 'meta': {
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
    case 'openwa': {
      // Same six kinds as Whapi, voice notes and stickers included.
      const res = await openwa.sendMediaMessage({
        ...openwaCredentials(channel),
        idempotencyKey: args.idempotencyKey,
        to,
        kind,
        link,
        caption,
        filename,
        quotedMessageId,
      });
      return { messageId: res.messageId, provider: 'openwa' };
    }
    default:
      return unknownProvider(channel.provider);
  }
}

export interface SendTemplateArgs {
  /**
   * OpenWA only: stable for one logical send, so a retry of it carries
   * the same `Idempotency-Key` (`openwaSendKey`). Whapi and Meta ignore it.
   */
  idempotencyKey?: string;
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
  const { channel, to, bodyParams = [], quotedMessageId } = args;
  // A media header is fetched by the gateway too, from whichever of these
  // the provider reads: each of our chat-media links is signed for this
  // send. Text headers and other links pass through unchanged.
  const headerMediaUrl = args.headerMediaUrl
    ? await gatewayMediaLink(args.headerMediaUrl)
    : args.headerMediaUrl;
  const template = await withSignedHeaderLinks(args.template);
  const messageParams = await withSignedParamsLink(args.messageParams);

  switch (channel.provider) {
    case 'whapi': {
      const res = await whapi.sendTemplateMessage({
        token: channel.accessToken,
        to,
        template: renderedForLinkedDevice(template, messageParams),
        bodyParams,
        headerMediaUrl,
        quotedMessageId,
      });
      return { messageId: res.messageId, provider: 'whapi' };
    }
    case 'meta': {
      // The per-send media override is a top-level arg here because it is
      // the one structured value both providers honour; Meta wants it
      // inside `messageParams`, so fold it in. Every caller (broadcast
      // route, broadcast-core, send-message, automations) passes
      // `headerMediaUrl` and nobody passes `messageParams`, so leaving it
      // out silently dropped the URL the admin chose in the wizard and
      // every recipient of a video/image template synced from Meta (no
      // `header_media_url` on the row) failed with "requires a media link".
      const metaParams: meta.SendTemplateMessageArgs['messageParams'] = {
        ...((messageParams as meta.SendTemplateMessageArgs['messageParams']) ??
          {}),
      };
      if (headerMediaUrl && !metaParams.headerMediaUrl) {
        metaParams.headerMediaUrl = headerMediaUrl;
      }
      const res = await meta.sendTemplateMessage({
        phoneNumberId: channel.phoneNumberId,
        accessToken: channel.accessToken,
        to,
        templateName: template.name,
        language: template.language,
        params: bodyParams,
        template,
        messageParams: metaParams,
        contextMessageId: quotedMessageId ?? undefined,
      });
      return { messageId: res.messageId, provider: 'meta' };
    }
    case 'openwa': {
      // Rendered locally like Whapi; of `messageParams` (Meta's registry
      // shape) only the header's value has a place here.
      const res = await openwa.sendTemplateMessage({
        ...openwaCredentials(channel),
        idempotencyKey: args.idempotencyKey,
        to,
        template: renderedForLinkedDevice(template, messageParams),
        bodyParams,
        headerMediaUrl,
        quotedMessageId,
      });
      return { messageId: res.messageId, provider: 'openwa' };
    }
    default:
      return unknownProvider(channel.provider);
  }
}

async function withSignedHeaderLinks(
  template: MessageTemplate
): Promise<MessageTemplate> {
  const row = template as MessageTemplate & {
    header_media_url?: string | null;
    header_content?: string | null;
  };
  const media = row.header_media_url
    ? await gatewayMediaLink(row.header_media_url)
    : row.header_media_url;
  const content = row.header_content
    ? await gatewayMediaLink(row.header_content)
    : row.header_content;
  if (media === row.header_media_url && content === row.header_content)
    return template;
  return { ...row, header_media_url: media, header_content: content };
}

async function withSignedParamsLink(params: unknown): Promise<unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params))
    return params;
  const p = params as { headerMediaUrl?: unknown };
  if (typeof p.headerMediaUrl !== 'string' || !p.headerMediaUrl) return params;
  const signed = await gatewayMediaLink(p.headerMediaUrl);
  return signed === p.headerMediaUrl
    ? params
    : { ...p, headerMediaUrl: signed };
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
  /**
   * OpenWA only: stable for one logical send, so a retry of it carries
   * the same `Idempotency-Key` (`openwaSendKey`). Whapi and Meta ignore it.
   */
  idempotencyKey?: string;
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

  switch (channel.provider) {
    case 'whapi': {
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
    case 'meta': {
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
    case 'openwa': {
      // The client sends these as numbered text options.
      const res = await openwa.sendInteractiveButtons({
        ...openwaCredentials(channel),
        idempotencyKey: args.idempotencyKey,
        to,
        bodyText,
        headerText,
        footerText,
        buttons,
        quotedMessageId,
      });
      return { messageId: res.messageId, provider: 'openwa' };
    }
    default:
      return unknownProvider(channel.provider);
  }
}

export interface SendInteractiveListArgs {
  /**
   * OpenWA only: stable for one logical send, so a retry of it carries
   * the same `Idempotency-Key` (`openwaSendKey`). Whapi and Meta ignore it.
   */
  idempotencyKey?: string;
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

  switch (channel.provider) {
    case 'whapi': {
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
    case 'meta': {
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
    case 'openwa': {
      // Numbered text options, like the buttons; `buttonLabel` is unused.
      const res = await openwa.sendInteractiveList({
        ...openwaCredentials(channel),
        idempotencyKey: args.idempotencyKey,
        to,
        bodyText,
        buttonLabel,
        headerText,
        footerText,
        sections,
        quotedMessageId,
      });
      return { messageId: res.messageId, provider: 'openwa' };
    }
    default:
      return unknownProvider(channel.provider);
  }
}

export interface SendReactionArgs {
  channel: WhatsAppChannel;
  /**
   * Required by Meta and OpenWA, ignored by Whapi (the target id
   * identifies the chat).
   */
  to: string;
  targetMessageId: string;
  /** Single emoji, or an empty string to remove an existing reaction. */
  emoji: string;
}

export async function sendReaction(
  args: SendReactionArgs
): Promise<ProviderSendResult> {
  const { channel, to, targetMessageId, emoji } = args;

  switch (channel.provider) {
    case 'whapi': {
      const res = await whapi.sendReactionMessage({
        token: channel.accessToken,
        targetMessageId,
        emoji,
      });
      return { messageId: res.messageId, provider: 'whapi' };
    }
    case 'meta': {
      const res = await meta.sendReactionMessage({
        phoneNumberId: channel.phoneNumberId,
        accessToken: channel.accessToken,
        to,
        targetMessageId,
        emoji,
      });
      return { messageId: res.messageId, provider: 'meta' };
    }
    case 'openwa': {
      const res = await openwa.sendReactionMessage({
        ...openwaCredentials(channel),
        to,
        targetMessageId,
        emoji,
      });
      return { messageId: res.messageId, provider: 'openwa' };
    }
    default:
      return unknownProvider(channel.provider);
  }
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
 *   * OpenWA serves stored media by (chat, message); its media id is
 *     the pair (`toOpenWAMediaId`) and the URL is built without a call.
 *
 * Either way the resulting URL is short-lived, which is what
 * `mirrorInboundMedia` exists to fix.
 */
export async function getMediaUrl(args: {
  channel: WhatsAppChannel;
  mediaId: string;
}): Promise<{ url: string; mimeType: string; fileSize: number | null }> {
  const { channel, mediaId } = args;

  switch (channel.provider) {
    case 'whapi':
      return whapi.getMediaUrl({ token: channel.accessToken, mediaId });
    case 'meta':
      return meta.getMediaUrl({ mediaId, accessToken: channel.accessToken });
    case 'openwa':
      return openwa.getMediaUrl({ sessionId: channel.phoneNumberId, mediaId });
    default:
      return unknownProvider(channel.provider);
  }
}

/**
 * Download media bytes the gateway is hosting.
 *
 * Every gateway requires the account's own credential on the download
 * URL, which is why this cannot be a bare `fetch` at the call site.
 */
export async function downloadMedia(args: {
  channel: WhatsAppChannel;
  downloadUrl: string;
  /** The caller's own limit: past it, `BodyTooLargeError`. */
  maxBytes: number;
}): Promise<{ buffer: Buffer; contentType: string }> {
  const { channel, downloadUrl, maxBytes } = args;

  switch (channel.provider) {
    case 'whapi':
      return whapi.downloadMedia({
        downloadUrl,
        token: channel.accessToken,
        maxBytes,
      });
    case 'meta':
      return meta.downloadMedia({
        downloadUrl,
        accessToken: channel.accessToken,
        maxBytes,
      });
    case 'openwa':
      return openwa.downloadMedia({
        ...openwaCredentials(channel),
        downloadUrl,
        maxBytes,
      });
    default:
      return unknownProvider(channel.provider);
  }
}

/** How long a streamed attachment may take, start to end. */
const STREAM_HEADERS_MS = 30_000;
const STREAM_TOTAL_MS = 5 * 60_000;

/**
 * `downloadMedia` for bytes that are passed straight on: nothing is held
 * in memory, and the stream errors past `maxBytes`.
 */
export async function streamMedia(args: {
  channel: WhatsAppChannel;
  downloadUrl: string;
  maxBytes: number;
}): Promise<{
  body: ReadableStream<Uint8Array> | null;
  contentType: string | null;
  contentLength: number | null;
}> {
  const { channel, downloadUrl, maxBytes } = args;
  const { signal, started } = streamDeadline(
    STREAM_HEADERS_MS,
    STREAM_TOTAL_MS
  );
  const common = { downloadUrl, maxBytes, signal };
  const open = (): Promise<Response> => {
    switch (channel.provider) {
      case 'whapi':
        return whapi.openMedia({ ...common, token: channel.accessToken });
      case 'meta':
        return meta.openMedia({ ...common, accessToken: channel.accessToken });
      case 'openwa':
        return openwa.openMedia({ ...common, ...openwaCredentials(channel) });
      default:
        return unknownProvider(channel.provider);
    }
  };
  try {
    const response = await open();
    return {
      ...(await streamCapped(response, maxBytes)),
      contentType: response.headers.get('content-type'),
    };
  } finally {
    started();
  }
}

/** A profile lookup runs per contact in the inbox; don't let one hang a batch. */
const PROFILE_TIMEOUT_MS = 10_000;

/**
 * The URL of a contact's WhatsApp profile picture, or null when there
 * is none to show (none set, or hidden by their privacy settings).
 *
 * Linked-device numbers only (Whapi, OpenWA): the Cloud API has no
 * profile-picture endpoint, so a Meta number always answers null. The
 * URL is a WhatsApp CDN link that expires — copy the bytes
 * (`contact-avatars.ts`), never store it.
 *
 * Throws the gateway's error on anything but "no picture", so the
 * caller can tell a transient failure from a real absence.
 */
export async function getContactProfilePicture(
  channel: WhatsAppChannel,
  phone: string
): Promise<string | null> {
  switch (channel.provider) {
    case 'whapi': {
      const profile = await whapi.getContactProfile({
        token: channel.accessToken,
        contactId: phone,
        timeoutMs: PROFILE_TIMEOUT_MS,
      });
      return profile?.iconFull ?? profile?.icon ?? null;
    }
    case 'meta':
      return null;
    case 'openwa':
      return openwa.getContactProfilePicture({
        ...openwaCredentials(channel),
        contactId: phone,
        timeoutMs: PROFILE_TIMEOUT_MS,
      });
    default:
      return unknownProvider(channel.provider);
  }
}

// ============================================================
// Channel health
// ============================================================

/** What a probe says about a number. The gateway's own words, never mapped. */
export interface ChannelProbe {
  /**
   * Whapi: `AUTH` means paired and able to send; see
   * `describeChannelStatus`. OpenWA: `ready` (`OpenWASessionStatus`).
   */
  status: string;
  authorized: boolean;
  /** Digits of the paired number; null while nothing is paired. */
  phone: string | null;
}

/** Short enough that a probe after a failed send doesn't keep a user waiting. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Ask the gateway whether a number is live, without changing anything.
 *
 * Linked-device numbers only: their session can be logged out on the
 * phone while the token stays valid, so the token alone says nothing
 * about whether a send will work. Whapi gets `wakeup: false` because a
 * status check must never launch a channel an operator deliberately
 * stopped; OpenWA's session read is a plain GET that starts nothing.
 * Meta has no session to lose — a Cloud API number is up as long as its
 * token is — so there is nothing to probe and this returns null.
 *
 * Throws the gateway's error, so the caller can tell a refused token
 * (401/403/404) from a gateway that is merely unreachable (503).
 */
export async function probeChannel(
  channel: WhatsAppChannel
): Promise<ChannelProbe | null> {
  switch (channel.provider) {
    case 'whapi': {
      const info = await whapi.getChannelInfo({
        token: channel.accessToken,
        wakeup: false,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      return {
        status: info.status,
        authorized: info.authorized,
        phone: info.phone,
      };
    }
    case 'meta':
      return null;
    case 'openwa': {
      const session = await openwa.getSession({
        ...openwaCredentials(channel),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      // Verbatim: the health check maps OpenWA's words itself.
      return {
        status: session.status,
        authorized: session.status === 'ready',
        phone: session.phone,
      };
    }
    default:
      return unknownProvider(channel.provider);
  }
}

/**
 * Whapi's Safety Meter for a number: its own 1-3 rating of the risk of
 * WhatsApp restricting it (overall, number age, response rate, address
 * book coverage). Meta numbers have no such meter (their quality
 * rating lives in the WhatsApp Manager) and get null, as do OpenWA
 * numbers (the gateway has no meter). `recalculate` asks Whapi to
 * compute it afresh, which it does at most once a day.
 *
 * Throws the gateway's error; the figures never include the token the
 * meter echoes back.
 */
export async function getNumberSafetyRating(
  channel: WhatsAppChannel,
  opts: { recalculate?: boolean; timeoutMs?: number } = {}
): Promise<whapi.WhapiRiskOfBlocking | null> {
  switch (channel.provider) {
    case 'whapi':
      return whapi.getRiskOfBlocking({
        token: channel.accessToken,
        recalculate: opts.recalculate,
        timeoutMs: opts.timeoutMs ?? 10_000,
      });
    case 'meta':
    case 'openwa':
      return null;
    default:
      return unknownProvider(channel.provider);
  }
}

// ============================================================
// Failure interpretation
// ============================================================

/**
 * True when a send failed because of the *number*, not the recipient:
 * the next send from the same channel will fail the same way until
 * someone fixes the channel (re-pairs the phone, replaces the token,
 * renews the subscription).
 *
 * A fan-out loop uses this to stop instead of burning one gateway call
 * — and one permanently "failed" recipient — per remaining row. Read
 * off the raw error, never the `describeSendFailure` wording.
 *
 * True only of failures `isDefiniteSendRefusal` agrees on: the caller
 * leaves the recipient to be sent to again.
 */
export function isChannelLevelFailure(err: unknown): boolean {
  // Whoever the recipient is, the gateway cannot be reached.
  if (neverConnected(err)) return true;
  if (err instanceof whapi.WhapiError) {
    return err.isAuthError || err.isUnknownChannel || err.isBillingError;
  }
  if (err instanceof meta.MetaError) {
    return err.isAuthError || err.isNumberUnavailable;
  }
  if (err instanceof openwa.OpenWAError) {
    // The pacing governor is per number, so the next send refuses too.
    return (
      err.isAuthError ||
      err.isSessionNotFound ||
      err.isSessionNotConnected ||
      err.isPacingLimited
    );
  }
  return false;
}

/**
 * True when the gateway itself answered 503: the number cannot send right
 * now, but whether this one message went out is not known. A fan-out stops
 * here too, without ever repeating the recipient it was at. Not our own
 * 503 for a missing answer (it has a `cause`): one slow media link makes
 * that timeout.
 */
export function isGatewayUnavailable(err: unknown): boolean {
  return (
    (err instanceof whapi.WhapiError || err instanceof openwa.OpenWAError) &&
    err.status === 503 &&
    err.cause === undefined
  );
}

/**
 * True only when a failed send certainly did not go out: the gateway
 * answered with a 4xx refusal (a Whapi 401/403/404/402, a Meta error
 * code), or the Whapi client refused it before making a request (a
 * missing token or link is a WhapiError 401/400), or the connection to
 * the gateway never opened (`neverConnected`: DNS, a refused connection,
 * a certificate), on any of the three. Sending it again cannot reach the
 * customer twice.
 *
 * Everything else leaves open whether the message was delivered, so it
 * is false:
 *
 *   - the synthetic statuses the clients give a missing answer: Whapi's
 *     503 for a lost connection or a timeout, Meta's 504 for a timeout.
 *     The gateway may have sent the message before we stopped waiting,
 *     which is likely for media, since it fetches the link first.
 *   - Whapi's 502 for "accepted but returned no message id", where the
 *     message certainly went out.
 *   - a gateway 5xx, and 408, which is also a timeout.
 *   - any other error: a SyntaxError from a 2xx body that is not JSON,
 *     Meta's lost connections (rethrown unwrapped), and the Meta client's
 *     own checks on media and interactive sends, which throw a plain
 *     Error. Those last ones are safe in fact, but nothing tells them
 *     apart from the others.
 *
 * The Meta template builder's own checks are the exception: they throw
 * TemplateParamError, before any request, so they count as refusals.
 *
 * OpenWA follows the same rule: its 409 ("engine not ready") and 429
 * (pacing) are refusals before anything was sent, while its synthetic
 * 503 (lost connection, timeout) and 502 (no message id) are not, nor is
 * the 409 of a send cut short, which says it may have been sent, nor
 * its Idempotency-Key answers: 409 IDEMPOTENCY_KEY_IN_PROGRESS /
 * IDEMPOTENCY_OUTCOME_UNKNOWN (unconfirmed, like a timeout) and 422
 * IDEMPOTENCY_KEY_REUSED (the key's first send went out).
 *
 * A retry decision reads this. Read off the raw error, never the
 * `describeSendFailure` wording.
 */
export function isDefiniteSendRefusal(err: unknown): boolean {
  if (neverConnected(err)) return true;
  if (err instanceof openwa.OpenWAError && err.mayHaveBeenSent) return false;
  // Idempotency-Key answers: unknown is a timeout, reused means it went out.
  if (
    err instanceof openwa.OpenWAError &&
    (err.isIdempotencyOutcomeUnknown || err.isIdempotencyKeyReused)
  ) {
    return false;
  }
  if (
    err instanceof whapi.WhapiError ||
    err instanceof meta.MetaError ||
    err instanceof openwa.OpenWAError
  ) {
    return err.status >= 400 && err.status < 500 && err.status !== 408;
  }
  return err instanceof TemplateParamError;
}

/**
 * Turn a gateway failure into something an operator can act on.
 *
 * Every error class carries `status` and capability getters, but the
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
    if (error.isMissingParameter) {
      return (
        // Neutral on purpose: this reaches the inbox, automations and
        // the public v1 API, not only broadcasts (whose Personalize step
        // warns about blanks and offers a fallback before sending).
        'Meta rejected the send because a template value is missing or blank (#131008) — Meta rejects blank template values.'
      );
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
      // Not "the token is invalid": a phone logged out of WhatsApp makes
      // the same valid token answer 401/403 on every send, and telling
      // an admin to re-save it sends them to the wrong fix (see
      // `explainSendFailure` for the probed, exact wording).
      return (
        `Whapi refused to send from this number (${whapiRefusal(error)}) — ` +
        'usually the phone was logged out; an admin should check Settings → Numbers & access.'
      );
    }
    if (error.isBillingError) {
      return 'The Whapi subscription has lapsed. Renew it to resume sending.';
    }
    return error.message;
  }

  if (error instanceof openwa.OpenWAError) {
    if (error.isAuthError || error.isSessionNotFound) {
      return (
        "OpenWA no longer accepts this number's key or the session was " +
        'deleted; reconnect it in Settings → WhatsApp.'
      );
    }
    if (error.isPacingLimited) {
      const minutes =
        error.retryAfterSeconds && error.retryAfterSeconds > 0
          ? Math.ceil(error.retryAfterSeconds / 60)
          : null;
      // One refusal covers three limits (the daily allowance, the cap on
      // first messages to new chats, and the repeated-failure breaker),
      // so name none of them in particular.
      return (
        "OpenWA's sending limits for this number have been reached; " +
        (minutes ? `retry in about ${minutes} minutes.` : 'retry later.')
      );
    }
    if (error.isIdempotencyKeyReused) {
      return (
        'OpenWA already sent this message once, so it was not sent again; ' +
        'check the chat before sending it another time.'
      );
    }
    if (error.isIdempotencyOutcomeUnknown) {
      return (
        'OpenWA could not confirm whether this message was sent; check the ' +
        'chat before sending it again.'
      );
    }
    if (error.isNotReady || error.isSessionNotConnected) {
      return (
        'The OpenWA number is not connected to WhatsApp right now (starting, ' +
        'or logged out on the phone); an admin should check Settings → WhatsApp.'
      );
    }
    if (error.isNotSupported) {
      return `That is not available on OpenWA numbers: ${error.message}`;
    }
    return error.message;
  }

  return error instanceof Error ? error.message : String(error);
}

/** `HTTP 401: <Whapi's own message>` — kept so the next incident is legible. */
function whapiRefusal(error: whapi.WhapiError): string {
  return error.message
    ? `HTTP ${error.status}: ${error.message}`
    : `HTTP ${error.status}`;
}

/** `+971…` from a Whapi row's display number, when it has one. */
function whapiNumber(channel: WhatsAppChannel): string | null {
  const digits = (channel.wabaId ?? '').replace(/\D/g, '');
  return digits ? `+${digits}` : null;
}

/**
 * `describeSendFailure`, made exact for the cases where the gateway's
 * answer is ambiguous: a Whapi 401/403, or an OpenWA "not ready" /
 * auth refusal.
 *
 * The same refusal means three different things with three different
 * fixes — the phone was logged out (re-scan the QR on the phone; the
 * token is fine), the channel is still starting or syncing (wait), or
 * the token really was revoked (paste the new one in Settings). One
 * short probe tells them apart. It runs only after a send has already
 * failed, never on the happy path, and a probe that errors falls back
 * to the neutral wording rather than guessing.
 */
export async function explainSendFailure(
  error: unknown,
  channel: WhatsAppChannel
): Promise<string> {
  switch (channel.provider) {
    case 'whapi':
      return explainWhapiFailure(error, channel);
    case 'meta':
      return describeSendFailure(error);
    case 'openwa':
      return explainOpenWAFailure(error, channel);
    default:
      return unknownProvider(channel.provider);
  }
}

async function explainOpenWAFailure(
  error: unknown,
  channel: WhatsAppChannel
): Promise<string> {
  if (
    !(error instanceof openwa.OpenWAError) ||
    !(error.isNotReady || error.isAuthError || error.isSessionNotFound)
  ) {
    return describeSendFailure(error);
  }

  let probe: ChannelProbe | null;
  try {
    probe = await probeChannel(channel);
  } catch {
    return describeSendFailure(error);
  }
  if (!probe) return describeSendFailure(error);

  const status = probe.status as openwa.OpenWASessionStatus;
  if (status === 'ready') {
    return (
      `OpenWA refused the send (HTTP ${error.status}: ${error.message}); ` +
      'the number reports connected. Retry in a minute.'
    );
  }
  if (
    status === 'qr_ready' ||
    status === 'disconnected' ||
    status === 'failed'
  ) {
    return (
      `This number (${describeChannel(channel)}) is logged out of WhatsApp — ` +
      're-link it by scanning the QR in Settings → WhatsApp.'
    );
  }
  if (status === 'initializing' || status === 'authenticating') {
    return (
      `This number (${describeChannel(channel)}) is still starting up ` +
      `(status ${probe.status}). Retry in a minute.`
    );
  }
  // `created`, `action_required` and words OpenWA may add later.
  return (
    `This number (${describeChannel(channel)}) is not connected to WhatsApp ` +
    `(status ${probe.status}); an admin should check Settings → WhatsApp.`
  );
}

async function explainWhapiFailure(
  error: unknown,
  channel: WhatsAppChannel
): Promise<string> {
  if (!(error instanceof whapi.WhapiError) || !error.isAuthError) {
    return describeSendFailure(error);
  }

  let probe: ChannelProbe | null;
  try {
    probe = await probeChannel(channel);
  } catch (probeError) {
    if (
      probeError instanceof whapi.WhapiError &&
      (probeError.isAuthError || probeError.isUnknownChannel)
    ) {
      return (
        `Whapi no longer accepts the token for ${describeChannel(channel)} ` +
        `(HTTP ${probeError.status}): it was revoked or the channel was deleted. ` +
        'An admin must paste the current channel token in Settings → WhatsApp.'
      );
    }
    return describeSendFailure(error);
  }
  if (!probe) return describeSendFailure(error);

  if (probe.status === 'AUTH') {
    return (
      `Whapi refused the send (${whapiRefusal(error)}); the number reports ` +
      'connected. Retry in a minute.'
    );
  }
  if (probe.status === 'QR') {
    const holder = whapiNumber(channel) ?? 'this number';
    return (
      `This number (${describeChannel(channel)}) is logged out of WhatsApp — ` +
      `whoever holds ${holder} must re-pair it by scanning the QR at ` +
      'panel.whapi.cloud (WhatsApp → Linked devices → Link a device). ' +
      'Do not re-save the token in Settings.'
    );
  }
  // LAUNCH/INIT are transitional (a channel starting or syncing after a
  // re-pair also refuses sends), so each state gets its own wording
  // rather than a blanket "logged out".
  return (
    `This number (${describeChannel(channel)}) is not connected to WhatsApp ` +
    `(status ${probe.status}): ` +
    whapi.describeChannelStatus(probe.status as whapi.WhapiChannelStatus)
  );
}
