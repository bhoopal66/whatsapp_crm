// ============================================================
// Checking a password behind the sign-in lockout (module 017a), shared
// by POST /api/auth/login and POST /api/account/password, so a guess
// costs the same wherever it is made:
//
//   1. The lock and the admin rate limits (`admitAdmin`) for the pair
//      (client IP, lower-cased email). A refused caller never reaches
//      `attempt`.
//   2. `attempt`, which asks GoTrue.
//   3. The outcome through the lockout (`settleAdmin`).
//
// Fails CLOSED: a lockout store that cannot be read, or a failure that
// cannot be counted, is `unavailable`. GoTrue being down or throttling
// us is neither a failure nor a success, and is not counted.
// ============================================================

import { edgeAuthGuards } from '@/lib/auth/edge-guards';
import { admitAdmin, clientIp, settleAdmin } from '@/lib/edge';

export type SignInOutcome =
  'ok' | 'invalid' | 'banned' | 'throttled' | 'unavailable';

export type PasswordCheck =
  | { outcome: SignInOutcome }
  | { outcome: 'locked' | 'rate_limited'; retryAfterMs?: number };

/** The longest password any route reads. */
export const MAX_PASSWORD_LENGTH = 1024;

export async function checkPassword(opts: {
  headers: Headers;
  email: string;
  /** For the log, e.g. `POST /api/auth/login`. */
  label: string;
  /** Asks GoTrue about the exact string the lockout keys on. */
  attempt: (email: string) => Promise<SignInOutcome>;
}): Promise<PasswordCheck> {
  const { headers, label, attempt } = opts;
  const user = opts.email.toLowerCase();
  const ip = clientIp(headers) ?? `unknown:${user}`;
  const guards = edgeAuthGuards();

  try {
    const refused = await admitAdmin(guards, { ip, userId: user });
    if (refused) {
      return {
        outcome: refused.status === 423 ? 'locked' : 'rate_limited',
        retryAfterMs: refused.retryAfterMs,
      };
    }
  } catch (err) {
    console.error(`[${label}] lockout store failed:`, err);
    return { outcome: 'unavailable' };
  }

  // GoTrue gets the same string the lockout keys on. It lowercases with
  // Go's simple case mapping, JavaScript with the full one, so a raw
  // `admİn@…` reached the user `admin@…` under a lockout key of its own
  // and every such variant bought another set of guesses.
  const outcome = await attempt(user);
  if (outcome === 'throttled' || outcome === 'unavailable') return { outcome };

  const authOk = outcome === 'ok';
  try {
    await settleAdmin(guards, { ip, userId: user, authOk });
  } catch (err) {
    console.error(`[${label}] lockout store failed:`, err);
    // The password was right: failing to clear the pair only leaves its
    // old failures counting until they age out, which is stricter, never
    // looser. A failure that could not be counted fails closed.
    if (!authOk) return { outcome: 'unavailable' };
  }
  return { outcome };
}

/**
 * GoTrue's answer → what it means here. A ban is checked before the
 * password, so it proves nothing about the password and counts as a
 * failure. No HTTP status (a network error), 5xx, or GoTrue's own rate
 * limit is not the caller's failure.
 */
export function classifySignInError(error: {
  code?: string;
  status?: number;
}): Exclude<SignInOutcome, 'ok'> {
  if (error.code === 'user_banned') return 'banned';
  if (error.code === 'over_request_rate_limit' || error.status === 429) {
    return 'throttled';
  }
  const status = error.status;
  if (typeof status !== 'number' || status === 0 || status >= 500) {
    return 'unavailable';
  }
  return 'invalid';
}

/** JSON only: a cross-site form cannot send it without a preflight. */
export function isJsonRequest(request: Request): boolean {
  const type = request.headers.get('content-type') ?? '';
  return type.toLowerCase().startsWith('application/json');
}
