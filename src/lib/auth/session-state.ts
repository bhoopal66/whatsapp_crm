// ============================================================
// What this tab knows about its session, kept pure so it is testable
// without a browser.
//
// "Nobody is signed in" is an answer: no session stored, or SIGNED_OUT.
// A token refresh that failed or has not come back is not one
// (auth-js reports both as `session: null`), so nobody is sent to
// /login, or told they signed out, because of it.
// ============================================================

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
