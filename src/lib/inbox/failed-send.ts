import type { Message } from '@/types';
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
}

export interface FailedSend extends SendAttempt {
  conversationId: string;
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
 *   - A thrown fetch never gets here. It is a network error, and just
 *     as ambiguous.
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
  };
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

/** A failed text put back into the composer, and the chat it was written for. */
export interface RestoredDraft {
  conversationId: string;
  text: string;
}

/**
 * Split the restored drafts into those to take back out of the composer
 * now that `openConversationId` is open, and those to keep.
 *
 * One composer serves every chat, and its text carries over when the
 * agent switches. A draft the thread restored after a failure belongs
 * to its own chat only: left in the box, one Enter sends one customer's
 * words to the next. The failed row keeps the words and its Retry, so
 * taking the draft back loses nothing. The caller empties the box only
 * if it still holds exactly that text, so anything the agent typed
 * stays.
 */
export function partitionRestoredDrafts(
  drafts: readonly RestoredDraft[],
  openConversationId: string | null
): { withdraw: RestoredDraft[]; keep: RestoredDraft[] } {
  const withdraw: RestoredDraft[] = [];
  const keep: RestoredDraft[] = [];
  for (const d of drafts) {
    (d.conversationId === openConversationId ? keep : withdraw).push(d);
  }
  return { withdraw, keep };
}

/**
 * Uploads kept for a Retry, listed in the tab's sessionStorage so a
 * reload does not orphan them.
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
