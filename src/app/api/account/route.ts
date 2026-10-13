// ============================================================
// /api/account
//
//   GET   — current caller's account + role. Any member.
//   PATCH — rename the workspace: `{ name?, short_name? }`, at
//           least one; only the fields sent change. Admin+.
//           Answers `{ account: { id, name, short_name } }`.
//
// The rules are create_workspace()'s (lib/workspaces/form): a trimmed
// name of 1–80 characters, a short name of 1–4 ASCII letters or digits
// (the rail's tile; 083's CHECK holds 1–4 trimmed characters). Settings
// → Workspace is the caller.
//
// Why both verbs share a route file
//   They speak about the same singular resource (the caller's
//   account) and reuse the same `requireRole` plumbing. Splitting
//   them across files would duplicate the `account_id` lookup
//   without buying anything.
// ============================================================

import { NextResponse } from 'next/server';

import {
  requireRole,
  getCurrentAccount,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  MAX_WORKSPACE_NAME,
  shortNameError,
  workspaceNameError,
  type WorkspaceNameError,
} from '@/lib/workspaces/form';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json({
      account: ctx.account,
      role: ctx.role,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

const NAME_ERRORS: Record<WorkspaceNameError, string> = {
  nameRequired: 'Account name cannot be empty',
  nameTooLong: `Account name must be ${MAX_WORKSPACE_NAME} characters or fewer`,
};

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin');

    // Per-user limit on admin-class mutations. Bounds accidental
    // abuse (script run in a loop) and a compromised admin session
    // spamming renames. Each admin endpoint keys its own bucket so
    // one route doesn't starve another.
    const limit = checkRateLimit(
      `admin:rename:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      short_name?: unknown;
    } | null;
    const rawName = body?.name;
    const rawShortName = body?.short_name;

    if (rawName === undefined && rawShortName === undefined) {
      return NextResponse.json(
        { error: "Send 'name' or 'short_name'" },
        { status: 400 }
      );
    }

    const update: { name?: string; short_name?: string } = {};
    if (rawName !== undefined) {
      if (typeof rawName !== 'string') {
        return NextResponse.json(
          { error: "'name' must be a string" },
          { status: 400 }
        );
      }
      const nameError = workspaceNameError(rawName);
      if (nameError) {
        return NextResponse.json(
          { error: NAME_ERRORS[nameError] },
          { status: 400 }
        );
      }
      update.name = rawName.trim();
    }
    if (rawShortName !== undefined) {
      if (typeof rawShortName !== 'string' || shortNameError(rawShortName)) {
        return NextResponse.json(
          { error: "'short_name' must be 1–4 letters or digits" },
          { status: 400 }
        );
      }
      update.short_name = rawShortName.trim();
    }

    // RLS allows this UPDATE because accounts_update requires
    // `is_account_member(id, 'admin')`, and requireRole already
    // guaranteed the caller is admin+.
    const { data, error } = await ctx.supabase
      .from('accounts')
      .update(update)
      .eq('id', ctx.accountId)
      .select('id, name, short_name')
      .single();

    if (error) {
      console.error('[PATCH /api/account] update error:', error);
      return NextResponse.json(
        { error: 'Failed to update account' },
        { status: 500 }
      );
    }

    return NextResponse.json({ account: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
