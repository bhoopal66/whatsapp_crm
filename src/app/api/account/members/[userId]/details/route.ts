// ============================================================
// PATCH /api/account/members/[userId]/details  { full_name, email }
//
// An owner or admin edits another member's name and login email
// (migration 167). The email is how the person signs in, and both are
// one identity across every workspace they belong to (083's
// profiles_propagate_identity copies them), so the order is the point:
//
//   1. authorize_member_details_change(p_user_id), as the caller,
//      decides: 140's password rule (a live owner / admin of the active
//      workspace who strictly outranks the person there and in every
//      other workspace the person belongs to; never their own details).
//   2. If nothing changed, answer ok and write nothing.
//   3. A new email goes to GoTrue first (service role), confirmed at
//      once: this install sends no mail. A taken address is a 409, and
//      nothing else has been written yet.
//   4. Then the profiles rows (service role; 135's guard refuses only
//      'authenticated'). If that fails, the GoTrue email is put back so
//      the login and the members list keep agreeing.
//   5. log_member_details_change writes the audit row in every
//      workspace the person belongs to. It cannot undo steps 3-4, so a
//      failure there is logged and the answer is still ok.
//
// GoTrue's error text is never echoed, and the request body is never
// logged.
// ============================================================

import { NextResponse } from 'next/server';
import {
  createClient as createAdminClient,
  type PostgrestError,
} from '@supabase/supabase-js';

import {
  MAX_MEMBER_EMAIL_LENGTH,
  MAX_MEMBER_NAME_LENGTH,
  memberDetailsProblem,
  normalizeMemberDetails,
  type MemberDetailsProblem,
} from '@/lib/account/member-details';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { serverSupabaseUrl } from '@/lib/supabase/urls';

/** Service-role client for the Auth admin API, the profiles write and
 *  the audit row. Only reached after the RPC has authorised the caller. */
function supabaseAdmin() {
  return createAdminClient(
    serverSupabaseUrl(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

const PROBLEM_MESSAGES: Record<MemberDetailsProblem, string> = {
  nameRequired: 'Enter their name.',
  nameTooLong: `The name is too long: at most ${MAX_MEMBER_NAME_LENGTH} characters.`,
  emailRequired: 'Enter their email address.',
  emailInvalid: 'Enter a valid email address.',
  emailTooLong: `The email address is too long: at most ${MAX_MEMBER_EMAIL_LENGTH} characters.`,
};

const EMAIL_TAKEN = 'That email is already used by another login.';

const NOT_CHANGED =
  'Could not change the details. Nothing was changed; try again.';

type Field = 'full_name' | 'email';

// The RPC's SQLSTATEs, as the password route maps them: 42501 (not
// allowed, which includes a person outside this workspace) is 403,
// 22023 (their own details, or no such person) is 400. The message is
// the RAISE text from migration 167 or 083.
function rpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === '42501') {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err.code === '22023') {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error('[member details route] unexpected RPC error:', {
    code: err.code,
    message: err.message,
  });
  return NextResponse.json(
    { error: 'Failed to change the details' },
    { status: 500 }
  );
}

/** GoTrue's answer to an address another login already has. */
function isEmailTaken(err: {
  status?: number;
  code?: string;
  message?: string;
}): boolean {
  if (err.code === 'email_exists') return true;
  // Older GoTrue answers a bare 422 worded "... already been registered".
  return err.status === 422 && /already.*registered/i.test(err.message ?? '');
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:memberDetails:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const body = (await request.json().catch(() => null)) as {
      full_name?: unknown;
      email?: unknown;
    } | null;
    if (typeof body?.full_name !== 'string') {
      return NextResponse.json(
        { error: PROBLEM_MESSAGES.nameRequired },
        { status: 400 }
      );
    }
    if (typeof body.email !== 'string') {
      return NextResponse.json(
        { error: PROBLEM_MESSAGES.emailRequired },
        { status: 400 }
      );
    }
    const next = normalizeMemberDetails({
      full_name: body.full_name,
      email: body.email,
    });
    const problem = memberDetailsProblem(next);
    if (problem) {
      return NextResponse.json(
        { error: PROBLEM_MESSAGES[problem] },
        { status: 400 }
      );
    }

    const { error: authzError } = await ctx.supabase.rpc(
      'authorize_member_details_change',
      { p_user_id: userId }
    );
    if (authzError) return rpcErrorToResponse(authzError);

    const admin = supabaseAdmin();
    const { data: current, error: readError } = await admin
      .from('profiles')
      .select('full_name, email')
      .eq('user_id', userId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (readError || !current) {
      console.error(
        `[member details route] could not read the profile of ${userId}:`,
        readError ? { code: readError.code } : 'no row'
      );
      return NextResponse.json({ error: NOT_CHANGED }, { status: 502 });
    }

    const changed: Field[] = [];
    if (next.full_name !== (current.full_name ?? '')) changed.push('full_name');
    if (next.email !== (current.email ?? '').toLowerCase()) {
      changed.push('email');
    }
    const member = { user_id: userId, ...next };
    if (changed.length === 0) {
      return NextResponse.json({ ok: true, member, changed });
    }

    const emailChanged = changed.includes('email');
    if (emailChanged) {
      const { error: authError } = await admin.auth.admin.updateUserById(
        userId,
        { email: next.email, email_confirm: true }
      );
      if (authError) {
        if (isEmailTaken(authError)) {
          return NextResponse.json({ error: EMAIL_TAKEN }, { status: 409 });
        }
        console.error(
          `[member details route] GoTrue refused the email change for ${userId}:`,
          { status: authError.status, code: authError.code }
        );
        return NextResponse.json({ error: NOT_CHANGED }, { status: 502 });
      }
    }

    // Every row of the person: the propagation trigger would copy them
    // anyway, and this way no row is left behind if it ever did not.
    const { error: profileError } = await admin
      .from('profiles')
      .update({ full_name: next.full_name, email: next.email })
      .eq('user_id', userId);
    if (profileError) {
      console.error(
        `[member details route] profiles update failed for ${userId}:`,
        { code: profileError.code }
      );
      if (emailChanged) {
        const { error: revertError } = await admin.auth.admin.updateUserById(
          userId,
          { email: current.email, email_confirm: true }
        );
        if (revertError) {
          console.error(
            `[member details route] could not put back the login email of ${userId}; login and profile now disagree:`,
            { status: revertError.status, code: revertError.code }
          );
        }
      }
      return NextResponse.json({ error: NOT_CHANGED }, { status: 502 });
    }

    const detail: Record<string, unknown> = { changed };
    if (changed.includes('full_name')) {
      detail.name_from = current.full_name;
      detail.name_to = next.full_name;
    }
    if (emailChanged) {
      detail.email_from = current.email;
      detail.email_to = next.email;
    }
    const { error: auditError } = await admin.rpc('log_member_details_change', {
      p_actor_id: ctx.userId,
      p_user_id: userId,
      p_detail: detail,
    });
    if (auditError) {
      // The details have changed and stay changed: say so in the log,
      // and still answer ok.
      console.error(
        `[member details route] details changed for ${userId} but the audit row was not written:`,
        { code: auditError.code, message: auditError.message }
      );
    }

    return NextResponse.json({ ok: true, member, changed });
  } catch (err) {
    return toErrorResponse(err);
  }
}
