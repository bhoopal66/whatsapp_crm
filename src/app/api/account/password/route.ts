// ============================================================
// POST /api/account/password  { currentPassword, newPassword }
//
// A signed-in person changes their own password:
//
//   1. The current password is checked against the login's own address
//      (auth.users, never profiles.email) on a throwaway client that
//      writes no cookies, behind the same lockout as sign-in
//      (`checkPassword`), so a stolen session cannot guess freely.
//   2. The caller's own session sets the new one. Not the admin API:
//      GoTrue ends every session of the person on that path, this one
//      included; here it keeps this one.
//   3. Their other sessions are signed out. The password has changed by
//      then, so a failure there is logged and the answer is still ok.
//
// 401 means not signed in, 403 a wrong current password. Neither
// password is ever logged.
// ============================================================

import { NextResponse } from 'next/server';
import { createClient as createThrowawayClient } from '@supabase/supabase-js';

import { passwordProblem } from '@/lib/account/member-password';
import { authErrorResponse as json } from '@/lib/auth/auth-error-response';
import {
  authUnavailableResponse,
  isAuthUnavailable,
} from '@/lib/auth/auth-unavailable';
import {
  checkPassword,
  classifySignInError,
  isJsonRequest,
  MAX_PASSWORD_LENGTH,
  type SignInOutcome,
} from '@/lib/auth/password-check';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { createClient } from '@/lib/supabase/server';
import { serverSupabaseUrl } from '@/lib/supabase/urls';

const LABEL = 'POST /api/account/password';

const MESSAGES = {
  badRequest: 'The current and the new password are required',
  wrong: 'Current password is incorrect',
  refused:
    'This password was not accepted: it is too weak, too long, or the same as your current one. Choose another.',
  locked: 'Too many failed attempts. Try again later.',
  throttled: 'Too many requests. Try again shortly.',
  unavailable:
    'The password could not be changed right now. Try again shortly.',
} as const;

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (isAuthUnavailable(authError)) return authUnavailableResponse();
  if (!user?.email) return json(401, 'Unauthorized');

  const limit = checkRateLimit(
    `account:password:${user.id}`,
    RATE_LIMITS.passwordChange
  );
  if (!limit.success) return rateLimitResponse(limit);

  const body = isJsonRequest(request)
    ? ((await request.json().catch(() => null)) as {
        currentPassword?: unknown;
        newPassword?: unknown;
      } | null)
    : null;
  const current = body?.currentPassword;
  const next = body?.newPassword;
  if (
    typeof current !== 'string' ||
    !current ||
    current.length > MAX_PASSWORD_LENGTH ||
    typeof next !== 'string'
  ) {
    return json(400, MESSAGES.badRequest);
  }
  if (passwordProblem(next)) return json(422, MESSAGES.refused);

  const check = await checkPassword({
    headers: request.headers,
    email: user.email,
    label: LABEL,
    attempt: (email) => verify(email, current, user.id),
  });
  switch (check.outcome) {
    case 'locked':
      return json(423, MESSAGES.locked, check.retryAfterMs);
    case 'rate_limited':
      return json(429, MESSAGES.throttled, check.retryAfterMs);
    case 'throttled':
      return json(429, MESSAGES.throttled, 1000);
    case 'unavailable':
      return json(503, MESSAGES.unavailable);
    case 'banned':
    case 'invalid':
      return json(403, MESSAGES.wrong);
  }

  const { error: updateError } = await supabase.auth.updateUser({
    password: next,
  });
  if (updateError) {
    const { status, code } = updateError;
    // A weak or unchanged password; older GoTrue answers a bare 422.
    if (
      code === 'weak_password' ||
      code === 'same_password' ||
      (status === 422 && !code)
    ) {
      return json(422, MESSAGES.refused);
    }
    console.error(`[${LABEL}] GoTrue refused the change for ${user.id}:`, {
      status,
      code,
    });
    return json(503, MESSAGES.unavailable);
  }

  const { error: signOutError } = await supabase.auth.signOut({
    scope: 'others',
  });
  if (signOutError) {
    console.error(
      `[${LABEL}] password changed for ${user.id} but the other sessions were not signed out:`,
      { status: signOutError.status, code: signOutError.code }
    );
  }
  return NextResponse.json({ ok: true });
}

/** Is `password` right for `email`, and is that login `userId`? */
async function verify(
  email: string,
  password: string,
  userId: string
): Promise<SignInOutcome> {
  try {
    const throwaway = createThrowawayClient(
      serverSupabaseUrl(),
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data, error } = await throwaway.auth.signInWithPassword({
      email,
      password,
    });
    if (error) return classifySignInError(error);
    // The session this opened is nobody's: end it at once, best-effort.
    await throwaway.auth.signOut({ scope: 'local' }).catch(() => {});
    return data.user?.id === userId ? 'ok' : 'invalid';
  } catch (err) {
    console.error(`[${LABEL}] checking the password failed:`, err);
    return 'unavailable';
  }
}
