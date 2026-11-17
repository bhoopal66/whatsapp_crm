/**
 * OpenWA WhatsApp gateway helpers.
 *
 * OpenWA is a self-hosted, unofficial gateway (whatsapp-web.js engine)
 * that runs beside the CRM. Like Whapi it rides a linked device — a
 * number still in the WhatsApp app — so there is no 24-hour window, no
 * template registry and real ban risk. Unlike Whapi it is one gateway
 * serving many numbers, so a call names two things:
 *
 *  * **the session** (`sessionId`, stored in `phone_number_id`) — the
 *    connected number. Every route this client uses lives under
 *    `/api/sessions/{sessionId}`.
 *  * **the key** (`apiKey`, the decrypted `access_token`) — an operator
 *    key scoped to that one session. A key used outside its scope is a
 *    403, never another tenant's number.
 *
 * Same idioms as `whapi-api.ts`: one options object per call, one error
 * class carrying `status`/`code` plus capability getters, and a network
 * failure surfaced as a synthetic 503 so callers have one type to catch.
 *
 * Contract: OpenWA v0.25.0 `openapi.json` / `docs/06-api-specification.md`.
 */

import type { MessageTemplate } from '@/types';

import { renderTemplateBody } from './template-body';
import { publicSupabaseUrl } from '@/lib/supabase/urls';
import {
  fetchPublicUrl,
  isDeliverableUrl,
  UnsafeUrlError,
  type Resolver,
} from '@/lib/webhooks/ssrf';

// ============================================================
// Configuration (read at call time, never at module load, so a test or
// a restarted process sees the current environment)
// ============================================================

/** The gateway's origin; REST lives under `/api`. */
export function openwaBaseUrl(): string {
  return (process.env.OPENWA_URL || 'http://127.0.0.1:2785').replace(
    /\/+$/,
    ''
  );
}

/**
 * The admin key, for provisioning sessions and their scoped keys only.
 * Sends never use it: a send carries the number's own scoped key, so a
 * leaked row cannot drive any other number on the gateway.
 */
export function openwaAdminApiKey(): string | null {
  return process.env.OPENWA_API_KEY || null;
}

/**
 * The CRM origin as the gateway reaches it. OpenWA runs in docker and
 * the CRM on the host, hence `host.docker.internal` by default rather
 * than the public site URL.
 */
export function openwaWebhookBaseUrl(): string {
  return (
    process.env.OPENWA_WEBHOOK_BASE_URL || 'http://host.docker.internal:3000'
  ).replace(/\/+$/, '');
}

/** Per-request ceiling; a hung engine page must not pin a route. */
const OPENWA_TIMEOUT_MS = 30_000;

// ============================================================
// Errors
// ============================================================

/**
 * A failed OpenWA call. `status` is the HTTP status, `code` OpenWA's
 * string error code when it sent one (`SEND_PACING_LIMITED`,
 * `ENGINE_PAGE_ERROR`, …), `retryAfterSeconds` the pacing governor's
 * hint (or a `Retry-After` header).
 *
 * `route` says what the URL addressed, because a 404 means different
 * things: on a session route the session is gone (the number was
 * removed from the gateway), on a message route only that message is.
 */
export class OpenWAError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryAfterSeconds: number | null;
  readonly route: 'session' | 'message';

  constructor(
    message: string,
    status: number,
    opts: {
      code?: string | null;
      retryAfterSeconds?: number | null;
      route?: 'session' | 'message';
    } = {}
  ) {
    super(message);
    this.name = 'OpenWAError';
    this.status = status;
    this.code = opts.code ?? null;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
    this.route = opts.route ?? 'session';
  }

  /** 401 bad/missing key; 403 key outside its session scope or IP list. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** The session itself does not exist on the gateway. */
  get isSessionNotFound(): boolean {
    return this.status === 404 && this.route === 'session';
  }

  /**
   * The engine exists but cannot send yet (409), or the session is not
   * ready / the gateway is unreachable (503, also our synthetic network
   * error). Retryable; says nothing about whether the number is linked.
   */
  get isNotReady(): boolean {
    return this.status === 409 || this.status === 503;
  }

  /**
   * The send pacing governor refused: the number's daily allowance, its
   * cold-reachout cap, or the failure breaker. Number-wide, so the next
   * send from the same number fails the same way.
   */
  get isPacingLimited(): boolean {
    return this.status === 429 && this.code === 'SEND_PACING_LIMITED';
  }

  /** The engine has no such feature (501). */
  get isNotSupported(): boolean {
    return this.status === 501;
  }
}

interface OpenWAErrorBody {
  statusCode?: number;
  /** NestJS validation errors arrive as an array of messages. */
  message?: string | string[];
  code?: string;
  retryAfterSeconds?: number;
}

async function throwOpenWAError(
  response: Response,
  route: 'session' | 'message'
): Promise<never> {
  let message = `OpenWA API error: ${response.status}`;
  let code: string | null = null;
  let retryAfterSeconds: number | null = null;
  try {
    const data = (await response.json()) as OpenWAErrorBody;
    if (Array.isArray(data.message)) message = data.message.join('; ');
    else if (data.message) message = data.message;
    if (typeof data.code === 'string') code = data.code;
    if (typeof data.retryAfterSeconds === 'number') {
      retryAfterSeconds = data.retryAfterSeconds;
    }
  } catch {
    // Not JSON (a proxy page, an empty 504) — keep the fallback.
  }
  if (retryAfterSeconds === null) {
    const header = Number(response.headers.get('retry-after'));
    if (Number.isFinite(header) && header >= 0) retryAfterSeconds = header;
  }
  throw new OpenWAError(message, response.status, {
    code,
    retryAfterSeconds,
    route,
  });
}

// ============================================================
// Transport
// ============================================================

interface OpenWARequestArgs {
  apiKey: string;
  sessionId: string;
  /** Under `/api/sessions/{sessionId}`, starting with `/` (or empty). */
  path: string;
  /**
   * A gateway-wide route (`/api/sessions`, `/api/auth/api-keys/…`) used
   * instead of `sessionId` + `path`: provisioning calls address no
   * session yet, or the key registry.
   */
  apiPath?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  timeoutMs?: number;
  route?: 'session' | 'message';
}

function sessionUrl(sessionId: string, path: string): string {
  return `${openwaBaseUrl()}/api/sessions/${encodeURIComponent(sessionId)}${path}`;
}

/** Single choke point: key header, JSON, timeout, uniform error mapping. */
export async function openwaRequest<T>(args: OpenWARequestArgs): Promise<T> {
  const {
    apiKey,
    sessionId,
    path,
    method = 'GET',
    body,
    timeoutMs,
    route = 'session',
    apiPath,
  } = args;

  // Refused before any request, so a retry can never double-send.
  if (!apiKey) throw new OpenWAError('Missing OpenWA API key.', 401);
  if (!apiPath && !sessionId) {
    throw new OpenWAError('Missing OpenWA session id.', 404);
  }

  const headers: Record<string, string> = {
    'X-API-Key': apiKey,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    const url = apiPath
      ? `${openwaBaseUrl()}${apiPath}`
      : sessionUrl(sessionId, path);
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs ?? OPENWA_TIMEOUT_MS),
    });
  } catch (err) {
    // DNS, refused socket, timeout. The outcome of a send is unknown,
    // which is exactly what a 5xx tells `isDefiniteSendRefusal`.
    const reason = err instanceof Error ? err.message : String(err);
    throw new OpenWAError(`OpenWA request failed: ${reason}`, 503, { route });
  }

  if (!response.ok) await throwOpenWAError(response, route);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// ============================================================
// Recipients
// ============================================================

/**
 * Whatever the CRM stores for a contact → an OpenWA chat id.
 *
 * The CRM stores E.164 with a `+`; OpenWA (whatsapp-web.js) addresses a
 * 1:1 chat as `<digits>@c.us`. A Whapi-style `@s.whatsapp.net` id is
 * the same person under another suffix; any other full id (`@g.us`,
 * `@lid`) passes through untouched.
 */
export function toOpenWAChatId(phoneOrChatId: string): string {
  const value = String(phoneOrChatId).trim();
  if (value.endsWith('@s.whatsapp.net')) {
    return `${value.split('@')[0].replace(/\D/g, '')}@c.us`;
  }
  if (value.includes('@')) return value;
  return `${value.replace(/\D/g, '')}@c.us`;
}

// ============================================================
// Sends
// ============================================================

export interface OpenWASendResult {
  /** WhatsApp's message id — persisted as `messages.message_id`. */
  messageId: string;
}

interface OpenWASentBody {
  messageId?: string;
  timestamp?: number;
}

function readMessageId(data: OpenWASentBody | undefined, context: string) {
  if (!data?.messageId) {
    // The send went out; only the id is missing. 502, not a 4xx, so no
    // retry treats it as safe to repeat.
    throw new OpenWAError(
      `OpenWA accepted the ${context} but returned no message id.`,
      502
    );
  }
  return data.messageId;
}

interface Credentials {
  /** The session-scoped operator key. */
  apiKey: string;
  sessionId: string;
}

export interface SendTextMessageArgs extends Credentials {
  to: string;
  text: string;
  quotedMessageId?: string | null;
  linkPreview?: boolean;
}

/** A plain text message. No service window: this is a phone-app number. */
export async function sendTextMessage(
  args: SendTextMessageArgs
): Promise<OpenWASendResult> {
  const { apiKey, sessionId, to, text, quotedMessageId, linkPreview } = args;
  const body: Record<string, unknown> = { chatId: toOpenWAChatId(to), text };
  if (quotedMessageId) body.quotedMessageId = quotedMessageId;
  if (linkPreview !== undefined) body.linkPreview = linkPreview;

  const data = await openwaRequest<OpenWASentBody>({
    apiKey,
    sessionId,
    path: '/messages/send-text',
    method: 'POST',
    body,
  });
  return { messageId: readMessageId(data, 'text message') };
}

export type MediaKind =
  'image' | 'video' | 'document' | 'audio' | 'voice' | 'sticker';

export interface SendMediaMessageArgs extends Credentials {
  to: string;
  kind: MediaKind;
  /** Public URL the gateway fetches, or a `data:` base64 string. */
  link: string;
  caption?: string;
  filename?: string;
  mimeType?: string;
  quotedMessageId?: string | null;
  /** Name resolution for the link check; tests only, as in `safeFetch`. */
  resolve?: Resolver;
}

/**
 * Throws a 400 `OpenWAError` unless the OpenWA gateway may fetch `link`.
 *
 * Whapi and Meta fetch a media link from their own clouds; OpenWA runs
 * beside the app and fetches it from THIS host, then delivers the bytes
 * on WhatsApp. An agent's `media_url` (and a broadcast's, automation's,
 * flow's or template header's link) would otherwise make our server read
 * `https://127.0.0.1:…`, an RFC 1918 host or the cloud metadata address
 * and send the answer to a number the sender controls.
 *
 * So the link must be https and resolve only to public addresses
 * (`isDeliverableUrl`). Our own public storage URL passes unchecked, as
 * `isAcceptableMediaUrl` lets it: on a self-hosted install that host may
 * well resolve to a private address, and every attachment lives there.
 * A `data:` link is bytes, not a fetch, and never reaches this check.
 *
 * Known gap: this vets the name now, and the gateway resolves it again
 * when it fetches, so a TTL-0 record (DNS rebinding) or a public URL that
 * redirects inward is not stopped here. OpenWA's own media guard (always
 * on; it pins the address and refuses redirects, and skips only the hosts
 * in its `SSRF_ALLOWED_HOSTS`) is the layer that covers those; closing
 * them on our side
 * would mean downloading the bytes and sending them as base64.
 */
export async function assertGatewayFetchableUrl(
  link: string,
  opts: { resolve?: Resolver; publicStorageBase?: string } = {}
): Promise<void> {
  const refuse = (): never => {
    throw new OpenWAError(
      'Media link refused: it must be a public https address.',
      400,
      { route: 'message' }
    );
  };
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return refuse();
  }
  if (url.username || url.password) return refuse();
  const base = (opts.publicStorageBase ?? publicSupabaseUrl() ?? '').replace(
    /\/+$/,
    ''
  );
  if (
    base &&
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.href.startsWith(`${base}/storage/v1/object/public/`) &&
    // An encoded slash, backslash or dot survives URL normalisation, and
    // a proxy that decodes it could walk out of the storage prefix.
    !/%(2f|5c|2e)/i.test(url.pathname)
  ) {
    return;
  }
  if (url.protocol !== 'https:') return refuse();
  if (!(await isDeliverableUrl(url.href, { resolve: opts.resolve }))) {
    return refuse();
  }
}

/**
 * Image, video, document, audio, voice note or sticker.
 *
 * Each kind is its own endpoint with the same FLAT body. A voice note is
 * `send-audio` with `ptt: true` — the microphone bubble with a waveform
 * the inbox's recorder wants; OpenWA defaults its mimetype to OGG/Opus.
 */
export async function sendMediaMessage(
  args: SendMediaMessageArgs
): Promise<OpenWASendResult> {
  const {
    apiKey,
    sessionId,
    to,
    kind,
    link,
    caption,
    filename,
    mimeType,
    quotedMessageId,
    resolve,
  } = args;
  if (!link) throw new OpenWAError('sendMediaMessage requires a link.', 400);

  const body: Record<string, unknown> = { chatId: toOpenWAChatId(to) };
  const dataUrl = /^data:([^;,]+)?;base64,([\s\S]*)$/.exec(link);
  if (dataUrl) {
    body.base64 = dataUrl[2];
    if (dataUrl[1]) body.mimetype = dataUrl[1];
  } else {
    await assertGatewayFetchableUrl(link, { resolve });
    body.url = link;
  }
  if (mimeType) body.mimetype = mimeType;
  // OpenWA accepts a caption on audio but does not keep it; send it
  // only where the recipient sees it, as the Whapi client does.
  if (
    caption &&
    (kind === 'image' || kind === 'video' || kind === 'document')
  ) {
    body.caption = caption;
  }
  if (kind === 'document' && filename) body.filename = filename;
  if (kind === 'voice') body.ptt = true;
  if (quotedMessageId) body.quotedMessageId = quotedMessageId;

  const endpoint = kind === 'voice' ? 'audio' : kind;
  const data = await openwaRequest<OpenWASentBody>({
    apiKey,
    sessionId,
    path: `/messages/send-${endpoint}`,
    method: 'POST',
    body,
  });
  return { messageId: readMessageId(data, `${kind} message`) };
}

export interface SendReactionMessageArgs extends Credentials {
  /** The chat the target message is in (OpenWA needs it). */
  to: string;
  targetMessageId: string;
  /** Single emoji, or an empty string to remove an existing reaction. */
  emoji: string;
}

/**
 * React to a message. A reaction is state on the target, not a new
 * bubble, and OpenWA answers `{ success }` with no id, so the target id
 * is returned as the stable handle (as the Whapi client does).
 */
export async function sendReactionMessage(
  args: SendReactionMessageArgs
): Promise<OpenWASendResult> {
  const { apiKey, sessionId, to, targetMessageId, emoji } = args;
  if (!targetMessageId) {
    throw new OpenWAError(
      'sendReactionMessage requires a targetMessageId.',
      400
    );
  }
  const data = await openwaRequest<{ success?: boolean }>({
    apiKey,
    sessionId,
    path: '/messages/react',
    method: 'POST',
    body: { chatId: toOpenWAChatId(to), messageId: targetMessageId, emoji },
  });
  if (data?.success === false) {
    throw new OpenWAError('OpenWA did not apply the reaction.', 502);
  }
  return { messageId: targetMessageId };
}

// ============================================================
// Interactive messages — plain-text fallback
// ============================================================

/**
 * The engine has no reply buttons or list messages, so both are sent as
 * text: the body, then the options numbered from 1, header and footer
 * kept. The customer answers by typing a number or the option's title;
 * the inbound side, not this client, maps that reply back to an id.
 */
export function renderOptionsText(parts: {
  headerText?: string;
  bodyText: string;
  footerText?: string;
  options: Array<{ title: string; description?: string; section?: string }>;
}): string {
  const lines: string[] = [];
  let section: string | undefined;
  parts.options.forEach((option, i) => {
    if (option.section && option.section !== section) {
      section = option.section;
      lines.push(`*${section}*`);
    }
    lines.push(
      option.description
        ? `${i + 1}. ${option.title} — ${option.description}`
        : `${i + 1}. ${option.title}`
    );
  });
  return [parts.headerText, parts.bodyText, lines.join('\n'), parts.footerText]
    .filter((p): p is string => Boolean(p))
    .join('\n\n');
}

export interface InteractiveButton {
  id: string;
  title: string;
}

export interface SendInteractiveButtonsArgs extends Credentials {
  to: string;
  bodyText: string;
  headerText?: string;
  footerText?: string;
  buttons: InteractiveButton[];
  quotedMessageId?: string | null;
}

export async function sendInteractiveButtons(
  args: SendInteractiveButtonsArgs
): Promise<OpenWASendResult> {
  const { bodyText, headerText, footerText, buttons, ...rest } = args;
  if (!bodyText) {
    throw new OpenWAError('Interactive message requires bodyText.', 400);
  }
  if (buttons.length < 1) {
    throw new OpenWAError('Interactive message requires a button.', 400);
  }
  return sendTextMessage({
    ...rest,
    text: renderOptionsText({
      headerText,
      bodyText,
      footerText,
      options: buttons.map((b) => ({ title: b.title })),
    }),
  });
}

export interface InteractiveListSection {
  title?: string;
  rows: Array<{ id: string; title: string; description?: string }>;
}

export interface SendInteractiveListArgs extends Credentials {
  to: string;
  bodyText: string;
  /** Unused: a text message has no tap-to-expand button to label. */
  buttonLabel: string;
  headerText?: string;
  footerText?: string;
  sections: InteractiveListSection[];
  quotedMessageId?: string | null;
}

export async function sendInteractiveList(
  args: SendInteractiveListArgs
): Promise<OpenWASendResult> {
  // `buttonLabel` is taken out so it is not sent; a text has no button.
  const { bodyText, headerText, footerText, sections, buttonLabel, ...rest } =
    args;
  void buttonLabel;
  const options = sections.flatMap((s) =>
    s.rows.map((r) => ({
      title: r.title,
      description: r.description,
      section: s.title,
    }))
  );
  if (!bodyText) {
    throw new OpenWAError('Interactive message requires bodyText.', 400);
  }
  if (options.length < 1) {
    throw new OpenWAError('Interactive list requires a row.', 400);
  }
  return sendTextMessage({
    ...rest,
    text: renderOptionsText({ headerText, bodyText, footerText, options }),
  });
}

// ============================================================
// Templates — rendered locally, like Whapi
// ============================================================

export interface SendTemplateMessageArgs extends Credentials {
  to: string;
  template: MessageTemplate;
  bodyParams?: string[];
  headerMediaUrl?: string | null;
  quotedMessageId?: string | null;
}

/** A template's QUICK_REPLY button titles (CTA buttons have no text form). */
function quickReplyTitles(template: MessageTemplate): string[] {
  if (!Array.isArray(template.buttons)) return [];
  const titles: string[] = [];
  for (const entry of template.buttons) {
    if (!entry || typeof entry !== 'object') continue;
    const b = entry as { type?: string; text?: string; title?: string };
    if ((b.type || 'QUICK_REPLY').toUpperCase() !== 'QUICK_REPLY') continue;
    const title = b.text || b.title;
    if (title) titles.push(title);
  }
  return titles;
}

/**
 * Send a `message_templates` row. There is no registry and no approval
 * here, the same as Whapi: the row is rendered (`renderTemplateBody`) and
 * posted as an ordinary message — a captioned attachment for a media
 * header, else text. Quick replies become numbered options, as with
 * `sendInteractiveButtons`.
 */
export async function sendTemplateMessage(
  args: SendTemplateMessageArgs
): Promise<OpenWASendResult> {
  const {
    template,
    bodyParams = [],
    headerMediaUrl,
    quotedMessageId,
    ...creds
  } = args;
  const renderedBody = renderTemplateBody(template.body_text || '', bodyParams);
  const options = quickReplyTitles(template).map((title) => ({ title }));

  const mediaKind =
    template.header_type === 'image' ||
    template.header_type === 'video' ||
    template.header_type === 'document'
      ? template.header_type
      : null;
  const link = mediaKind ? headerMediaUrl || template.header_content : null;

  const text = renderOptionsText({
    headerText:
      !link && template.header_type === 'text'
        ? template.header_content || undefined
        : undefined,
    bodyText: renderedBody,
    footerText: template.footer_text || undefined,
    options,
  });

  if (mediaKind && link) {
    return sendMediaMessage({
      ...creds,
      kind: mediaKind,
      link,
      caption: text || undefined,
      quotedMessageId,
    });
  }
  if (mediaKind) {
    console.warn(
      `[openwa] template "${template.name}" declares a ${mediaKind} header but has no URL; sending as text.`
    );
  }
  return sendTextMessage({ ...creds, text, quotedMessageId });
}

// ============================================================
// Session, contacts, media
// ============================================================

export type OpenWASessionStatus =
  | 'created'
  | 'initializing'
  | 'qr_ready'
  | 'authenticating'
  | 'ready'
  | 'disconnected'
  | 'action_required'
  | 'failed';

export interface OpenWASession {
  id: string;
  /** OpenWA's own word; only `ready` can send. */
  status: string;
  /** Digits of the linked number; null while nothing is linked. */
  phone: string | null;
  pushName: string | null;
  /** WhatsApp's restriction on the account, as OpenWA reports it. */
  restriction: unknown;
}

export async function getSession(
  args: Credentials & { timeoutMs?: number }
): Promise<OpenWASession> {
  const data = await openwaRequest<{
    id?: string;
    status?: string;
    phone?: string | null;
    pushName?: string | null;
    restriction?: unknown;
  }>({
    apiKey: args.apiKey,
    sessionId: args.sessionId,
    path: '',
    timeoutMs: args.timeoutMs,
  });
  const phone = (data?.phone ?? '').replace(/\D/g, '');
  return {
    id: data?.id ?? args.sessionId,
    status: data?.status ?? 'unknown',
    phone: phone || null,
    pushName: data?.pushName ?? null,
    restriction: data?.restriction ?? null,
  };
}

/**
 * A contact's profile picture URL, or null for "none / hidden" — both
 * are answers. An engine that could not find out answers 503, which
 * throws, so a caller can tell a transient failure from absence.
 */
export async function getContactProfilePicture(
  args: Credentials & { contactId: string; timeoutMs?: number }
): Promise<string | null> {
  const data = await openwaRequest<{ url?: string | null }>({
    apiKey: args.apiKey,
    sessionId: args.sessionId,
    path: `/contacts/${encodeURIComponent(toOpenWAChatId(args.contactId))}/profile-picture`,
    timeoutMs: args.timeoutMs,
  });
  return data?.url || null;
}

// ============================================================
// Phone history (the personal-number import)
// ============================================================

/** One entry of `GET /chats`, as the history import reads it. */
export interface OpenWAChatSummary {
  /** `…@c.us`, `…@lid`, `…@g.us`, … */
  id: string;
  name: string | null;
  /** 'individual' | 'group' | 'channel' | 'status' | 'broadcast' | 'unknown'. */
  kind: string;
  isGroup: boolean;
  /** Unix seconds of the last activity; null when the engine gave none. */
  timestamp: number | null;
}

/**
 * One page of the number's chats, newest first. The gateway pages by
 * `offset` (1-1000 per page); a short page is the last one.
 */
export async function listChats(
  args: Credentials & { limit?: number; offset?: number; timeoutMs?: number }
): Promise<OpenWAChatSummary[]> {
  const query = new URLSearchParams({ limit: String(args.limit ?? 1000) });
  if (args.offset) query.set('offset', String(args.offset));
  const data = await openwaRequest<unknown>({
    apiKey: args.apiKey,
    sessionId: args.sessionId,
    path: `/chats?${query}`,
    timeoutMs: args.timeoutMs,
  });
  if (!Array.isArray(data)) return [];
  return data
    .filter(
      (c): c is Record<string, unknown> =>
        !!c && typeof c === 'object' && typeof c.id === 'string' && !!c.id
    )
    .map((c) => ({
      id: c.id as string,
      name: typeof c.name === 'string' && c.name ? c.name : null,
      kind: typeof c.kind === 'string' ? c.kind : 'unknown',
      isGroup: c.isGroup === true,
      timestamp:
        typeof c.timestamp === 'number' && Number.isFinite(c.timestamp)
          ? c.timestamp
          : null,
    }));
}

/** One message of a chat's live history (`GET …/history`). */
export interface OpenWAHistoryMessage {
  id: string;
  from?: string;
  to?: string;
  chatId?: string;
  /** The text, or a media message's caption; '' when none. */
  body?: string;
  type?: string;
  /** Unix seconds (UTC). */
  timestamp?: number;
  fromMe?: boolean;
  isGroup?: boolean;
  kind?: string;
  location?: { description?: string; address?: string } | null;
  poll?: { name?: string } | null;
}

/**
 * A chat's history read live from the phone, oldest first. `deep`
 * raises the gateway's ceiling from 100 to 2000 and carries no media.
 * There is no cursor: one call returns the newest `limit` messages.
 * Slow on a long chat, so the caller sets `timeoutMs`; a timeout only
 * stops our wait (503 like any network failure), not the gateway's read.
 */
export async function getChatHistory(
  args: Credentials & {
    chatId: string;
    limit: number;
    deep?: boolean;
    timeoutMs?: number;
  }
): Promise<OpenWAHistoryMessage[]> {
  const query = new URLSearchParams({ limit: String(args.limit) });
  if (args.deep) query.set('deep', 'true');
  const data = await openwaRequest<unknown>({
    apiKey: args.apiKey,
    sessionId: args.sessionId,
    path: `/messages/${encodeURIComponent(args.chatId)}/history?${query}`,
    timeoutMs: args.timeoutMs,
  });
  if (!Array.isArray(data)) return [];
  return data.filter(
    (m): m is OpenWAHistoryMessage =>
      !!m && typeof m === 'object' && typeof m.id === 'string' && !!m.id
  );
}

/**
 * The phone number (digits) behind a contact id such as an `@lid`, or
 * null when the engine cannot map it — an answer, not a failure.
 */
export async function getContactPhone(
  args: Credentials & { contactId: string; timeoutMs?: number }
): Promise<string | null> {
  const data = await openwaRequest<{ phone?: string | null }>({
    apiKey: args.apiKey,
    sessionId: args.sessionId,
    path: `/contacts/${encodeURIComponent(args.contactId)}/phone`,
    timeoutMs: args.timeoutMs,
  });
  const phone = (data?.phone ?? '').replace(/\D/g, '');
  return phone || null;
}

/**
 * OpenWA serves a message's stored media by (chat, message), not by a
 * media id, so the neutral `mediaId` for an OpenWA attachment is the
 * pair joined by `/` — neither half contains one.
 */
export function toOpenWAMediaId(chatId: string, messageId: string): string {
  return `${chatId}/${messageId}`;
}

/**
 * The download URL for a stored attachment. No request is made: the
 * route answers the bytes themselves, so MIME type and size come from
 * the download (`downloadMedia`).
 */
export function getMediaUrl(args: { sessionId: string; mediaId: string }): {
  url: string;
  mimeType: string;
  fileSize: number | null;
} {
  const slash = args.mediaId.indexOf('/');
  if (slash <= 0 || slash === args.mediaId.length - 1) {
    throw new OpenWAError(`Not an OpenWA media id: ${args.mediaId}`, 400, {
      route: 'message',
    });
  }
  const chatId = args.mediaId.slice(0, slash);
  const messageId = args.mediaId.slice(slash + 1);
  return {
    url: sessionUrl(
      args.sessionId,
      `/messages/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId)}/media`
    ),
    mimeType: 'application/octet-stream',
    fileSize: null,
  };
}

/**
 * True for a URL the session key may be presented to: a message-media
 * path of THIS session on the configured gateway origin. Not the whole
 * gateway, for the reason `isWhapiMediaHost` gives: a forwarded
 * message's `media_url` is sender-controlled, and trusting any gateway
 * path would let one read the session's configuration back out.
 */
export function isOpenWAMediaUrl(url: URL, sessionId: string): boolean {
  let base: URL;
  try {
    base = new URL(openwaBaseUrl());
  } catch {
    return false;
  }
  if (url.origin !== base.origin || url.username || url.password) return false;
  const prefix = `${base.pathname.replace(/\/+$/, '')}/api/sessions/${encodeURIComponent(sessionId)}/messages/`;
  return url.pathname.startsWith(prefix) && url.pathname.endsWith('/media');
}

/**
 * Fetch media bytes. The key goes only to this session's media route on
 * the gateway (which is a loopback address, so it must be trusted past
 * the SSRF guard); any other URL is fetched without it, through the
 * guard, every redirect hop re-checked.
 */
export async function downloadMedia(
  args: Credentials & { downloadUrl: string }
): Promise<{ buffer: Buffer; contentType: string }> {
  const { apiKey, sessionId, downloadUrl } = args;
  let response: Response;
  try {
    response = await fetchPublicUrl(
      downloadUrl,
      { signal: AbortSignal.timeout(OPENWA_TIMEOUT_MS) },
      {
        isTrusted: (url) => isOpenWAMediaUrl(url, sessionId),
        trustedHeaders: { 'X-API-Key': apiKey },
      }
    );
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      throw new OpenWAError(`Media download refused: ${err.message}`, 400, {
        route: 'message',
      });
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new OpenWAError(`OpenWA media download failed: ${reason}`, 503, {
      route: 'message',
    });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new OpenWAError(
      `Media download failed: ${response.status}`,
      response.status,
      { route: 'message' }
    );
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType:
      response.headers.get('content-type') || 'application/octet-stream',
  };
}

// ============================================================
// Provisioning (admin key only)
//
// Connecting a number: create a session, mint an operator key scoped to
// it, point its webhook at the CRM, start it, then show its QR until the
// phone links. The admin key never leaves the server and is never
// stored; the row keeps only the scoped key.
// ============================================================

/** The scoped key's name, so a disconnect can find it again. */
export function scopedKeyName(sessionId: string): string {
  return `wacrm-${sessionId}`;
}

export async function createSession(args: {
  adminKey: string;
  name: string;
}): Promise<{ id: string; status: string }> {
  const data = await openwaRequest<{ id?: string; status?: string }>({
    apiKey: args.adminKey,
    sessionId: '',
    path: '',
    apiPath: '/api/sessions',
    method: 'POST',
    body: { name: args.name },
  });
  if (!data?.id) {
    throw new OpenWAError('OpenWA created the session but sent no id.', 502);
  }
  return { id: data.id, status: data.status ?? 'created' };
}

export async function startSession(args: {
  adminKey: string;
  sessionId: string;
}): Promise<void> {
  await openwaRequest<unknown>({
    apiKey: args.adminKey,
    sessionId: args.sessionId,
    path: '/start',
    method: 'POST',
    // The engine launch has its own ~30 s timeout before it answers.
    timeoutMs: 60_000,
  });
}

export async function getQr(args: {
  apiKey: string;
  sessionId: string;
}): Promise<{ qrCode: string | null; status: string }> {
  const data = await openwaRequest<{ qrCode?: string; status?: string }>({
    apiKey: args.apiKey,
    sessionId: args.sessionId,
    path: '/qr',
  });
  // Only an image data URL is passed on: it goes straight into an <img>.
  const qr = data?.qrCode ?? '';
  return {
    qrCode: qr.startsWith('data:image/') ? qr : null,
    status: data?.status ?? 'unknown',
  };
}

export async function logoutSession(args: {
  adminKey: string;
  sessionId: string;
}): Promise<void> {
  await openwaRequest<unknown>({
    apiKey: args.adminKey,
    sessionId: args.sessionId,
    path: '/logout',
    method: 'POST',
  });
}

export async function deleteSession(args: {
  adminKey: string;
  sessionId: string;
}): Promise<void> {
  await openwaRequest<unknown>({
    apiKey: args.adminKey,
    sessionId: args.sessionId,
    path: '',
    method: 'DELETE',
  });
}

/** An operator key that can act on this one session and nothing else. */
export async function createScopedKey(args: {
  adminKey: string;
  sessionId: string;
}): Promise<{ id: string; apiKey: string }> {
  const data = await openwaRequest<{ id?: string; apiKey?: string }>({
    apiKey: args.adminKey,
    sessionId: '',
    path: '',
    apiPath: '/api/auth/api-keys',
    method: 'POST',
    body: {
      name: scopedKeyName(args.sessionId),
      role: 'operator',
      allowedSessions: [args.sessionId],
    },
  });
  if (!data?.id || !data.apiKey) {
    throw new OpenWAError('OpenWA created the key but sent no key.', 502);
  }
  return { id: data.id, apiKey: data.apiKey };
}

export async function revokeKey(args: {
  adminKey: string;
  keyId: string;
}): Promise<void> {
  await openwaRequest<unknown>({
    apiKey: args.adminKey,
    sessionId: '',
    path: '',
    apiPath: `/api/auth/api-keys/${encodeURIComponent(args.keyId)}/revoke`,
    method: 'POST',
  });
}

/**
 * Ids of the active keys minted for a session. The row has no column for
 * the key id (144 leaves `app_secret` unused and this change adds no
 * migration), so a disconnect finds the key again by its name.
 */
export async function findScopedKeyIds(args: {
  adminKey: string;
  sessionId: string;
}): Promise<string[]> {
  const data = await openwaRequest<
    { id?: string; name?: string; isActive?: boolean }[]
  >({
    apiKey: args.adminKey,
    sessionId: '',
    path: '',
    apiPath: '/api/auth/api-keys',
  });
  const name = scopedKeyName(args.sessionId);
  return (Array.isArray(data) ? data : [])
    .filter((k) => k.name === name && k.isActive !== false && !!k.id)
    .map((k) => k.id as string);
}

/** The events the CRM's OpenWA webhook route consumes. */
export const OPENWA_WEBHOOK_EVENTS = [
  'message.received',
  // Own sends; filed only on a personal number (own-send.ts).
  'message.sent',
  'message.ack',
  'message.failed',
  'session.status',
  // WhatsApp groups (migration 114), company numbers only.
  'group.join',
  'group.leave',
  'group.join_request',
  'group.update',
] as const;

export async function createWebhook(args: {
  adminKey: string;
  sessionId: string;
  url: string;
  secret: string;
}): Promise<{ id: string }> {
  const data = await openwaRequest<{ id?: string }>({
    apiKey: args.adminKey,
    sessionId: args.sessionId,
    path: '/webhooks',
    method: 'POST',
    body: {
      url: args.url,
      events: [...OPENWA_WEBHOOK_EVENTS],
      secret: args.secret,
    },
  });
  return { id: data?.id ?? '' };
}

/**
 * Bring a session's CRM webhook up to `OPENWA_WEBHOOK_EVENTS`, for a
 * number connected before an event was added. The row stores no webhook
 * id, so ours is found by path; events it already has are kept. One GET
 * and, only when something is missing, one PUT (operator role, so the
 * session's scoped key suffices). Idempotent.
 */
export async function updateWebhookEvents(args: {
  apiKey: string;
  sessionId: string;
}): Promise<'updated' | 'unchanged' | 'missing'> {
  const hooks = await openwaRequest<
    { id?: string; url?: string; events?: string[] }[]
  >({
    apiKey: args.apiKey,
    sessionId: args.sessionId,
    path: '/webhooks',
  });
  const ours = (Array.isArray(hooks) ? hooks : []).find(
    (h) => !!h.id && (h.url ?? '').endsWith('/api/whatsapp/openwa/webhook')
  );
  if (!ours?.id) return 'missing';
  const have = Array.isArray(ours.events) ? ours.events : [];
  if (have.includes('*')) return 'unchanged';
  const missing = OPENWA_WEBHOOK_EVENTS.filter((e) => !have.includes(e));
  if (missing.length === 0) return 'unchanged';
  await openwaRequest<unknown>({
    apiKey: args.apiKey,
    sessionId: args.sessionId,
    path: `/webhooks/${encodeURIComponent(ours.id)}`,
    method: 'PUT',
    body: { events: [...have, ...missing] },
  });
  return 'updated';
}
