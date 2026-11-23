// ============================================================
// "The auth service did not answer" is not "nobody is signed in".
//
// `supabase.auth.getUser()` hands back `user: null` for both. Treating
// a GoTrue restart or a network blip as a missing session sent every
// signed-in person to /login and answered their API calls 401. A caller
// that sees `isAuthUnavailable(error)` must not conclude anything about
// the session: the middleware lets the page through, API routes answer
// 503. Nothing is granted by it: no user is loaded either way.
// ============================================================

import { NextResponse } from 'next/server';

const MESSAGE = 'Service temporarily unavailable. Try again shortly.';

/** The auth service, or the profile behind a session, could not be read. */
export class AuthUnavailableError extends Error {
  readonly status = 503 as const;
  constructor(message = MESSAGE) {
    super(message);
    this.name = 'AuthUnavailableError';
  }
}

/**
 * True for auth-js's AuthRetryableFetchError and any auth error with
 * status 0 (no answer) or 5xx. A 4xx, a missing session (status 400) and
 * no error at all are answers.
 */
export function isAuthUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, status } = error as { name?: unknown; status?: unknown };
  if (name === 'AuthRetryableFetchError') return true;
  return typeof status === 'number' && (status === 0 || status >= 500);
}

/** The API answer for it. */
export function authUnavailableResponse(): NextResponse {
  return NextResponse.json({ error: MESSAGE }, { status: 503 });
}
