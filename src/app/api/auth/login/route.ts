// ============================================================
// POST /api/auth/login — { email, password } → 200 { ok: true }
//
// Password sign-in, moved off the browser so a lockout can sit in front
// of GoTrue (module 017a). In order:
//
//   1. The lock and the admin rate limits (`admitAdmin`) for the pair
//      (client IP, lower-cased email). A locked pair answers 423 and a
//      refused rate 429 without GoTrue ever seeing the password.
//   2. `signInWithPassword` on the SSR client, which writes the session
//      cookies onto this response.
//   3. The outcome through the lockout (`settleAdmin`): a failure counts
//      toward 5 per (IP, email) / 20 per IP in 10 minutes → 15-minute
//      lock; a success clears the pair.
//
// Every credential failure is one 401 with one message, so the answer
// never says whether the email exists. A banned (deactivated) member
// keeps the message the page has always shown them (403). The lockout
// fails CLOSED: if its store cannot be read or written, sign-in answers
// 503 rather than let guesses through uncounted. GoTrue being down or
// throttling us is neither a failure nor a success, and is not counted.
//
// Without EDGE_CLIENT_IP_HEADER there is no client IP; the "IP" is then
// `unknown:<email>`, so one attacker cannot lock everyone out of a
// shared unknown bucket. The cost: the 20-per-IP limit becomes per
// email. Set the header (docs/security.md).
// ============================================================

import { NextResponse } from 'next/server';

import { edgeAuthGuards } from '@/lib/auth/edge-guards';
import { admitAdmin, clientIp, settleAdmin } from '@/lib/edge';
import { createClient } from '@/lib/supabase/server';

const MESSAGES = {
  badRequest: 'Email and password are required',
  invalid: 'Invalid email or password',
  deactivated: 'Your access has been deactivated. Contact your administrator.',
  locked: 'Too many failed sign-in attempts. Try again later.',
  throttled: 'Too many sign-in requests. Try again shortly.',
  unavailable: 'Sign-in is temporarily unavailable',
} as const;

type SignInOutcome = 'ok' | 'invalid' | 'banned' | 'throttled' | 'unavailable';

export async function POST(request: Request) {
  const creds = await readCredentials(request);
  if (!creds) return json(400, MESSAGES.badRequest);
  const { email, password } = creds;
  const user = email.toLowerCase();
  const ip = clientIp(request.headers) ?? `unknown:${user}`;
  const guards = edgeAuthGuards();

  try {
    const refused = await admitAdmin(guards, { ip, userId: user });
    if (refused) {
      return refused.status === 423
        ? json(423, MESSAGES.locked, refused.retryAfterMs)
        : json(429, MESSAGES.throttled, refused.retryAfterMs);
    }
  } catch (err) {
    console.error('[POST /api/auth/login] lockout store failed:', err);
    return json(503, MESSAGES.unavailable);
  }

  // GoTrue gets the same string the lockout keys on. It lowercases with
  // Go's simple case mapping, JavaScript with the full one, so a raw
  // `admİn@…` reached the user `admin@…` under a lockout key of its own
  // and every such variant bought another set of guesses.
  const outcome = await signIn(user, password);
  if (outcome === 'throttled') return json(429, MESSAGES.throttled, 1000);
  if (outcome === 'unavailable') return json(503, MESSAGES.unavailable);

  const authOk = outcome === 'ok';
  try {
    await settleAdmin(guards, { ip, userId: user, authOk });
  } catch (err) {
    console.error('[POST /api/auth/login] lockout store failed:', err);
    // The password was right and the session is set: failing to clear
    // the pair only leaves its old failures counting until they age
    // out, which is stricter, never looser. A failure that could not be
    // counted fails closed.
    if (!authOk) return json(503, MESSAGES.unavailable);
  }

  if (outcome === 'banned') return json(403, MESSAGES.deactivated);
  if (!authOk) return json(401, MESSAGES.invalid);
  return NextResponse.json({ ok: true });
}

async function readCredentials(
  request: Request
): Promise<{ email: string; password: string } | null> {
  // JSON only: a cross-site form cannot send it without a preflight,
  // which keeps another site from signing a visitor in (login CSRF).
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) return null;
  const body = (await request.json().catch(() => null)) as {
    email?: unknown;
    password?: unknown;
  } | null;
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email || email.length > 320 || !password || password.length > 1024) {
    return null;
  }
  return { email, password };
}

async function signIn(email: string, password: string): Promise<SignInOutcome> {
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    return error ? classifySignInError(error) : 'ok';
  } catch (err) {
    console.error('[POST /api/auth/login] sign-in failed:', err);
    return 'unavailable';
  }
}

/**
 * GoTrue's answer → what it means here. A ban is checked before the
 * password, so it proves nothing about the password and counts as a
 * failure. No HTTP status (a network error), 5xx, or GoTrue's own rate
 * limit is not the caller's failure.
 */
function classifySignInError(error: {
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

function json(status: number, error: string, retryAfterMs?: number) {
  if (retryAfterMs === undefined) {
    return NextResponse.json({ error }, { status });
  }
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return NextResponse.json(
    { error, retryAfterSeconds },
    { status, headers: { 'Retry-After': String(retryAfterSeconds) } }
  );
}
