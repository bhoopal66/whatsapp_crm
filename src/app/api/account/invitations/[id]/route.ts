// ============================================================
// DELETE /api/account/invitations/[id]
//
// Team leader and up. Revokes a pending invitation by id. RLS on
// `account_invitations` already restricts the DELETE to admins of
// the inviting account, and a team leader to the agent/viewer links
// they made themselves (migration 099); we lean on it and skip the
// explicit ownership check.
//
// We intentionally delete the row outright rather than soft-
// deleting (a "revoked_at" flag). Once revoked, an invite is
// dead forever — there's no UX where a former invite should be
// listed; the plaintext token is gone too. Hard delete keeps
// the table small.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { canInviteMembers } from "@/lib/auth/roles";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getCurrentAccount();
    if (!canInviteMembers(ctx.role)) {
      return NextResponse.json(
        { error: "Revoking invitations requires the team leader role or higher" },
        { status: 403 },
      );
    }

    const limit = checkRateLimit(
      `admin:inviteRevoke:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    // No `eq('account_id', ctx.accountId)` — the RLS policies
    // (`is_account_member(account_id, 'admin')`, and 099's leader
    // policy) already scope the DELETE to invites in the caller's
    // account. Adding the
    // filter would be redundant; omitting it surfaces a
    // cross-account attempt as a silent 0-row delete (which is
    // exactly what we want for a revocation endpoint).
    const { error, count } = await ctx.supabase
      .from("account_invitations")
      .delete({ count: "exact" })
      .eq("id", id);

    if (error) {
      console.error("[DELETE /api/account/invitations/[id]] error:", error);
      return NextResponse.json(
        { error: "Failed to revoke invitation" },
        { status: 500 },
      );
    }

    if (count === 0) {
      // Either the id doesn't exist or RLS hid it (different
      // account). 404 either way — surfacing "exists but not
      // yours" would leak existence.
      return NextResponse.json(
        { error: "Invitation not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
