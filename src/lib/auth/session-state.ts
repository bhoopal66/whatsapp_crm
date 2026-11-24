// ============================================================
// What this tab knows about its session, kept pure so it is testable
// without a browser.
//
// "Nobody is signed in" is an answer: no session stored, or SIGNED_OUT.
// A token refresh that failed or has not come back is not one
// (auth-js reports both as `session: null`), so nobody is sent to
// /login, or told they signed out, because of it.
// ============================================================

import { safeNextPath } from './login-client';

export type SessionStatus = 'unknown' | 'signed_in' | 'signed_out';

/**
 * What `auth.getSession()` said. Its `error` is always about a refresh:
 * one that was really refused has removed the stored session, so it
 * arrives as SIGNED_OUT and as "no session, no error" when asked again.
 */
export function statusFromAnswer(user: unknown, error: unknown): SessionStatus {
  if (user) return 'signed_in';
  if (!error) return 'signed_out';
  // A stored session with no refresh token to ask with: nothing to wait for.
  return (error as { name?: unknown }).name === 'AuthSessionMissingError'
    ? 'signed_out'
    : 'unknown';
}

/**
 * What an auth event says, or null when it says nothing: INITIAL_SESSION
 * also carries no session when the refresh behind it failed.
 */
export function statusFromEvent(
  event: string,
  user: unknown
): 'signed_in' | 'signed_out' | null {
  if (user) return 'signed_in';
  return event === 'SIGNED_OUT' ? 'signed_out' : null;
}

/** Wait before asking again: 1, 2, 4 … 30 s. */
export function recheckDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 30_000);
}

/**
 * The Retry button: ask again, or, when that has been tried or is
 * hanging, load the page again, so that the middleware refreshes the
 * session over the server's own route (nothing is mounted to lose).
 * Offline, a reload would only show the browser's error page.
 */
export function retryAction(state: {
  online: boolean;
  retries: number;
  checkingForMs: number | null;
}): 'check' | 'reload' {
  if (!state.online) return 'check';
  return state.retries > 0 || (state.checkingForMs ?? 0) >= 10_000
    ? 'reload'
    : 'check';
}

/**
 * Where a tab with nobody signed in goes: /login, remembering the page
 * as the middleware does unless the person signed out on purpose.
 */
export function loginPathFor(path: string, explicit: boolean): string {
  const next = explicit ? null : safeNextPath(path);
  return next && next !== '/'
    ? `/login?next=${encodeURIComponent(next)}`
    : '/login';
}

/**
 * Forget auth-js's cached refresh failure. It repeats a failed answer
 * for 60 s without asking; `recheckDelayMs` bounds our own asking, and
 * the network coming back must be noticed at once. The field is private:
 * session-state.test.ts runs the real client, and fails if it is renamed.
 */
export function forgetRefreshFailure(auth: object): void {
  (auth as { lastRefreshFailure?: unknown }).lastRefreshFailure = null;
}
