// ============================================================
// POST /api/account/members/[userId]/password  { password }
//
// An owner or admin sets another member's password (migration 140).
// That takes over the person's login, so the order is the point:
//
//   1. authorize_member_password_change(p_user_id), as the caller,
//      decides. It refuses unless the caller is a live owner / admin of
//      their active workspace who strictly outranks the person there
//      and in every other workspace the person belongs to (one login
//      opens them all), and never for the caller's own password.
//   2. Only then does GoTrue change the password (service role).
//   3. log_member_password_change writes the audit row, in every
//      workspace the person belongs to (the login opens them all, and
//      the caller administers each). It cannot undo step 2, so a
//      failure there is logged and the answer is still ok.
//
// The audit rows name no workspace of the caller's choosing: if the
// caller switched workspace while this request was in flight, the RPC
// judged the workspace active at that moment, and every one of the
// person's workspaces still gets its row.
//
// Whether sessions the person already has survive is GoTrue's business
// and differs between its versions; to cut someone off at once, an
// admin deactivates them.
//
// Neither the request body nor the password is ever logged.
// ============================================================

import { NextResponse } from 'next/server';
import {
  createClient as createAdminClient,
  type PostgrestError,
} from '@supabase/supabase-js';

import { MIN_PASSWORD_LENGTH } from '@/lib/account/add-member';
import {
  MAX_PASSWORD_BYTES,
  passwordProblem,
  type PasswordProblem,
} from '@/lib/account/member-password';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { serverSupabaseUrl } from '@/lib/supabase/urls';

/** Service-role client for the Auth admin API and the audit row. Only
 *  reached after the RPC has authorised the caller. */
function supabaseAdmin() {
  return createAdminClient(
    serverSupabaseUrl(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

const PROBLEM_MESSAGES: Record<PasswordProblem, string> = {
  required: 'Enter the new password.',
  tooShort: `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
  tooLong: `The password is too long: at most ${MAX_PASSWORD_BYTES} bytes, so fewer characters if it has accents or emoji.`,
};

/** GoTrue's answer to a password it will not take. */
const REFUSED_PASSWORD =
  'This password was not accepted: it is too weak, or the same as their current one. Choose another.';

const NOT_CHANGED =
  'Could not change the password. Nothing was changed; try again.';

// The RPC's SQLSTATEs, as the sibling member route maps them: 42501
// (not allowed, which includes a person outside this workspace) is 403,
// 22023 (bad input: their own password, or no such person) is 400. The
// message is the RAISE text from migration 140 or 083.
function rpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === '42501') {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err.code === '22023') {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error('[member password route] unexpected RPC error:', err);
  return NextResponse.json(
    { error: 'Failed to change the password' },
    { status: 500 }
  );
}

/** A weak or unchanged password, as GoTrue words it (422). */
function isRefusedPassword(err: { status?: number; code?: string }): boolean {
  if (err.code === 'weak_password' || err.code === 'same_password') {
    return true;
  }
  // Older GoTrue answers a password it refuses with a bare 422.
  return err.status === 422 && !err.code;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:memberPassword:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const body = (await request.json().catch(() => null)) as {
      password?: unknown;
    } | null;
    const password = body?.password;
    if (typeof password !== 'string') {
      return NextResponse.json(
        { error: PROBLEM_MESSAGES.required },
        { status: 400 }
      );
    }
    const problem = passwordProblem(password);
    if (problem) {
      return NextResponse.json(
        { error: PROBLEM_MESSAGES[problem] },
        { status: 400 }
      );
    }

    const { error: authzError } = await ctx.supabase.rpc(
      'authorize_member_password_change',
      { p_user_id: userId }
    );
    if (authzError) return rpcErrorToResponse(authzError);

    const admin = supabaseAdmin();
    const { error: authError } = await admin.auth.admin.updateUserById(userId, {
      password,
    });
    if (authError) {
      if (isRefusedPassword(authError)) {
        return NextResponse.json({ error: REFUSED_PASSWORD }, { status: 400 });
      }
      console.error(
        `[member password route] GoTrue refused the change for ${userId}:`,
        { status: authError.status, code: authError.code }
      );
      return NextResponse.json({ error: NOT_CHANGED }, { status: 502 });
    }

    const { error: auditError } = await admin.rpc(
      'log_member_password_change',
      { p_actor_id: ctx.userId, p_user_id: userId }
    );
    if (auditError) {
      // The password has changed and cannot be rolled back: say so in
      // the log, and still answer ok.
      console.error(
        `[member password route] password changed for ${userId} but the audit row was not written:`,
        { code: auditError.code, message: auditError.message }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
