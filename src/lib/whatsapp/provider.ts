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

import {
  describeChannel,
  type WhatsAppChannel,
  type WhatsAppProvider,
} from './channels';
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

/** A profile lookup runs per contact in the inbox; don't let one hang a batch. */
const PROFILE_TIMEOUT_MS = 10_000;

/**
 * The URL of a contact's WhatsApp profile picture, or null when there
 * is none to show (none set, or hidden by their privacy settings).
 *
 * Whapi only: the Cloud API has no profile-picture endpoint, so a Meta
 * number always answers null. The URL is a WhatsApp CDN link that
 * expires — copy the bytes (`contact-avatars.ts`), never store it.
 *
 * Throws the gateway's error on anything but "no picture", so the
 * caller can tell a transient failure from a real absence.
 */
export async function getContactProfilePicture(
  channel: WhatsAppChannel,
  phone: string
): Promise<string | null> {
  if (channel.provider !== 'whapi') return null;
  const profile = await whapi.getContactProfile({
    token: channel.accessToken,
    contactId: phone,
    timeoutMs: PROFILE_TIMEOUT_MS,
  });
  return profile?.iconFull ?? profile?.icon ?? null;
}

// ============================================================
// Channel health
// ============================================================

/** What a probe says about a number. Whapi's own words, never mapped. */
export interface ChannelProbe {
  /** `AUTH` means paired and able to send; see `describeChannelStatus`. */
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
 * Whapi only: its linked-device session can be logged out on the phone
 * while the token stays valid, so the token alone says nothing about
 * whether a send will work. `wakeup: false` because a status check must
 * never launch a channel an operator deliberately stopped. Meta has no
 * session to lose — a Cloud API number is up as long as its token is —
 * so there is nothing to probe and this returns null.
 *
 * Throws the gateway's error, so the caller can tell a refused token
 * (401/403/404) from a gateway that is merely unreachable (503).
 */
export async function probeChannel(
  channel: WhatsAppChannel
): Promise<ChannelProbe | null> {
  if (channel.provider !== 'whapi') return null;
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

/**
 * Whapi's Safety Meter for a number: its own 1-3 rating of the risk of
 * WhatsApp restricting it (overall, number age, response rate, address
 * book coverage). Meta numbers have no such meter (their quality
 * rating lives in the WhatsApp Manager) and get null. `recalculate`
 * asks Whapi to compute it afresh, which it does at most once a day.
 *
 * Throws the gateway's error; the figures never include the token the
 * meter echoes back.
 */
export async function getNumberSafetyRating(
  channel: WhatsAppChannel,
  opts: { recalculate?: boolean; timeoutMs?: number } = {}
): Promise<whapi.WhapiRiskOfBlocking | null> {
  if (channel.provider !== 'whapi') return null;
  return whapi.getRiskOfBlocking({
    token: channel.accessToken,
    recalculate: opts.recalculate,
    timeoutMs: opts.timeoutMs ?? 10_000,
  });
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
 */
export function isChannelLevelFailure(err: unknown): boolean {
  if (err instanceof whapi.WhapiError) {
    return err.isAuthError || err.isUnknownChannel || err.isBillingError;
  }
  if (err instanceof meta.MetaError) {
    return err.isAuthError;
  }
  return false;
}

/**
 * True only when a failed send certainly did not go out: the gateway
 * answered with a 4xx refusal (a Whapi 401/403/404/402, a Meta error
 * code), or the Whapi client refused it before making a request (a
 * missing token or link is a WhapiError 401/400). Sending it again
 * cannot reach the customer twice.
 *
 * Everything else leaves open whether the message was delivered, so it
 * is false:
 *
 *   - the synthetic statuses the clients give a missing answer: Whapi's
 *     503 for a network error or a timeout, Meta's 504 for a timeout.
 *     The gateway may have sent the message before we stopped waiting,
 *     which is likely for media, since it fetches the link first.
 *   - Whapi's 502 for "accepted but returned no message id", where the
 *     message certainly went out.
 *   - a gateway 5xx, and 408, which is also a timeout.
 *   - any other error: a SyntaxError from a 2xx body that is not JSON,
 *     Meta's network errors (rethrown unwrapped), and the Meta client's
 *     own checks, which throw a plain Error. Those last ones are safe in
 *     fact, but nothing tells them apart from the others.
 *
 * A retry decision reads this. Read off the raw error, never the
 * `describeSendFailure` wording.
 */
export function isDefiniteSendRefusal(err: unknown): boolean {
  if (err instanceof whapi.WhapiError || err instanceof meta.MetaError) {
    return err.status >= 400 && err.status < 500 && err.status !== 408;
  }
  return false;
}

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
    if (error.isMissingParameter) {
      return (
        'Meta rejected the send because a template value is missing or blank (#131008) — Meta rejects blank values. ' +
        'In a broadcast, set an "If empty, use" fallback for each variable in the Personalize step.'
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
 * `describeSendFailure`, made exact for the one case where the gateway's
 * answer is ambiguous: a Whapi 401/403.
 *
 * The same refusal means three different things with three different
 * fixes — the phone was logged out (re-scan the QR on the phone; the
 * token is fine), the channel is still starting or syncing (wait), or
 * the token really was revoked (paste the new one in Settings). One
 * short `/health` probe tells them apart. It runs only after a send has
 * already failed, never on the happy path, and a probe that errors
 * falls back to the neutral wording rather than guessing.
 */
export async function explainSendFailure(
  error: unknown,
  channel: WhatsAppChannel
): Promise<string> {
  if (
    channel.provider !== 'whapi' ||
    !(error instanceof whapi.WhapiError) ||
    !error.isAuthError
  ) {
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
