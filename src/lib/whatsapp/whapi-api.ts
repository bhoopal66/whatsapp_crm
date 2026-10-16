/**
 * Whapi.Cloud WhatsApp gateway helpers.
 *
 * This module replaces the former Meta Cloud API client (`meta-api.ts`).
 * The shape of the exported functions is deliberately unchanged in
 * spirit — every function takes a single options object (named
 * parameters) rather than positional arguments, for the same reason the
 * Meta client did: a swapped pair of opaque strings is a runtime
 * rejection, whereas a mistyped property name is a compile error.
 *
 * ─── How Whapi differs from Meta Cloud API ────────────────────────
 *
 *  * **One token, one number.** Meta needed a `(phone_number_id,
 *    access_token)` pair plus a WABA id. A Whapi *channel* is the unit
 *    of connection: the channel token alone identifies both the gateway
 *    account and the WhatsApp number behind it. There is nothing to
 *    "register" or "subscribe" — a channel that is authorised (a phone
 *    paired via QR, or a mobile channel) is live.
 *
 *  * **No template approval.** Meta gated free-form sends behind a
 *    24-hour window and required pre-approved HSM templates outside it.
 *    Whapi channels ride a real WhatsApp account, so every send is
 *    free-form. The CRM's `message_templates` rows are still honoured —
 *    they are rendered locally into text/media and sent as ordinary
 *    messages. See `sendTemplateMessage` below.
 *
 *  * **Webhooks are configured over the API, not in a dashboard.**
 *    `PATCH /settings` sets the callback URL and the event list. There
 *    is no `hub.challenge` handshake and no `X-Hub-Signature-256`; we
 *    authenticate inbound callbacks with a per-channel shared secret
 *    carried in the URL (see `buildWebhookUrl`).
 *
 *  * **Recipients are chat ids.** Whapi addresses a conversation by
 *    `<digits>@s.whatsapp.net` (or a bare digit string, which the
 *    gateway normalises). It does NOT accept a leading `+`.
 *
 * API reference: https://whapi.readme.io/reference
 */

import type { MessageTemplate } from '@/types'

import { renderTemplateBody } from './template-body'
import { fetchPublicUrl, UnsafeUrlError } from '@/lib/webhooks/ssrf'

// ============================================================
// Transport
// ============================================================

/**
 * Whapi's gateway host. Overridable so a self-hosted/on-prem Whapi
 * deployment (they ship one) can be pointed at without a code change,
 * and so tests can aim at a local stub.
 */
export const WHAPI_BASE_URL = (
  process.env.WHAPI_BASE_URL || 'https://gate.whapi.cloud'
).replace(/\/+$/, '')

/** Per-request ceiling. Whapi is usually <1s; a hung socket must not pin a route. */
const WHAPI_TIMEOUT_MS = Number(process.env.WHAPI_TIMEOUT_MS || 30_000)

/**
 * A failed Whapi call. `status` is the HTTP status and `code` is
 * Whapi's own numeric error code when present, so callers can branch
 * on a specific failure (e.g. 401 → token revoked → mark the channel
 * disconnected) without string-matching a message.
 */
export class WhapiError extends Error {
  readonly status: number
  readonly code: number | null
  readonly details: string | null

  constructor(
    message: string,
    status: number,
    code: number | null = null,
    details: string | null = null,
  ) {
    super(message)
    this.name = 'WhapiError'
    this.status = status
    this.code = code
    this.details = details
  }

  /** True when the channel token is missing, wrong, or revoked. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403
  }

  /** True when the Whapi subscription lapsed (402 Payment Required). */
  get isBillingError(): boolean {
    return this.status === 402
  }

  /**
   * True when the gateway does not recognise the token at all.
   *
   * Whapi answers an unknown/typo'd channel token with **404 "Service
   * not found"**, not 401 — the token is what selects the channel, so
   * a wrong one addresses a channel that doesn't exist. Without this,
   * the single most common setup mistake surfaces as a baffling
   * "Service not found".
   */
  get isUnknownChannel(): boolean {
    return this.status === 404
  }

  /**
   * On a group call: our number is not an admin of the group. Whapi
   * documents 403 "You do not have permissions for this action" on
   * every admin-only group endpoint (update, settings, participants,
   * admins, icon, invite). Outside a group call a 403 is the ambiguous
   * auth failure `isAuthError` covers, so only read this after one.
   */
  get isNotGroupAdmin(): boolean {
    return this.status === 403
  }

  /**
   * On a group call: the group id is unknown to this number (never a
   * member, or removed). Same 404 as `isUnknownChannel`; Whapi cannot
   * tell the two apart, so trust it only on a number known to be live.
   */
  get isGroupNotFound(): boolean {
    return this.status === 404
  }

  /** Add participants: 409 "Specified participant already in group". */
  get isAlreadyParticipant(): boolean {
    return this.status === 409
  }

  /** 429 "Too many requests", documented on create group and invites. */
  get isRateLimited(): boolean {
    return this.status === 429
  }
}

interface WhapiErrorBody {
  error?: { code?: number; message?: string; details?: string }
}

async function throwWhapiError(
  response: Response,
  fallback: string,
): Promise<never> {
  let message = fallback
  let code: number | null = null
  let details: string | null = null
  try {
    const data = (await response.json()) as WhapiErrorBody
    if (data.error?.message) message = data.error.message
    if (typeof data.error?.code === 'number') code = data.error.code
    if (data.error?.details) details = data.error.details
  } catch {
    // Body wasn't JSON (a proxy 502 page, an empty 504) — keep the fallback.
  }
  throw new WhapiError(message, response.status, code, details)
}

interface WhapiRequestArgs {
  token: string
  path: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  /** Overrides WHAPI_TIMEOUT_MS for this call. */
  timeoutMs?: number
  /** Another Whapi host for this call (the tools service); the gate by default. */
  baseUrl?: string
}

/**
 * Single choke point for every Whapi call: auth header, JSON encoding,
 * timeout, and uniform error mapping. Everything else in this file is
 * a thin, typed wrapper over it.
 */
async function whapiRequest<T = unknown>(args: WhapiRequestArgs): Promise<T> {
  const response = await whapiFetch(args)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/**
 * The transport half of `whapiRequest`: an OK `Response`, unparsed.
 * Only for the few endpoints that answer with bytes (a group icon);
 * everything JSON goes through `whapiRequest`.
 */
async function whapiFetch(args: WhapiRequestArgs): Promise<Response> {
  const { token, path, method = 'GET', body, query, timeoutMs, baseUrl } = args

  if (!token) {
    throw new WhapiError('Missing Whapi channel token.', 401)
  }

  const url = new URL(`${baseUrl ?? WHAPI_BASE_URL}${path}`)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let response: Response
  try {
    response = await fetch(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs ?? WHAPI_TIMEOUT_MS),
    })
  } catch (err) {
    // Network-level failure (DNS, TLS, timeout). Surface as a 503-ish
    // WhapiError so callers have one error type to catch.
    const reason = err instanceof Error ? err.message : String(err)
    throw new WhapiError(`Whapi request failed: ${reason}`, 503)
  }

  if (!response.ok) {
    await throwWhapiError(response, `Whapi API error: ${response.status}`)
  }

  return response
}

// ============================================================
// Recipient / chat-id helpers
// ============================================================

/**
 * WhatsApp's JID suffix for a 1:1 chat. Groups use `@g.us` and
 * channels `@newsletter`; the CRM only addresses individuals, but a
 * caller that already holds a full chat id (from a webhook) can pass
 * it straight through — see `toWhapiRecipient`.
 */
const INDIVIDUAL_CHAT_SUFFIX = '@s.whatsapp.net'

/**
 * Normalise whatever the CRM stores for a contact into something Whapi
 * accepts as `to`.
 *
 * The CRM stores E.164 with a leading `+`. Whapi wants bare digits or a
 * full chat id; a `+` is rejected by the `to` pattern. An id that
 * already carries a JID suffix (`…@s.whatsapp.net`, `…@g.us`) is passed
 * through untouched so group sends and webhook round-trips keep working.
 */
export function toWhapiRecipient(phoneOrChatId: string): string {
  const value = String(phoneOrChatId).trim()
  if (value.includes('@')) return value
  return value.replace(/\D/g, '')
}

/** `919984351847@s.whatsapp.net` → `919984351847`. Idempotent on bare digits. */
export function chatIdToPhone(chatId: string): string {
  return String(chatId).split('@')[0].replace(/\D/g, '')
}

/** Bare digits → `919984351847@s.whatsapp.net`. Idempotent on full chat ids. */
export function phoneToChatId(phone: string): string {
  const digits = toWhapiRecipient(phone)
  if (digits.includes('@')) return digits
  return `${digits}${INDIVIDUAL_CHAT_SUFFIX}`
}

/**
 * Whapi rejects a `quoted` id that doesn't match its message-id
 * pattern. Rather than 400 the whole send because a reply target came
 * from an older Meta-era row, drop a malformed quote and send the
 * message unquoted — losing the quote preview beats losing the message.
 */
const WHAPI_MESSAGE_ID = /^[A-Za-z0-9._]{4,23}-[A-Za-z0-9._]{4,14}(-[A-Za-z0-9._]{4,10})?(-[A-Za-z0-9._]{4,10})?$/

export function isWhapiMessageId(id: string | null | undefined): boolean {
  return typeof id === 'string' && WHAPI_MESSAGE_ID.test(id)
}

function applyQuote(
  body: Record<string, unknown>,
  quotedMessageId?: string | null,
): void {
  if (isWhapiMessageId(quotedMessageId)) {
    body.quoted = quotedMessageId
  } else if (quotedMessageId) {
    console.warn(
      '[whapi] dropping unusable quoted message id, sending unquoted:',
      quotedMessageId,
    )
  }
}

// ============================================================
// Send results
// ============================================================

export interface WhapiSendResult {
  /** WhatsApp's message id — persisted as `messages.message_id`. */
  messageId: string
}

/** Whapi's `201 { sent, message: { id, ... } }` envelope. */
interface WhapiSentEnvelope {
  sent?: boolean
  message?: { id?: string }
  /** Some endpoints echo the id at the top level instead. */
  id?: string
}

function readSentMessageId(data: WhapiSentEnvelope, context: string): string {
  const id = data.message?.id ?? data.id
  if (!id) {
    throw new WhapiError(
      `Whapi accepted the ${context} but returned no message id.`,
      502,
    )
  }
  return id
}

// ============================================================
// Channel health / identity
// ============================================================

export type WhapiChannelStatus =
  | 'NOT_INIT'
  | 'INIT'
  | 'LAUNCH'
  | 'QR'
  | 'AUTH'
  | 'ERROR'

export interface WhapiChannelInfo {
  /** Whapi's own status code + text (`AUTH` means live and paired). */
  status: WhapiChannelStatus
  statusCode: number
  /** True only when the channel is authorised and can send. */
  authorized: boolean
  /** The connected WhatsApp number, digits only. Null before pairing. */
  phone: string | null
  /** Display name on the WhatsApp account (pushname / business name). */
  displayName: string | null
  /** Whapi channel software version. */
  version: string | null
  /** Seconds since the channel process started. */
  uptime: number | null
}

interface WhapiHealthResponse {
  status?: { code?: number; text?: string }
  version?: string
  uptime?: number
  user?: { id?: string; name?: string; pushname?: string }
}

export interface GetChannelInfoArgs {
  token: string
  /**
   * Whapi *launches* a stopped channel on `GET /health` by default.
   * Pass `false` for a pure read (e.g. a background health probe) so a
   * deliberately-stopped channel isn't woken up by a status check.
   */
  wakeup?: boolean
  /**
   * A probe that runs while a user waits on a failed send (or once per
   * channel in a cron tick) must not hang for the full 30s default.
   */
  timeoutMs?: number
}

/**
 * Verify a channel token and read the connected number's identity.
 *
 * This is the Whapi equivalent of Meta's `verifyPhoneNumber` — it's what
 * "Test connection" in Settings calls, and what the config route uses to
 * decide whether a saved token is still good.
 */
export async function getChannelInfo(
  args: GetChannelInfoArgs,
): Promise<WhapiChannelInfo> {
  const { token, wakeup = true, timeoutMs } = args
  const data = await whapiRequest<WhapiHealthResponse>({
    token,
    path: '/health',
    query: { wakeup },
    timeoutMs,
  })

  const statusText = (data.status?.text || 'NOT_INIT') as WhapiChannelStatus
  const rawId = data.user?.id || null

  return {
    status: statusText,
    statusCode: typeof data.status?.code === 'number' ? data.status.code : -1,
    authorized: statusText === 'AUTH',
    phone: rawId ? chatIdToPhone(rawId) || null : null,
    displayName: data.user?.pushname || data.user?.name || null,
    version: data.version ?? null,
    uptime: typeof data.uptime === 'number' ? data.uptime : null,
  }
}

// ============================================================
// Safety Meter (risk of blocking)
// ============================================================

/**
 * Whapi's tools service, which hosts the Safety Meter. Not the gate:
 * the meter is a separate product on its own host, authenticated with
 * the same channel token.
 */
export const WHAPI_TOOLS_URL = (
  process.env.WHAPI_TOOLS_URL || 'https://tools.whapi.cloud'
).replace(/\/+$/, '')

/** 1 = use caution, 2 = needs attention, 3 = good. Null when absent. */
export type WhapiSafetyScore = 1 | 2 | 3 | null

export interface WhapiRiskOfBlocking {
  /** The overall rating. */
  riskFactor: WhapiSafetyScore
  /** The number's age on WhatsApp. */
  lifeTime: WhapiSafetyScore
  /** The response rate to the number's chats. */
  riskFactorChats: WhapiSafetyScore
  /** How much of its messaging goes to contacts in its address book. */
  riskFactorContacts: WhapiSafetyScore
  /** When Whapi last calculated it, as Whapi wrote it (M/D/YYYY). */
  lastUpdate: string | null
}

interface WhapiRiskResponse {
  lastUpdateDate?: unknown
  lifeTime?: unknown
  riskFactor?: unknown
  riskFactorChats?: unknown
  riskFactorContacts?: unknown
}

function safetyScore(v: unknown): WhapiSafetyScore {
  const n = typeof v === 'string' ? Number(v) : v
  return n === 1 || n === 2 || n === 3 ? n : null
}

/**
 * The Safety Meter's figures, without the rest of the response — which
 * echoes the channel TOKEN back in its `channel` field. Null when the
 * body carries no rating at all (nothing calculated yet).
 */
export function parseRiskOfBlocking(body: unknown): WhapiRiskOfBlocking | null {
  if (!body || typeof body !== 'object') return null
  const b = body as WhapiRiskResponse
  const out: WhapiRiskOfBlocking = {
    riskFactor: safetyScore(b.riskFactor),
    lifeTime: safetyScore(b.lifeTime),
    riskFactorChats: safetyScore(b.riskFactorChats),
    riskFactorContacts: safetyScore(b.riskFactorContacts),
    lastUpdate:
      typeof b.lastUpdateDate === 'string' && b.lastUpdateDate
        ? b.lastUpdateDate
        : null,
  }
  return out.riskFactor === null &&
    out.lifeTime === null &&
    out.riskFactorChats === null &&
    out.riskFactorContacts === null
    ? null
    : out
}

export interface GetRiskOfBlockingArgs {
  token: string
  /**
   * POST asks Whapi to calculate the figures afresh (at most once a day
   * per number; later calls that day return the stored ones). GET only
   * reads what was last calculated.
   */
  recalculate?: boolean
  timeoutMs?: number
}

/** Read (or recalculate) a number's Safety Meter rating. */
export async function getRiskOfBlocking(
  args: GetRiskOfBlockingArgs,
): Promise<WhapiRiskOfBlocking | null> {
  const data = await whapiRequest<unknown>({
    token: args.token,
    baseUrl: WHAPI_TOOLS_URL,
    path: '/services/riskOfBlocking',
    method: args.recalculate ? 'POST' : 'GET',
    timeoutMs: args.timeoutMs,
  })
  return parseRiskOfBlocking(data)
}

/**
 * Human-readable explanation for a non-`AUTH` channel, shown verbatim
 * in Settings. Whapi's raw status words mean little to an operator.
 */
export function describeChannelStatus(status: WhapiChannelStatus): string {
  switch (status) {
    case 'AUTH':
      return 'Connected and authorised.'
    case 'QR':
      return 'Waiting for QR scan — open your channel at panel.whapi.cloud and pair your phone.'
    case 'LAUNCH':
    case 'INIT':
      return 'The channel is starting up. Give it a few seconds and test again.'
    case 'NOT_INIT':
      return 'The channel has never been initialised. Pair a phone number at panel.whapi.cloud.'
    case 'ERROR':
      return 'The channel is in an error state. Check it at panel.whapi.cloud.'
    default:
      return 'Unknown channel status.'
  }
}

// ============================================================
// Text
// ============================================================

export interface SendTextMessageArgs {
  token: string
  to: string
  text: string
  /** Message id being replied to — renders as a quote in WhatsApp. */
  quotedMessageId?: string | null
  /** Seconds of "typing…" to simulate before delivery (0–60). */
  typingTime?: number
  /** Suppress WhatsApp's link preview card for URLs in the body. */
  noLinkPreview?: boolean
}

/**
 * Send a plain-text WhatsApp message.
 *
 * Unlike Meta, there is no 24-hour customer-service window to respect —
 * a Whapi channel is a real WhatsApp account and can open a conversation
 * at any time. (Ordinary WhatsApp anti-spam rules still apply; sending
 * unsolicited bulk messages is what gets a number banned.)
 */
export async function sendTextMessage(
  args: SendTextMessageArgs,
): Promise<WhapiSendResult> {
  const { token, to, text, quotedMessageId, typingTime, noLinkPreview } = args

  const body: Record<string, unknown> = {
    to: toWhapiRecipient(to),
    body: text,
  }
  applyQuote(body, quotedMessageId)
  if (typingTime) body.typing_time = Math.min(60, Math.max(0, typingTime))
  if (noLinkPreview) body.no_link_preview = true

  const data = await whapiRequest<WhapiSentEnvelope>({
    token,
    path: '/messages/text',
    method: 'POST',
    body,
  })
  return { messageId: readSentMessageId(data, 'text message') }
}

// ============================================================
// Media
// ============================================================

export type MediaKind = 'image' | 'video' | 'document' | 'audio' | 'voice' | 'sticker'

export interface SendMediaMessageArgs {
  token: string
  to: string
  kind: MediaKind
  /**
   * Public URL, a `data:` base64 string, or a Whapi media id. Whapi
   * fetches a URL server-side at send time, exactly as Meta did.
   */
  link: string
  /** Caption. Not accepted for audio/voice/sticker. */
  caption?: string
  /** Document-only: the filename the recipient sees. */
  filename?: string
  /** MIME type. Optional — Whapi sniffs it, but passing it is more reliable. */
  mimeType?: string
  quotedMessageId?: string | null
}

/**
 * Send an image, video, document, audio, voice note, or sticker.
 *
 * Whapi routes each kind to its own endpoint (`/messages/image`,
 * `/messages/document`, …) rather than Meta's single `/messages` with a
 * `type` discriminator, so the kind selects the path here.
 *
 * `voice` is the one to use for a recorded voice note (renders with a
 * waveform); `audio` sends a music-style attachment. The inbox's
 * push-to-talk recorder wants `voice`.
 */
export async function sendMediaMessage(
  args: SendMediaMessageArgs,
): Promise<WhapiSendResult> {
  const { token, to, kind, link, caption, filename, mimeType, quotedMessageId } = args
  if (!link) throw new WhapiError('sendMediaMessage requires a link.', 400)

  const body: Record<string, unknown> = {
    to: toWhapiRecipient(to),
    media: link,
  }
  applyQuote(body, quotedMessageId)
  if (mimeType) body.mime_type = mimeType

  // Captions are meaningless on audio/voice/sticker and Whapi rejects
  // the field on those endpoints.
  const acceptsCaption = kind === 'image' || kind === 'video' || kind === 'document'
  if (caption && acceptsCaption) body.caption = caption
  if (kind === 'document' && filename) body.filename = filename

  const data = await whapiRequest<WhapiSentEnvelope>({
    token,
    path: `/messages/${kind}`,
    method: 'POST',
    body,
  })
  return { messageId: readSentMessageId(data, `${kind} message`) }
}

// ============================================================
// Reactions
// ============================================================

export interface SendReactionMessageArgs {
  token: string
  /** The message being reacted to. */
  targetMessageId: string
  /** Single emoji, or an empty string to remove an existing reaction. */
  emoji: string
}

/**
 * React to (or un-react from) a message.
 *
 * Whapi models this as a mutation of the target message
 * (`PUT /messages/{id}/reaction`) rather than Meta's "send a message of
 * type reaction", so there is no recipient argument — the target id
 * already identifies the chat.
 */
export async function sendReactionMessage(
  args: SendReactionMessageArgs,
): Promise<WhapiSendResult> {
  const { token, targetMessageId, emoji } = args
  if (!targetMessageId) {
    throw new WhapiError('sendReactionMessage requires a targetMessageId.', 400)
  }

  const data = await whapiRequest<WhapiSentEnvelope>({
    token,
    path: `/messages/${encodeURIComponent(targetMessageId)}/reaction`,
    method: 'PUT',
    body: { emoji },
  })
  // A reaction is state on the target, not a new bubble; Whapi may not
  // return an id. Fall back to the target so callers always get a
  // stable, non-empty handle.
  return { messageId: data.message?.id ?? data.id ?? targetMessageId }
}

// ============================================================
// Interactive (reply buttons + selectable lists)
// ============================================================

import { INTERACTIVE_LIMITS } from './interactive-limits'
export { INTERACTIVE_LIMITS }

function validateInteractiveBody(bodyText: string): void {
  if (!bodyText) throw new WhapiError('Interactive message requires bodyText.', 400)
  if (bodyText.length > INTERACTIVE_LIMITS.bodyMaxLength) {
    throw new WhapiError(
      `Interactive body exceeds ${INTERACTIVE_LIMITS.bodyMaxLength} chars (got ${bodyText.length}).`,
      400,
    )
  }
}

function validateInteractiveHeaderFooter(
  headerText?: string,
  footerText?: string,
): void {
  if (headerText && headerText.length > INTERACTIVE_LIMITS.headerTextMaxLength) {
    throw new WhapiError(
      `Interactive header exceeds ${INTERACTIVE_LIMITS.headerTextMaxLength} chars.`,
      400,
    )
  }
  if (footerText && footerText.length > INTERACTIVE_LIMITS.footerMaxLength) {
    throw new WhapiError(
      `Interactive footer exceeds ${INTERACTIVE_LIMITS.footerMaxLength} chars.`,
      400,
    )
  }
}

export interface InteractiveButton {
  /** Stable id echoed back in the webhook when tapped. */
  id: string
  /** Visible label (≤ 20 chars). */
  title: string
}

export interface SendInteractiveButtonsArgs {
  token: string
  to: string
  bodyText: string
  headerText?: string
  footerText?: string
  buttons: InteractiveButton[]
  /** Optional media URL rendered above the buttons (image/video). */
  mediaUrl?: string
  quotedMessageId?: string | null
}

/**
 * Send a message with up to 3 inline reply buttons.
 *
 * When the customer taps one, Whapi delivers a `type: 'reply'` webhook
 * carrying `reply.buttons_reply.id`. Note that WhatsApp prefixes the id
 * on the way back (`ButtonsV3:<id>`); `normalizeButtonReplyId` in
 * `whapi-webhook.ts` strips that so Flows match on the id they set.
 */
export async function sendInteractiveButtons(
  args: SendInteractiveButtonsArgs,
): Promise<WhapiSendResult> {
  const { token, to, bodyText, headerText, footerText, buttons, mediaUrl, quotedMessageId } = args

  validateInteractiveBody(bodyText)
  validateInteractiveHeaderFooter(headerText, footerText)
  if (buttons.length < 1 || buttons.length > INTERACTIVE_LIMITS.maxButtons) {
    throw new WhapiError(
      `Interactive button message requires 1-${INTERACTIVE_LIMITS.maxButtons} buttons (got ${buttons.length}).`,
      400,
    )
  }

  const seen = new Set<string>()
  for (const button of buttons) {
    if (!button.id) throw new WhapiError('Every interactive button needs an id.', 400)
    if (seen.has(button.id)) {
      throw new WhapiError(`Duplicate interactive button id "${button.id}".`, 400)
    }
    seen.add(button.id)
    if (!button.title) {
      throw new WhapiError(`Interactive button "${button.id}" needs a title.`, 400)
    }
    if (button.title.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
      throw new WhapiError(
        `Interactive button title "${button.title}" exceeds ${INTERACTIVE_LIMITS.buttonTitleMaxLength} chars.`,
        400,
      )
    }
  }

  const body: Record<string, unknown> = {
    to: toWhapiRecipient(to),
    type: 'button',
    body: { text: bodyText },
    action: {
      buttons: buttons.map((b) => ({
        type: 'quick_reply',
        id: b.id,
        title: b.title,
      })),
    },
  }
  if (headerText) body.header = { text: headerText }
  if (footerText) body.footer = { text: footerText }
  if (mediaUrl) body.media = mediaUrl
  applyQuote(body, quotedMessageId)

  const data = await whapiRequest<WhapiSentEnvelope>({
    token,
    path: '/messages/interactive',
    method: 'POST',
    body,
  })
  return { messageId: readSentMessageId(data, 'interactive button message') }
}

export interface InteractiveListRow {
  id: string
  title: string
  description?: string
}

export interface InteractiveListSection {
  title?: string
  rows: InteractiveListRow[]
}

export interface SendInteractiveListArgs {
  token: string
  to: string
  bodyText: string
  /** Label on the tap-to-expand button of the bubble. */
  buttonLabel: string
  headerText?: string
  footerText?: string
  sections: InteractiveListSection[]
  quotedMessageId?: string | null
}

/**
 * Send a tap-to-expand list of selectable rows — for menus with more
 * options than the 3-button limit allows.
 *
 * Tapping a row produces a `reply.list_reply.id` webhook.
 */
export async function sendInteractiveList(
  args: SendInteractiveListArgs,
): Promise<WhapiSendResult> {
  const { token, to, bodyText, buttonLabel, headerText, footerText, sections, quotedMessageId } = args

  validateInteractiveBody(bodyText)
  validateInteractiveHeaderFooter(headerText, footerText)

  if (!buttonLabel) throw new WhapiError('Interactive list requires a buttonLabel.', 400)
  if (buttonLabel.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
    throw new WhapiError(
      `Interactive list buttonLabel "${buttonLabel}" exceeds ${INTERACTIVE_LIMITS.buttonTitleMaxLength} chars.`,
      400,
    )
  }
  if (sections.length < 1 || sections.length > INTERACTIVE_LIMITS.maxListSections) {
    throw new WhapiError(
      `Interactive list requires 1-${INTERACTIVE_LIMITS.maxListSections} sections (got ${sections.length}).`,
      400,
    )
  }

  const totalRows = sections.reduce((sum, s) => sum + s.rows.length, 0)
  if (totalRows < 1 || totalRows > INTERACTIVE_LIMITS.maxListRowsTotal) {
    throw new WhapiError(
      `Interactive list requires 1-${INTERACTIVE_LIMITS.maxListRowsTotal} rows total across all sections (got ${totalRows}).`,
      400,
    )
  }

  const seen = new Set<string>()
  for (const section of sections) {
    for (const row of section.rows) {
      if (!row.id) throw new WhapiError('Every interactive list row needs an id.', 400)
      if (seen.has(row.id)) {
        throw new WhapiError(`Duplicate interactive list row id "${row.id}".`, 400)
      }
      seen.add(row.id)
      if (!row.title) {
        throw new WhapiError(`Interactive list row "${row.id}" needs a title.`, 400)
      }
      if (row.title.length > INTERACTIVE_LIMITS.listRowTitleMaxLength) {
        throw new WhapiError(
          `Interactive list row title "${row.title}" exceeds ${INTERACTIVE_LIMITS.listRowTitleMaxLength} chars.`,
          400,
        )
      }
      if (
        row.description &&
        row.description.length > INTERACTIVE_LIMITS.listRowDescriptionMaxLength
      ) {
        throw new WhapiError(
          `Interactive list row description for "${row.id}" exceeds ${INTERACTIVE_LIMITS.listRowDescriptionMaxLength} chars.`,
          400,
        )
      }
    }
  }

  const body: Record<string, unknown> = {
    to: toWhapiRecipient(to),
    type: 'list',
    body: { text: bodyText },
    action: {
      label: buttonLabel,
      sections: sections.map((section) => ({
        title: section.title,
        rows: section.rows.map((row) => ({
          id: row.id,
          title: row.title,
          description: row.description,
        })),
      })),
    },
  }
  if (headerText) body.header = { text: headerText }
  if (footerText) body.footer = { text: footerText }
  applyQuote(body, quotedMessageId)

  const data = await whapiRequest<WhapiSentEnvelope>({
    token,
    path: '/messages/interactive',
    method: 'POST',
    body,
  })
  return { messageId: readSentMessageId(data, 'interactive list message') }
}

// ============================================================
// Templates
// ============================================================

export interface SendTemplateMessageArgs {
  token: string
  to: string
  /** The local `message_templates` row. */
  template: MessageTemplate
  /** Positional `{{1}}`, `{{2}}` … body substitutions. */
  bodyParams?: string[]
  /**
   * Runtime override for a media header's URL. Templates store a sample
   * at author time; broadcasts can point each send at a different file.
   */
  headerMediaUrl?: string | null
  quotedMessageId?: string | null
}

/**
 * Send a `message_templates` row through Whapi.
 *
 * Whapi channels have no notion of a Meta-approved HSM template: there
 * is no submission, no review, no `Approved` gate. A template here is
 * purely a **local, reusable message definition**, and sending one means
 * rendering it and posting an ordinary message:
 *
 *   * body-only              → `/messages/text`
 *   * media header           → `/messages/{image|video|document}` with the
 *                              rendered body as the caption
 *   * quick-reply buttons    → `/messages/interactive` (max 3, per WhatsApp)
 *
 * The upside for operators is large: no 24-hour window, no category
 * approval, no rejection round-trips — a template edited in the CRM is
 * usable on the next send. The trade-off is that WhatsApp's paid
 * business-initiated messaging guarantees don't apply; these are plain
 * messages from a real account.
 */
export async function sendTemplateMessage(
  args: SendTemplateMessageArgs,
): Promise<WhapiSendResult> {
  const { token, to, template, bodyParams = [], headerMediaUrl, quotedMessageId } = args

  const renderedBody = renderTemplateBody(template.body_text || '', bodyParams)

  // Quick-reply buttons win: they're the only shape that needs the
  // interactive endpoint, and WhatsApp renders a header + body there too.
  const quickReplies = normalizeTemplateButtons(template)
  if (quickReplies.length > 0) {
    return sendInteractiveButtons({
      token,
      to,
      bodyText: renderedBody,
      headerText:
        template.header_type === 'text' ? template.header_content || undefined : undefined,
      footerText: template.footer_text || undefined,
      buttons: quickReplies.slice(0, INTERACTIVE_LIMITS.maxButtons),
      mediaUrl:
        template.header_type && template.header_type !== 'text'
          ? headerMediaUrl || template.header_content || undefined
          : undefined,
      quotedMessageId,
    })
  }

  // Media header → send as a captioned attachment.
  const mediaKind = templateHeaderMediaKind(template)
  if (mediaKind) {
    const link = headerMediaUrl || template.header_content
    if (link) {
      return sendMediaMessage({
        token,
        to,
        kind: mediaKind,
        link,
        caption: composeTemplateText(template, renderedBody),
        quotedMessageId,
      })
    }
    // Header declared but no URL available — degrade to text rather
    // than fail the send outright.
    console.warn(
      `[whapi] template "${template.name}" declares a ${mediaKind} header but has no URL; sending as text.`,
    )
  }

  return sendTextMessage({
    token,
    to,
    text: composeTemplateText(template, renderedBody, /* includeHeader */ true),
    quotedMessageId,
  })
}

/** `image` | `video` | `document` for a media header, else null. */
function templateHeaderMediaKind(template: MessageTemplate): MediaKind | null {
  switch (template.header_type) {
    case 'image':
      return 'image'
    case 'video':
      return 'video'
    case 'document':
      return 'document'
    default:
      return null
  }
}

/**
 * Flatten a template's text parts into a single message body.
 *
 * WhatsApp renders Meta templates as header / body / footer blocks. A
 * free-form message has no such structure, so we approximate it with
 * blank-line separation — which is what the parts look like on the
 * recipient's screen anyway.
 */
function composeTemplateText(
  template: MessageTemplate,
  renderedBody: string,
  includeHeader = false,
): string {
  const parts: string[] = []
  if (includeHeader && template.header_type === 'text' && template.header_content) {
    parts.push(template.header_content)
  }
  if (renderedBody) parts.push(renderedBody)
  if (template.footer_text) parts.push(template.footer_text)
  return parts.join('\n\n')
}

/**
 * Read a template's `buttons` JSONB into interactive quick replies.
 *
 * Only QUICK_REPLY-style buttons survive the move: WhatsApp's URL and
 * phone-number call-to-action buttons are a template-only feature and
 * have no free-form equivalent. Rather than drop them silently, they're
 * appended to the body as plain text by the caller path above — a URL
 * in a message body is tappable in WhatsApp regardless.
 */
function normalizeTemplateButtons(template: MessageTemplate): InteractiveButton[] {
  const raw = template.buttons
  if (!Array.isArray(raw)) return []

  const out: InteractiveButton[] = []
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object') continue
    const button = entry as { type?: string; text?: string; title?: string; id?: string }
    const type = (button.type || 'QUICK_REPLY').toUpperCase()
    if (type !== 'QUICK_REPLY') continue
    const title = button.text || button.title
    if (!title) continue
    out.push({ id: button.id || `btn_${index + 1}`, title })
  }
  return out
}

// ============================================================
// Inbound media
// ============================================================

export interface GetMediaUrlArgs {
  token: string
  mediaId: string
}

/**
 * Resolve a Whapi media id to a downloadable URL plus its MIME type
 * and size.
 *
 * `fileSize` lets the inbound mirror reject an oversized attachment
 * *before* transferring it — a 90 MB document costs nothing to skip
 * here and a full download to skip afterwards.
 *
 * Note: unlike Meta's 5-minute signed CDN links, a Whapi media URL is
 * served from the channel and still needs the channel token as a Bearer
 * header — `downloadMedia` below supplies it.
 */
export async function getMediaUrl(
  args: GetMediaUrlArgs,
): Promise<{ url: string; mimeType: string; fileSize: number | null }> {
  const { token, mediaId } = args

  const data = await whapiRequest<{
    id?: string
    link?: string
    url?: string
    mime_type?: string
    file_size?: number | string
    size?: number | string
  }>({
    token,
    path: `/media/${encodeURIComponent(mediaId)}`,
  })

  const url = data.link || data.url
  if (!url) {
    throw new WhapiError(`No download URL in Whapi response for media ${mediaId}.`, 502)
  }

  const rawSize = data.file_size ?? data.size
  const size = Number(rawSize)

  return {
    url,
    mimeType: data.mime_type || 'application/octet-stream',
    fileSize: Number.isFinite(size) && size >= 0 ? size : null,
  }
}

export interface DownloadMediaArgs {
  downloadUrl: string
  token: string
}

/**
 * True for a URL the channel token may be presented to: a `/media/…`
 * path on the configured gateway origin (`WHAPI_BASE_URL`, which may be
 * an on-prem http host) — Whapi's own media endpoint.
 *
 * Deliberately NOT the whole gateway: a message's `media_url` is
 * sender-controlled and forwarding downloads it with this token, then
 * re-hosts the bytes publicly. Trusting any gateway path would let an
 * agent "forward" `…/settings` and read the channel's configuration
 * (including our webhook secret) back out of the bucket. WHATWG URL
 * parsing has already collapsed `..` / `%2e%2e` segments by now.
 */
export function isWhapiMediaHost(url: URL): boolean {
  let base: URL
  try {
    base = new URL(WHAPI_BASE_URL)
  } catch {
    return false
  }
  if (url.origin !== base.origin) return false
  const prefix = `${base.pathname.replace(/\/+$/, '')}/media/`
  return url.pathname.startsWith(prefix) && !url.username && !url.password
}

/**
 * Fetch the bytes behind a media URL from `getMediaUrl`, or behind a
 * URL Whapi embedded directly in a webhook (auto-download mode).
 *
 * The Bearer header goes ONLY to Whapi's media endpoint
 * (`isWhapiMediaHost`).
 * It used to be sent unconditionally, but `downloadUrl` is not always
 * gateway-issued — forwarding re-hosts a message's stored `media_url`,
 * which a sender can set to any URL — and an unconditional header hands
 * the channel token to whoever owns that host. Any other URL (e.g. the
 * public object-storage links auto-download produces, which need no
 * auth) is fetched without credentials and only after the SSRF guard,
 * with every redirect hop re-checked.
 */
export async function downloadMedia(
  args: DownloadMediaArgs,
): Promise<{ buffer: Buffer; contentType: string }> {
  const { downloadUrl, token } = args

  let response: Response
  try {
    response = await fetchPublicUrl(
      downloadUrl,
      { signal: AbortSignal.timeout(WHAPI_TIMEOUT_MS) },
      {
        isTrusted: isWhapiMediaHost,
        trustedHeaders: { Authorization: `Bearer ${token}` },
      },
    )
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      throw new WhapiError(`Media download refused: ${err.message}`, 400)
    }
    throw err
  }
  if (!response.ok) {
    throw new WhapiError(`Media download failed: ${response.status}`, response.status)
  }

  const contentType =
    response.headers.get('content-type') || 'application/octet-stream'
  return { buffer: Buffer.from(await response.arrayBuffer()), contentType }
}

// ============================================================
// Contacts
// ============================================================

export interface CheckPhonesArgs {
  token: string
  /** Bare-digit phone numbers to test. */
  phones: string[]
}

/**
 * Ask WhatsApp which of these numbers actually have an account.
 *
 * Meta had no equivalent — an invalid recipient only surfaced as a
 * failed send. Broadcasts use this to skip dead numbers before burning
 * a send (and the reputational cost of repeated failures).
 */
export async function checkPhonesOnWhatsApp(
  args: CheckPhonesArgs,
): Promise<Map<string, boolean>> {
  const { token, phones } = args
  const normalized = phones.map((p) => toWhapiRecipient(p)).filter(Boolean)
  if (normalized.length === 0) return new Map()

  const data = await whapiRequest<{
    contacts?: Array<{ input?: string; status?: string; wa_id?: string }>
  }>({
    token,
    path: '/contacts',
    method: 'POST',
    body: { blocking: 'wait', force_check: true, contacts: normalized },
  })

  const result = new Map<string, boolean>()
  for (const contact of data.contacts ?? []) {
    if (!contact.input) continue
    result.set(contact.input, contact.status === 'valid')
  }
  return result
}

export interface GetContactProfileArgs {
  token: string
  /** The contact's phone, in any form `toWhapiRecipient` accepts. */
  contactId: string
  /** Overrides WHAPI_TIMEOUT_MS for this call. */
  timeoutMs?: number
}

export interface WhapiContactPicture {
  /** Small preview avatar. */
  icon: string | null
  /** Full-size avatar. */
  iconFull: string | null
}

/**
 * A contact's WhatsApp profile picture, or null when there is none to
 * show.
 *
 * Sent as bare digits, the form the docs give for `ContactID` (a full
 * `@s.whatsapp.net` chat id is also accepted, but nothing is gained).
 *
 * Both URLs point at WhatsApp's CDN (pps.whatsapp.net) and EXPIRE, so a
 * caller must copy the bytes rather than store the link — see
 * `contact-avatars.ts`.
 *
 * A contact whose privacy settings hide the picture comes back with no
 * icon, or as a 404; both are "no picture", not a failure. Note that a
 * wrong token is ALSO a 404 here (`isUnknownChannel`), which this
 * cannot tell apart — callers should only ask through a number the
 * health monitor reports connected.
 */
export async function getContactProfile(
  args: GetContactProfileArgs,
): Promise<WhapiContactPicture | null> {
  const { token, contactId, timeoutMs } = args
  const id = toWhapiRecipient(contactId)
  if (!id) return null

  let data: { icon?: string | null; icon_full?: string | null }
  try {
    data = await whapiRequest<{ icon?: string | null; icon_full?: string | null }>({
      token,
      path: `/contacts/${encodeURIComponent(id)}/profile`,
      timeoutMs,
    })
  } catch (err) {
    if (err instanceof WhapiError && err.status === 404) return null
    throw err
  }

  const icon = typeof data?.icon === 'string' && data.icon ? data.icon : null
  const iconFull =
    typeof data?.icon_full === 'string' && data.icon_full ? data.icon_full : null
  if (!icon && !iconFull) return null
  return { icon, iconFull }
}

// ============================================================
// Channel settings / webhook registration
// ============================================================

/**
 * Media kinds Whapi should pull off the phone and host for us.
 *
 * Without auto-download an inbound attachment arrives as an id with no
 * retrievable bytes, so this list is effectively mandatory for the
 * inbox to render attachments at all.
 */
export const AUTO_DOWNLOAD_MEDIA = [
  'image',
  'video',
  'audio',
  'voice',
  'document',
  'sticker',
] as const

/** The Whapi events this CRM needs delivered. */
export const REQUIRED_WEBHOOK_EVENTS = [
  { type: 'messages', method: 'post' },
  { type: 'statuses', method: 'post' },
  { type: 'statuses', method: 'put' },
  // Group lifecycle: joined/created, membership changes, renames and
  // setting changes. Group *messages* still arrive as messages.post and
  // are dropped by the normaliser.
  { type: 'groups', method: 'post' },
  { type: 'groups', method: 'put' },
  { type: 'groups', method: 'patch' },
] as const

export interface WhapiWebhookConfig {
  url: string
  mode?: 'body' | 'path' | 'method'
  events?: Array<{ type: string; method: string }>
}

export interface WhapiChannelSettings {
  webhooks?: WhapiWebhookConfig[]
  media?: { auto_download?: string[] }
  callback_persist?: boolean
  callback_backoff_delay_ms?: number
  max_callback_backoff_delay_ms?: number
  offline_mode?: boolean
  full_history?: boolean
  sent_status?: boolean
}

export interface GetChannelSettingsArgs {
  token: string
}

/** Read the channel's current settings — used to show webhook state in the UI. */
export async function getChannelSettings(
  args: GetChannelSettingsArgs,
): Promise<WhapiChannelSettings> {
  return whapiRequest<WhapiChannelSettings>({
    token: args.token,
    path: '/settings',
  })
}

export interface RegisterWebhookArgs {
  token: string
  /** Fully-qualified HTTPS URL of this deployment's webhook route. */
  webhookUrl: string
  /**
   * Whether Whapi should retry failed deliveries. On by default — a
   * brief deploy or restart otherwise silently drops inbound messages.
   */
  persist?: boolean
}

export interface RegisterWebhookResult {
  success: boolean
  /** True when the channel already pointed at this exact URL. */
  alreadyRegistered: boolean
}

/**
 * Point the channel's webhook at this deployment.
 *
 * This is the Whapi replacement for Meta's two-step
 * `POST /{phone_number_id}/register` + `POST /{waba_id}/subscribed_apps`
 * dance, and it is dramatically simpler: one idempotent PATCH.
 *
 * The existing webhook list is read first and merged rather than
 * overwritten, so a channel that also feeds another system (a chatbot,
 * an analytics sink) keeps that delivery. Only the entry pointing at
 * *our* origin is replaced.
 *
 * `auto_download` is switched ON for every media kind. Whapi only
 * includes a `link` on an inbound attachment when the channel has
 * auto-download enabled — without it a webhook carries a media *id*
 * whose bytes were never pulled off the phone, and the attachment is
 * unreachable. Whapi retains those files for ~30 days, which is why
 * `mirrorInboundMedia` copies them into Supabase Storage on arrival.
 */
export async function registerWebhook(
  args: RegisterWebhookArgs,
): Promise<RegisterWebhookResult> {
  const { token, webhookUrl, persist = true } = args

  if (!/^https:\/\//i.test(webhookUrl)) {
    throw new WhapiError(
      `Whapi only delivers to HTTPS webhooks. Got: ${webhookUrl}`,
      400,
    )
  }

  let existing: WhapiWebhookConfig[] = []
  try {
    const settings = await getChannelSettings({ token })
    existing = Array.isArray(settings.webhooks) ? settings.webhooks : []
  } catch (err) {
    // A settings read failure shouldn't block registration — worst case
    // we replace the list with just ours.
    console.warn(
      '[whapi] could not read existing channel settings; writing a fresh webhook list:',
      err instanceof Error ? err.message : err,
    )
  }

  const alreadyRegistered = existing.some((hook) => hook.url === webhookUrl)

  // Drop any previous entry of ours and append the current one, so a
  // re-register replaces rather than accumulates.
  //
  // "Ours" is matched on the PATH, not just the origin. Matching origin
  // alone looks sufficient until the deployment moves — and behind a
  // Cloudflare quick tunnel the hostname changes on every restart, so
  // each re-register would leave the previous host behind and the
  // channel would slowly fill with dead URLs that Whapi keeps retrying.
  // The path is what identifies a Taamul Connect webhook; a channel
  // is single-tenant here, so there is no second install to confuse
  // it with.
  const merged: WhapiWebhookConfig[] = existing
    .filter((hook) => !isOurWebhook(hook.url, webhookUrl))
    .concat([
      {
        url: webhookUrl,
        mode: 'body',
        events: REQUIRED_WEBHOOK_EVENTS.map((e) => ({ ...e })),
      },
    ])

  await whapiRequest({
    token,
    path: '/settings',
    method: 'PATCH',
    body: {
      webhooks: merged,
      callback_persist: persist,
      media: { auto_download: [...AUTO_DOWNLOAD_MEDIA] },
    },
  })

  return { success: true, alreadyRegistered }
}

/**
 * Is this existing webhook entry one that a Taamul Connect deployment wrote?
 *
 * True when it shares our origin (the same deployment re-registering)
 * or our path (the same deployment reachable at a new hostname). A
 * hook we can't parse is left alone — better a stale entry than
 * deleting a third party's callback.
 */
export function isOurWebhook(existingUrl: string | undefined, ourUrl: string): boolean {
  if (!existingUrl) return false
  try {
    const existing = new URL(existingUrl)
    const ours = new URL(ourUrl)
    return existing.origin === ours.origin || existing.pathname === ours.pathname
  } catch {
    return false
  }
}

export interface TestWebhookArgs {
  token: string
  /** Event to simulate. Defaults to an inbound text message. */
  event?: { type: string; method: string }
}

/**
 * Ask Whapi to fire a synthetic callback at the configured URL.
 *
 * This is what the "Send test webhook" button in Settings calls: it
 * proves the tunnel/domain is reachable *from Whapi's side*, which is
 * the failure a local curl can never catch.
 */
export async function sendTestWebhook(args: TestWebhookArgs): Promise<void> {
  const { token, event = { type: 'messages', method: 'post' } } = args
  await whapiRequest({
    token,
    path: '/settings/webhook_test',
    method: 'POST',
    body: { ...event },
  })
}

// ============================================================
// Groups
// ============================================================
//
// https://whapi.readme.io/reference/getgroups and the pages beside it.
// Every response is parsed defensively into the neutral shapes below:
// the gateway's own types change with the channel's "data mode" (an
// identity is either a chat-id string or `{ id, phone, username }`).
//
// Sending a message to a group needs nothing new: `sendTextMessage` /
// `sendMediaMessage` pass a `…@g.us` recipient through untouched (see
// `toWhapiRecipient`).

/** Whapi's `GroupID` pattern. */
const WHAPI_GROUP_ID = /^[\d-]{10,31}@g\.us$/

export function isWhapiGroupId(id: unknown): id is string {
  return typeof id === 'string' && WHAPI_GROUP_ID.test(id)
}

/** WhatsApp's invite URL for an invite code. */
export function groupInviteLink(inviteCode: string): string {
  return `https://chat.whatsapp.com/${inviteCode}`
}

/** `creator` is WhatsApp's superadmin. */
export type WhapiGroupRole = 'member' | 'admin' | 'superadmin'
export type WhapiGroupPolicy = 'anyone' | 'admins'
export type WhapiGroupSetting =
  | 'send_messages'
  | 'edit_group_info'
  | 'approve_participants'
  | 'add_participants'

export const WHAPI_GROUP_SETTINGS: readonly WhapiGroupSetting[] = [
  'send_messages',
  'edit_group_info',
  'approve_participants',
  'add_participants',
]

/**
 * A person as Whapi names them. `waId` is the phone's digits when the
 * payload reveals it; a privacy id (`…@lid`) with no phone beside it
 * leaves it null, and `jid` keeps the raw id either way.
 */
export interface WhapiIdentity {
  jid: string
  waId: string | null
}

export interface WhapiGroupParticipant extends WhapiIdentity {
  role: WhapiGroupRole
}

/** null = the payload didn't say. */
export type WhapiGroupSettings = Record<WhapiGroupSetting, WhapiGroupPolicy | null>

export interface WhapiGroup {
  id: string
  name: string
  description: string | null
  participantsCount: number
  participants: WhapiGroupParticipant[]
  /** Unix seconds. */
  createdAt: number | null
  createdBy: WhapiIdentity | null
  /** Expiring WhatsApp CDN URL; copy the bytes, don't store the link. */
  iconUrl: string | null
  inviteCode: string | null
  settings: WhapiGroupSettings
  suspended: boolean
  terminated: boolean
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Parse a Whapi `DataModeIdentity` (string or `{ id, phone }`). */
export function parseWhapiIdentity(value: unknown): WhapiIdentity | null {
  let jid: string | null = null
  let phone: string | null = null
  if (typeof value === 'string') {
    jid = value
  } else if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    jid = str(v.id)
    phone = str(v.phone)
  }
  if (!jid) return null
  if (phone && /^\d{7,15}$/.test(phone)) return { jid, waId: phone }
  const [user, domain] = jid.split('@')
  const digits = /^\d{7,15}$/.test(user ?? '') ? user : null
  if (domain === undefined || domain === 's.whatsapp.net' || domain === 'c.us') {
    return { jid, waId: digits }
  }
  return { jid, waId: null }
}

function parseRole(rank: unknown): WhapiGroupRole {
  if (rank === 'creator' || rank === 'superadmin') return 'superadmin'
  if (rank === 'admin') return 'admin'
  return 'member'
}

export function parseWhapiParticipants(value: unknown): WhapiGroupParticipant[] {
  if (!Array.isArray(value)) return []
  const out: WhapiGroupParticipant[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    const who = parseWhapiIdentity(p.id)
    if (!who) continue
    out.push({ ...who, role: parseRole(p.rank) })
  }
  return out
}

function policy(flag: unknown): WhapiGroupPolicy | null {
  if (flag === true) return 'admins'
  if (flag === false) return 'anyone'
  return null
}

/** Parse a Whapi `Group` object; null when it has no usable group id. */
export function parseWhapiGroup(value: unknown): WhapiGroup | null {
  if (!value || typeof value !== 'object') return null
  const g = value as Record<string, unknown>
  const id = str(g.id)
  if (!id || !isWhapiGroupId(id)) return null
  const participants = parseWhapiParticipants(g.participants)
  return {
    id,
    name: str(g.name) ?? str(g.subject) ?? '',
    description: str(g.description),
    participantsCount:
      num(g.participants_count) ?? num(g.participantsCount) ?? participants.length,
    participants,
    createdAt: num(g.created_at),
    createdBy: parseWhapiIdentity(g.created_by),
    iconUrl: str(g.chat_pic),
    inviteCode: str(g.invite_code),
    settings: {
      send_messages: policy(g.announcements),
      edit_group_info: policy(g.restricted),
      approve_participants: policy(g.joinApprovalMode),
      add_participants: policy(g.adminAddMemberMode),
    },
    suspended: g.suspended === true,
    terminated: g.terminated === true,
  }
}

function parseIdentityList(value: unknown): WhapiIdentity[] {
  if (!Array.isArray(value)) return []
  return value
    .map((v) => parseWhapiIdentity(v))
    .filter((v): v is WhapiIdentity => v !== null)
}

/**
 * The gateway wants participants as bare digits (or a full id).
 * Empty entries are dropped; a call with none left is a caller bug.
 */
function participantIds(participants: string[]): string[] {
  const ids = participants.map((p) => toWhapiRecipient(p)).filter(Boolean)
  if (ids.length === 0) {
    throw new WhapiError('At least one participant is required.', 400)
  }
  return ids
}

function groupPath(groupId: string, suffix = ''): string {
  if (!isWhapiGroupId(groupId)) {
    throw new WhapiError(`Not a WhatsApp group id: ${groupId}`, 400)
  }
  return `/groups/${encodeURIComponent(groupId)}${suffix}`
}

function invitePath(inviteCode: string): string {
  if (!/^[A-Za-z0-9]{14,22}$/.test(inviteCode)) {
    throw new WhapiError('Not a WhatsApp group invite code.', 400)
  }
  return `/groups/link/${inviteCode}`
}

interface GroupArgs {
  token: string
  groupId: string
}

export interface ListGroupsArgs {
  token: string
  /** 1–500; Whapi's default is 100. */
  count?: number
  offset?: number
}

export interface WhapiGroupPage {
  groups: WhapiGroup[]
  /** Rows Whapi returned, parseable or not; decides the last page. */
  rawCount: number
  /** Total groups on the number, when Whapi says. */
  total: number | null
  offset: number
}

/** One page of the number's groups: `GET /groups`. */
export async function listGroups(args: ListGroupsArgs): Promise<WhapiGroupPage> {
  const { token, count, offset = 0 } = args
  const data = await whapiRequest<Record<string, unknown>>({
    token,
    path: '/groups',
    query: {
      count: count === undefined ? undefined : Math.min(500, Math.max(1, count)),
      offset,
    },
  })
  const raw = Array.isArray(data?.groups) ? data.groups : []
  return {
    groups: raw.map(parseWhapiGroup).filter((g): g is WhapiGroup => g !== null),
    rawCount: raw.length,
    total: num(data?.total),
    offset,
  }
}

export interface IterateGroupsArgs {
  token: string
  pageSize?: number
  /** Stop after this many groups; a sync must not walk forever. */
  maxGroups?: number
}

/** Default cap on a full walk of a number's groups. */
export const MAX_GROUPS_PER_SYNC = 2_000

/**
 * Walk every page of `GET /groups`, up to `maxGroups`. Stops on an empty
 * or short page, or once `total` is reached, whichever comes first.
 */
export async function* iterateGroups(
  args: IterateGroupsArgs,
): AsyncGenerator<WhapiGroup> {
  const { token, pageSize = 100, maxGroups = MAX_GROUPS_PER_SYNC } = args
  const size = Math.min(500, Math.max(1, pageSize))
  let offset = 0
  let yielded = 0
  while (yielded < maxGroups) {
    const page = await listGroups({ token, count: size, offset })
    for (const group of page.groups) {
      if (yielded >= maxGroups) return
      yield group
      yielded++
    }
    // Advance by the page size asked for, not the rows parsed: a row
    // dropped as unusable must not shift the next page's offset.
    offset += size
    // The raw row count decides the last page: a row dropped as
    // unparseable must not end the walk early (sync would mark the
    // later groups left).
    if (page.rawCount < size) return
    if (page.total !== null && offset >= page.total) return
  }
}

export async function listAllGroups(args: IterateGroupsArgs): Promise<WhapiGroup[]> {
  const out: WhapiGroup[] = []
  for await (const g of iterateGroups(args)) out.push(g)
  return out
}

export interface CreateGroupArgs {
  token: string
  subject: string
  /** At least one; WhatsApp won't create an empty group. */
  participants: string[]
}

export interface ParticipantsResult {
  /** Accepted by WhatsApp. */
  processed: WhapiIdentity[]
  /**
   * Refused. WhatsApp's anti-spam/privacy rules stop some people being
   * added directly; the remedy is to send them the invite link.
   * https://support.whapi.cloud/help-desk/groups/add-new-member-to-group
   */
  failed: WhapiIdentity[]
}

export interface CreateGroupResult extends ParticipantsResult {
  group: WhapiGroup
}

/**
 * `POST /groups`. The response lists the group's participants and, in
 * `unprocessed_participants`, those WhatsApp refused to add.
 */
export async function createGroup(args: CreateGroupArgs): Promise<CreateGroupResult> {
  const { token, subject } = args
  const participants = participantIds(args.participants)
  const data = await whapiRequest<Record<string, unknown>>({
    token,
    path: '/groups',
    method: 'POST',
    body: { subject, participants },
  })
  const group = parseWhapiGroup(data)
  if (!group) {
    throw new WhapiError('Whapi created the group but returned no group id.', 502)
  }
  const failed = parseIdentityList(data.unprocessed_participants)
  const failedKeys = new Set(failed.map((f) => f.waId ?? f.jid))
  const processed = group.participants
    .filter((p) => !failedKeys.has(p.waId ?? p.jid))
    .map(({ jid, waId }) => ({ jid, waId }))
  return { group, processed, failed }
}

export interface GetGroupArgs extends GroupArgs {
  /** Ask the channel to resync the group from WhatsApp first. */
  resync?: boolean
}

export async function getGroup(args: GetGroupArgs): Promise<WhapiGroup> {
  const data = await whapiRequest<unknown>({
    token: args.token,
    path: groupPath(args.groupId),
    query: { resync: args.resync ? true : undefined },
  })
  const group = parseWhapiGroup(data)
  if (!group) throw new WhapiError('Whapi returned no usable group.', 502)
  return group
}

export interface UpdateGroupInfoArgs extends GroupArgs {
  subject?: string
  description?: string
}

/** `PUT /groups/{id}`: name and/or description. Admin only (403). */
export async function updateGroupInfo(args: UpdateGroupInfoArgs): Promise<void> {
  const body: Record<string, string> = {}
  if (args.subject !== undefined) body.subject = args.subject
  if (args.description !== undefined) body.description = args.description
  if (Object.keys(body).length === 0) {
    throw new WhapiError('Nothing to update.', 400)
  }
  await whapiRequest({ token: args.token, path: groupPath(args.groupId), method: 'PUT', body })
}

export interface UpdateGroupSettingArgs extends GroupArgs {
  setting: WhapiGroupSetting
  policy: WhapiGroupPolicy
}

/** `PATCH /groups/{id}`: one setting per call. Admin only (403). */
export async function updateGroupSetting(args: UpdateGroupSettingArgs): Promise<void> {
  await whapiRequest({
    token: args.token,
    path: groupPath(args.groupId),
    method: 'PATCH',
    body: { setting: args.setting, policy: args.policy },
  })
}

/** `DELETE /groups/{id}`: our number leaves the group. */
export async function leaveGroup(args: GroupArgs): Promise<void> {
  await whapiRequest({ token: args.token, path: groupPath(args.groupId), method: 'DELETE' })
}

/** `GET /groups/{id}/invite`: the current invite code. Admin only. */
export async function getGroupInviteCode(args: GroupArgs): Promise<string> {
  const data = await whapiRequest<{ invite_code?: unknown }>({
    token: args.token,
    path: groupPath(args.groupId, '/invite'),
  })
  const code = str(data?.invite_code)
  if (!code) throw new WhapiError('Whapi returned no invite code.', 502)
  return code
}

/**
 * `DELETE /groups/{id}/invite`: the old link stops working. WhatsApp
 * mints a new code; read it with `getGroupInviteCode`.
 */
export async function revokeGroupInvite(args: GroupArgs): Promise<void> {
  await whapiRequest({
    token: args.token,
    path: groupPath(args.groupId, '/invite'),
    method: 'DELETE',
  })
}

export interface SendGroupInviteArgs {
  token: string
  inviteCode: string
  /** The person to invite, in any form `toWhapiRecipient` accepts. */
  to: string
  /** Message text; `%URL%` is replaced with the link. */
  body?: string
  /** Shown title; the group's name when unset. */
  title?: string
}

/**
 * `POST /groups/link/{code}`: send the invite link as a rich message.
 * It does not join anyone; the recipient taps it. This is the remedy
 * for people WhatsApp refused to add directly.
 */
export async function sendGroupInvite(args: SendGroupInviteArgs): Promise<WhapiSendResult> {
  const body: Record<string, unknown> = { to: toWhapiRecipient(args.to) }
  if (args.body) body.body = args.body
  if (args.title) body.title = args.title
  const data = await whapiRequest<WhapiSentEnvelope>({
    token: args.token,
    path: invitePath(args.inviteCode),
    method: 'POST',
    body,
  })
  return { messageId: readSentMessageId(data, 'group invite') }
}

export interface WhapiGroupPreview {
  id: string | null
  name: string
  participantsCount: number | null
  createdAt: number | null
}

/** `GET /groups/link/{code}`: what a code points at, without joining. */
export async function getGroupByInviteCode(args: {
  token: string
  inviteCode: string
}): Promise<WhapiGroupPreview> {
  const data = await whapiRequest<Record<string, unknown>>({
    token: args.token,
    path: invitePath(args.inviteCode),
  })
  const id = str(data?.id)
  return {
    id: id && isWhapiGroupId(id) ? id : null,
    name: str(data?.name) ?? '',
    participantsCount: num(data?.participantsCount) ?? num(data?.participants_count),
    createdAt: num(data?.created_at),
  }
}

/** `PUT /groups {invite_code}`: our number joins; returns the group id. */
export async function acceptGroupInvite(args: {
  token: string
  inviteCode: string
}): Promise<string> {
  const data = await whapiRequest<{ group_id?: unknown }>({
    token: args.token,
    path: '/groups',
    method: 'PUT',
    body: { invite_code: args.inviteCode },
  })
  const id = str(data?.group_id)
  if (!id || !isWhapiGroupId(id)) {
    throw new WhapiError('Whapi joined the group but returned no group id.', 502)
  }
  return id
}

export interface GroupParticipantsArgs extends GroupArgs {
  participants: string[]
}

function parseParticipantsResult(data: unknown): ParticipantsResult {
  const d = (data ?? {}) as Record<string, unknown>
  return {
    processed: parseIdentityList(d.processed),
    failed: parseIdentityList(d.failed),
  }
}

/**
 * `POST /groups/{id}/participants`. Admin only (403); 409 when someone
 * is already in. Some people are refused by WhatsApp's anti-spam rules
 * and come back in `failed`. Batch through `groups.ts`, never one big call.
 */
export async function addGroupParticipants(
  args: GroupParticipantsArgs,
): Promise<ParticipantsResult> {
  const data = await whapiRequest<unknown>({
    token: args.token,
    path: groupPath(args.groupId, '/participants'),
    method: 'POST',
    body: { participants: participantIds(args.participants) },
  })
  return parseParticipantsResult(data)
}

/** `DELETE /groups/{id}/participants`. Admin only (403). */
export async function removeGroupParticipants(
  args: GroupParticipantsArgs,
): Promise<ParticipantsResult> {
  const data = await whapiRequest<unknown>({
    token: args.token,
    path: groupPath(args.groupId, '/participants'),
    method: 'DELETE',
    body: { participants: participantIds(args.participants) },
  })
  return parseParticipantsResult(data)
}

/** `PATCH /groups/{id}/admins`. Admin only (403). */
export async function promoteGroupAdmins(args: GroupParticipantsArgs): Promise<void> {
  await whapiRequest({
    token: args.token,
    path: groupPath(args.groupId, '/admins'),
    method: 'PATCH',
    body: { participants: participantIds(args.participants) },
  })
}

/** `DELETE /groups/{id}/admins`. Admin only (403). */
export async function demoteGroupAdmins(args: GroupParticipantsArgs): Promise<void> {
  await whapiRequest({
    token: args.token,
    path: groupPath(args.groupId, '/admins'),
    method: 'DELETE',
    body: { participants: participantIds(args.participants) },
  })
}

export interface WhapiGroupIcon {
  bytes: ArrayBuffer
  contentType: string
}

/** `GET /groups/{id}/icon`: the image bytes, or null when none is set (204). */
export async function getGroupIcon(args: GroupArgs): Promise<WhapiGroupIcon | null> {
  const response = await whapiFetch({
    token: args.token,
    path: groupPath(args.groupId, '/icon'),
  })
  if (response.status === 204) return null
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength === 0) return null
  return { bytes, contentType: response.headers.get('content-type') || 'image/png' }
}

export interface SetGroupIconArgs extends GroupArgs {
  /** A public URL, base64 (a `data:` URL works as for media sends), or a Whapi media id. */
  media: string
  mimeType?: string
}

/** `PUT /groups/{id}/icon` with the JSON `{ media, mime_type }` body. Admin only. */
export async function setGroupIcon(args: SetGroupIconArgs): Promise<void> {
  if (!args.media) throw new WhapiError('setGroupIcon requires media.', 400)
  const body: Record<string, string> = { media: args.media }
  if (args.mimeType) body.mime_type = args.mimeType
  await whapiRequest({
    token: args.token,
    path: groupPath(args.groupId, '/icon'),
    method: 'PUT',
    body,
  })
}

export async function deleteGroupIcon(args: GroupArgs): Promise<void> {
  await whapiRequest({
    token: args.token,
    path: groupPath(args.groupId, '/icon'),
    method: 'DELETE',
  })
}

export interface WhapiJoinRequest extends WhapiIdentity {
  /** e.g. `invite_link`. */
  method: string | null
  /** Unix seconds. */
  requestedAt: number | null
}

export interface ListJoinRequestsArgs extends GroupArgs {
  count?: number
  offset?: number
}

/** `GET /groups/{id}/applications`: pending join requests. */
export async function listGroupJoinRequests(
  args: ListJoinRequestsArgs,
): Promise<{ requests: WhapiJoinRequest[]; total: number | null }> {
  const data = await whapiRequest<Record<string, unknown>>({
    token: args.token,
    path: groupPath(args.groupId, '/applications'),
    query: {
      count: args.count === undefined ? undefined : Math.min(500, Math.max(1, args.count)),
      offset: args.offset,
    },
  })
  const raw = Array.isArray(data?.applications) ? data.applications : []
  const requests: WhapiJoinRequest[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const a = item as Record<string, unknown>
    const who = parseWhapiIdentity(a.chatId)
    if (!who) continue
    requests.push({ ...who, method: str(a.request_method), requestedAt: num(a.timestamp) })
  }
  return { requests, total: num(data?.total) }
}

export interface JoinRequestDecisionArgs extends GroupArgs {
  /** The applicant's chat id (or phone). One per call, per Whapi. */
  applicant: string
}

export interface JoinRequestDecision {
  ok: boolean
  error: string | null
}

async function decideJoinRequest(
  args: JoinRequestDecisionArgs,
  method: 'POST' | 'DELETE',
): Promise<JoinRequestDecision> {
  const data = await whapiRequest<unknown>({
    token: args.token,
    path: groupPath(args.groupId, '/applications'),
    method,
    body: { application: phoneToChatId(args.applicant) },
  })
  const first = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined
  if (!first) return { ok: true, error: null }
  return { ok: first.success !== false, error: str(first.error) }
}

/** `POST /groups/{id}/applications`: approve one join request. */
export function approveGroupJoinRequest(
  args: JoinRequestDecisionArgs,
): Promise<JoinRequestDecision> {
  return decideJoinRequest(args, 'POST')
}

/** `DELETE /groups/{id}/applications`: reject one join request. */
export function rejectGroupJoinRequest(
  args: JoinRequestDecisionArgs,
): Promise<JoinRequestDecision> {
  return decideJoinRequest(args, 'DELETE')
}
