import type { Message } from '@/types';
import { isOwnRow, isTempId } from '@/lib/inbox/optimistic';
import { isExpiredStagedMedia } from '@/lib/storage/staged-media';
import type { ConsentRefusal } from '@/lib/whatsapp/send-origin';

/**
 * An agent's send that failed, kept in the browser so it can be sent
 * again.
 *
 * Only the browser holds it: a failed send is never written to
 * `messages`. A row there would reach the unread counts, the thread
 * aggregates, the outbound webhooks and the public API as a message
 * that was sent, which it was not. The cost is that a reload loses it.
 * That is why the thread also puts a failed text back into the
 * composer.
 */
export interface SendAttempt {
  /** The optimistic bubble. Its `temp-` id is what the thread shows. */
  message: Message;
  /** The exact body POSTed to `/api/whatsapp/send`. Retry re-POSTs it unchanged. */
  body: Record<string, unknown>;
  /** Text sends only: what goes back into an empty composer on a retryable failure. */
  restoreText?: string;
  /**
   * Media sends: the chat-media object `body` links to. It is deleted
   * only once the send certainly did not go out and nobody will send it
   * again. After a send that may have gone out it is kept, because the
   * delivered message links to it.
   */
  uploadPath?: string;
  /** The quote it replied with, to go back with a parked draft. */
  quote?: { id: string; authorLabel: string; preview: string } | null;
  /**
   * The newest saved message of the chat when it was sent (the server's
   * clock), so only a newer row can be this one arriving.
   */
  sentAfter?: string | null;
}

/**
 * What is certain about a send that did not succeed:
 *   - `refused`: it did not go out, and can be sent again;
 *   - `offline`: it never left this device, and can be sent again;
 *   - `maybe`: it may have reached the customer, so no Retry;
 *   - `final`: it did not go out, and the same body never will;
 *   - `barred`: the consent register said no.
 */
export type FailedSendKind =
  'refused' | 'offline' | 'maybe' | 'final' | 'barred';

export interface FailedSend extends SendAttempt {
  conversationId: string;
  kind: FailedSendKind;
  /** The route's own words for the failure, shown under the bubble. */
  reason: string;
}

/**
 * Whether a failed `/api/whatsapp/send` answer may be offered a Retry,
 * that is, whether the message certainly did not go out.
 *
 * A retry is a new send. After an answer that leaves open whether the
 * first attempt was delivered, it can reach the customer twice. The
 * same answer decides whether the text goes back into the composer and
 * whether an upload may be deleted. So:
 *
 *   - The body must be the route's own `{ error }` JSON. When nginx or
 *     Cloudflare answers a 502/504/524 with its HTML page, that means
 *     the app never answered, not that it refused, and the send may
 *     have gone out while the proxy gave up waiting.
 *   - 4xx answers come before the gateway is called (validation, role,
 *     rate limit, conversation lookup).
 *   - 502 is `whatsapp_error`, the gateway call failed. That covers a
 *     refusal (the logged-out number this Retry exists for) and also a
 *     timeout, a gateway 5xx, or an accepted send that returned no id,
 *     after which the message may well have been delivered. Only the
 *     route can tell them apart, and it says so with `retryable: true`
 *     (`isDefiniteSendRefusal` in lib/whatsapp/provider.ts).
 *   - 500 is excluded. `db_error` means "sent to WhatsApp but could not
 *     be saved", and any other 500 is an exception that may have been
 *     thrown after the gateway accepted the send.
 *   - A thrown fetch never gets here: see `thrownSendKind`.
 */
export function isRetryableSendFailure(status: number, body: unknown): boolean {
  if (status >= 200 && status < 300) return false;
  if (!hasRouteError(body)) return false;
  // Certainly not sent, but final: a Retry is refused again, and the
  // words put back in the composer would go out as an ordinary reply,
  // which the register does not gate.
  if (consentRefusalOf(status, body)) return false;
  if (status >= 400 && status < 500) return true;
  return status === 502 && (body as { retryable?: unknown }).retryable === true;
}

/**
 * Whether the agent should be warned that a failed send with no Retry
 * may still have reached the customer, so they check before writing it
 * again. Not when nothing can have gone out: any 4xx (the route's come
 * before the gateway; a proxy's 413/429/403 page means the request
 * never reached the app) or an answer the route marked `retryable`
 * (a 500 raised before the gateway, such as `template_malformed`). And
 * not for `db_error`, whose own words already say the message was sent.
 */
export function shouldWarnMaybeSent(status: number, body: unknown): boolean {
  if (isRetryableSendFailure(status, body)) return false;
  if (status >= 400 && status < 500) return false;
  const answer = body as { code?: unknown; retryable?: unknown } | null;
  if (answer?.retryable === true) return false;
  return answer?.code !== 'db_error';
}

/**
 * The consent register's 409 for a missed-call draft (`do_not_contact`
 * or `opted_out`, see lib/whatsapp/send-origin.ts), or null. The inbox
 * words it itself, in the app's language.
 */
export function consentRefusalOf(
  status: number,
  body: unknown
): ConsentRefusal | null {
  if (status !== 409) return null;
  const code = (body as { code?: unknown } | null)?.code;
  return code === 'do_not_contact' || code === 'opted_out' ? code : null;
}

/** The kind of a failed answer from `/api/whatsapp/send`. */
export function answeredSendKind(
  status: number,
  body: unknown
): Exclude<FailedSendKind, 'offline'> {
  if (isRetryableSendFailure(status, body)) return 'refused';
  if (consentRefusalOf(status, body)) return 'barred';
  if (shouldWarnMaybeSent(status, body)) return 'maybe';
  // db_error: sent, but not saved. Never offered as "Not sent".
  const code = (body as { code?: unknown } | null)?.code;
  return code === 'db_error' ? 'maybe' : 'final';
}

/**
 * The kind of a send whose fetch threw. The browser says the same thing
 * for a request that never left and for one whose answer was lost, so
 * only a device that was offline throughout is certain: one that dropped
 * while the request was out may have delivered it.
 */
export function thrownSendKind(
  offlineBefore: boolean,
  offlineAfter: boolean
): 'offline' | 'maybe' {
  return offlineBefore && offlineAfter ? 'offline' : 'maybe';
}

/** Whether sending it again cannot reach the customer twice. */
export function canRetry(kind: FailedSendKind): boolean {
  return kind === 'refused' || kind === 'offline';
}

/**
 * Whether its upload is certainly unused, so it goes when the row does.
 * After a `maybe` the delivered message may link to it.
 */
export function ownsUpload(kind: FailedSendKind): boolean {
  return kind !== 'maybe';
}

/** The words Copy puts on the clipboard, or null for no Copy. */
export function copyableText(
  failed: Pick<FailedSend, 'kind' | 'message'>
): string | null {
  // Pasted, they would go out as an ordinary reply, which the consent
  // register does not gate.
  if (failed.kind === 'barred') return null;
  return failed.message.content_text?.trim() || null;
}

/** The newest saved message of the chat, for `SendAttempt.sentAfter`. */
export function newestSavedAt(
  messages: readonly Message[],
  conversationId: string
): string | null {
  let newest: string | null = null;
  for (const m of messages) {
    if (m.conversation_id !== conversationId || isTempId(m.id)) continue;
    if (!newest || Date.parse(m.created_at) > Date.parse(newest)) {
      newest = m.created_at;
    }
  }
  return newest;
}

/** How far this device's clock may run ahead of the server's. */
const CLOCK_SKEW_MS = 2 * 60_000;

/**
 * The rows whose message turns out to be in the chat after all: one of
 * this person's, saved after the send, with the same words (and the same
 * upload). Each saved message settles one row. A certain refusal is
 * never settled this way.
 */
export function arrivedSends(
  failed: readonly FailedSend[],
  messages: readonly Message[],
  viewerId: string | null | undefined
): FailedSend[] {
  const used = new Set<string>();
  return failed.filter((f) => {
    if (f.kind !== 'maybe' && f.kind !== 'offline') return false;
    const after = f.sentAfter
      ? Date.parse(f.sentAfter)
      : Date.parse(f.message.created_at) - CLOCK_SKEW_MS;
    const row = messages.find(
      (m) =>
        m.conversation_id === f.conversationId &&
        isOwnRow(m, viewerId) &&
        !used.has(m.id) &&
        m.content_type === f.message.content_type &&
        (m.content_text ?? '') === (f.message.content_text ?? '') &&
        (!f.message.media_url || m.media_url === f.message.media_url) &&
        Date.parse(m.created_at) > after
    );
    if (row) used.add(row.id);
    return !!row;
  });
}

/**
 * What a failure does besides its row. The words go back into the
 * composer after a refusal seen in their own chat, and into the chat's
 * parked draft when the person has left the inbox. The row is kept
 * either way: with a newer draft there it is the only copy.
 */
export function failedSendPlace(
  failed: Pick<FailedSend, 'kind' | 'restoreText' | 'conversationId'>,
  at: { leftInbox: boolean; openConversationId: string | null | undefined }
): 'composer' | 'parked' | 'row' {
  if (!failed.restoreText || !canRetry(failed.kind)) return 'row';
  if (at.leftInbox) return 'parked';
  return failed.kind === 'refused' &&
    at.openConversationId === failed.conversationId
    ? 'composer'
    : 'row';
}

/** The route's `{ error }`, or the bare status when there is none. */
export function sendFailureReason(status: number, body: unknown): string {
  return hasRouteError(body) ? body.error : `HTTP ${status}`;
}

function hasRouteError(body: unknown): body is { error: string } {
  return (
    !!body &&
    typeof body === 'object' &&
    typeof (body as { error?: unknown }).error === 'string' &&
    (body as { error: string }).error.length > 0
  );
}

/**
 * The attempt a Retry makes: the same body, as a new bubble. Sending it
 * again is new, so it goes at the bottom of the thread with the time of
 * the retry. The old failed bubble's id stays hidden (see MessageThread).
 */
export function retryAttempt(
  failed: FailedSend,
  tempId: string,
  now: Date = new Date()
): SendAttempt {
  return {
    message: {
      ...failed.message,
      id: tempId,
      status: 'sending',
      created_at: now.toISOString(),
    },
    body: failed.body,
    restoreText: failed.restoreText,
    uploadPath: failed.uploadPath,
    quote: failed.quote,
  };
}

/**
 * Whether a failed media send's upload is too old to send again. A
 * failed row lives as long as the tab, and the server sweeps an
 * unreferenced staged upload after 30 days: a Retry after that would
 * send a link to a deleted file. The caller drops the row and deletes
 * the upload instead.
 */
export function hasExpiredUpload(
  failed: Pick<SendAttempt, 'uploadPath'>,
  now: number = Date.now()
): boolean {
  return !!failed.uploadPath && isExpiredStagedMedia(failed.uploadPath, now);
}

/**
 * Failed text sends that a new send of `text` in the same chat makes
 * redundant. This is usually the restored draft being sent again. The
 * old bubble's Retry would then send the same words a second time.
 */
export function supersededBy<
  T extends Pick<FailedSend, 'conversationId' | 'restoreText'>,
>(failed: readonly T[], conversationId: string, text: string): T[] {
  return failed.filter(
    (f) => f.conversationId === conversationId && f.restoreText === text
  );
}

/**
 * Uploads kept for a Retry, listed in the tab's sessionStorage so a
 * reload does not orphan them. A row outlives the inbox screen, so the
 * next mount lists again what a row still holds.
 *
 * A failed media send keeps its upload so a Retry sends the same link.
 * The failed row lives only in memory, and React runs no cleanup when
 * the page unloads, so a reload (the usual answer to an outage) used to
 * leave the object in the public chat-media bucket for good. The next
 * inbox mount in the same tab deletes whatever is still listed.
 *
 * sessionStorage, not localStorage, because it belongs to one tab: an
 * inbox opening in a second tab must not delete an upload the first one
 * still offers to Retry. Closing the tab drops the list, and those
 * uploads leak, since nothing can delete reliably while a page unloads.
 * A duplicated tab copies the list, and the copy's inbox deletes the
 * original tab's kept uploads. A Retry there then sends a link to a
 * deleted file.
 *
 * A path is listed only while a failed row holds it, and is taken off
 * before a Retry goes out. So an upload that a send in flight may be
 * delivering is never on the list.
 *
 * Storage can be missing or throw (private windows, blocked site data),
 * so every access is guarded and a failure only means the old leak.
 */
export const KEPT_UPLOADS_KEY = 'inbox:kept-uploads';

type TabStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function readKeptUploads(storage: TabStorage): string[] {
  const raw = storage.getItem(KEPT_UPLOADS_KEY);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed)
    ? parsed.filter((p): p is string => typeof p === 'string' && p !== '')
    : [];
}

function writeKeptUploads(storage: TabStorage, paths: string[]): void {
  if (paths.length) {
    storage.setItem(KEPT_UPLOADS_KEY, JSON.stringify(paths));
  } else {
    storage.removeItem(KEPT_UPLOADS_KEY);
  }
}

/** List an upload that a failed row now holds for its Retry. */
export function rememberKeptUpload(
  storage: TabStorage | null,
  path: string
): void {
  if (!storage) return;
  try {
    const paths = readKeptUploads(storage);
    if (!paths.includes(path)) writeKeptUploads(storage, [...paths, path]);
  } catch {
    // Unreadable or full: the upload is simply not swept after a reload.
  }
}

/** Take an upload off the list: it was deleted, or a Retry is sending it. */
export function forgetKeptUpload(
  storage: TabStorage | null,
  path: string
): void {
  if (!storage) return;
  try {
    const paths = readKeptUploads(storage);
    if (paths.includes(path)) {
      writeKeptUploads(
        storage,
        paths.filter((p) => p !== path)
      );
    }
  } catch {
    // A path left listed would be deleted by the next sweep, maybe
    // after a Retry delivered it. Drop the whole list instead: leaking
    // the others is the safe way to fail.
    try {
      storage.removeItem(KEPT_UPLOADS_KEY);
    } catch {
      // Storage is unusable, so nothing is listed either.
    }
  }
}

/**
 * Every listed upload, removed from the list. Called when the inbox
 * mounts, when no failed row can hold one yet: they are what a reload
 * left behind, and the caller deletes them.
 */
export function takeKeptUploads(storage: TabStorage | null): string[] {
  if (!storage) return [];
  try {
    const paths = readKeptUploads(storage);
    storage.removeItem(KEPT_UPLOADS_KEY);
    return paths;
  } catch {
    try {
      storage.removeItem(KEPT_UPLOADS_KEY);
    } catch {
      // Storage is unusable; there is nothing to sweep.
    }
    return [];
  }
}
