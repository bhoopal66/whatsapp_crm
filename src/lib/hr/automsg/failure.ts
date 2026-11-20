/**
 * HR automated messages: which send failures are worth retrying
 * (package 029a). A retryable failure is marked failed and picked up
 * again (up to MAX_ATTEMPTS); anything else is terminal at once, because
 * the next attempt would be refused the same way.
 *
 * Pure: it reads the error classes' fields, never the network.
 */
import { MetaError } from '@/lib/whatsapp/meta-api';
import { OpenWAError } from '@/lib/whatsapp/openwa-api';
import { WhapiError } from '@/lib/whatsapp/whapi-api';

export interface SendFailure {
  retryable: boolean;
  reason: string;
}

/** A refusal this module makes itself, before or instead of a gateway call. */
export class HrSendRefusal extends Error {
  readonly retryable: boolean;
  constructor(
    readonly reason: string,
    message: string,
    retryable = false
  ) {
    super(message);
    this.name = 'HrSendRefusal';
    this.retryable = retryable;
  }
}

const retry = (reason: string): SendFailure => ({ retryable: true, reason });
const stop = (reason: string): SendFailure => ({ retryable: false, reason });

/** Meta error code -> stable non-retryable reason (029a's table). */
function metaCodeReason(code: number | null): string | null {
  if (code === 131026) return 'undeliverable';
  if (code === 131047) return 'reengagement_window';
  if (code === 131009 || code === 131030) return 'invalid_number';
  if (code === 132001) return 'template_not_found';
  if (code === 132015 || code === 132016) return 'template_paused';
  if (code !== null && code >= 132000 && code < 133000)
    return 'template_rejected';
  return null;
}

/** HTTP status alone: 429 / 5xx retry, 401/403 unauthorized, other 4xx rejected. */
function byStatus(status: number): SendFailure {
  if (status === 429) return retry('rate_limited');
  if (status >= 500) return retry('provider_unavailable');
  if (status === 401 || status === 403) return stop('unauthorized');
  if (status >= 400) return stop('rejected');
  return retry('error');
}

export function classifySendFailure(e: unknown): SendFailure {
  if (e instanceof HrSendRefusal)
    return { retryable: e.retryable, reason: e.reason };

  if (e instanceof MetaError) {
    const reason = metaCodeReason(e.code);
    if (reason) return stop(reason);
    // Meta answers throttling and its own temporary errors as HTTP 400,
    // which byStatus would call terminal. 4 / 80007 are isRateLimited.
    if (
      e.isRateLimited ||
      e.code === 130429 ||
      e.code === 131048 ||
      e.code === 131056
    )
      return retry('rate_limited');
    if (e.code === 1 || e.code === 2 || e.code === 131000 || e.code === 131016)
      return retry('provider_unavailable');
    return byStatus(e.status);
  }

  if (e instanceof WhapiError) {
    // A wrong token addresses a channel that does not exist.
    if (e.isUnknownChannel) return stop('unauthorized');
    // Ambiguous on Whapi: a logged-out phone, a channel starting up or a
    // revoked token. Only the first two pass, so it is retried.
    if (e.isAuthError) return retry('provider_unavailable');
    return byStatus(e.status);
  }

  if (e instanceof OpenWAError) {
    if (e.isNotReady || e.isPacingLimited) return retry('provider_unavailable');
    if (e.isAuthError || e.isSessionNotFound) return stop('unauthorized');
    return byStatus(e.status);
  }

  if (e instanceof Error) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError')
      return retry('timeout');
    // undici's fetch rejects with a TypeError ("fetch failed").
    if (e.name === 'TypeError' && /fetch failed|network/i.test(e.message))
      return retry('network');
  }
  return retry('error');
}
