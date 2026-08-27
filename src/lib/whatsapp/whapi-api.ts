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
}

/**
 * Single choke point for every Whapi call: auth header, JSON encoding,
 * timeout, and uniform error mapping. Everything else in this file is
 * a thin, typed wrapper over it.
 */
async function whapiRequest<T = unknown>(args: WhapiRequestArgs): Promise<T> {
  const { token, path, method = 'GET', body, query } = args

  if (!token) {
    throw new WhapiError('Missing Whapi channel token.', 401)
  }

  const url = new URL(`${WHAPI_BASE_URL}${path}`)
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
      signal: AbortSignal.timeout(WHAPI_TIMEOUT_MS),
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

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
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
  const { token, wakeup = true } = args
  const data = await whapiRequest<WhapiHealthResponse>({
    token,
    path: '/health',
    query: { wakeup },
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

/**
 * Limits enforced locally so a misconfigured Flow fails when it is
 * saved rather than mid-conversation with a live customer.
 *
 * These mirror WhatsApp's own client-side limits, which Whapi passes
 * through unchanged — they are a property of WhatsApp, not of the
 * gateway, so they survived the Meta → Whapi move intact.
 */
export const INTERACTIVE_LIMITS = {
  maxButtons: 3,
  buttonTitleMaxLength: 20,
  maxListSections: 10,
  maxListRowsTotal: 10,
  listRowTitleMaxLength: 24,
  listRowDescriptionMaxLength: 72,
  bodyMaxLength: 1024,
  footerMaxLength: 60,
  headerTextMaxLength: 60,
} as const

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
 * Fetch the bytes behind a media URL from `getMediaUrl`, or behind a
 * URL Whapi embedded directly in a webhook (auto-download mode).
 *
 * The Bearer header is sent unconditionally: Whapi-hosted media
 * requires it, and a public CDN URL simply ignores it.
 */
export async function downloadMedia(
  args: DownloadMediaArgs,
): Promise<{ buffer: Buffer; contentType: string }> {
  const { downloadUrl, token } = args

  const response = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(WHAPI_TIMEOUT_MS),
  })
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

  const ourOrigin = safeOrigin(webhookUrl)
  const alreadyRegistered = existing.some((hook) => hook.url === webhookUrl)

  // Drop any previous entry of ours (same origin, possibly a stale
  // tunnel URL or an old secret) and append the current one.
  const merged: WhapiWebhookConfig[] = existing
    .filter((hook) => safeOrigin(hook.url) !== ourOrigin)
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

/** Origin of a URL, or the raw string when it doesn't parse. */
function safeOrigin(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).origin
  } catch {
    return url
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
