// ============================================================
// /api/account/members/[userId]
//
//   PATCH  — change a member's role, or deactivate / reactivate
//            them ({ role } or { active }).   Admin+.
//   DELETE — remove a member.                 Admin+.
//
// All delegate to SECURITY DEFINER RPCs:
//   - set_member_role(p_user_id, p_new_role)      (018)
//   - remove_account_member(p_user_id)            (018)
//   - set_member_active(p_user_id, p_active)      (069)
//
// The RPCs do the *real* authorisation work — caller must be
// admin+, target must be in caller's account, target can't be the
// owner, can't be self. The TS layer here only forwards the call
// and maps Postgres SQLSTATEs back to HTTP statuses.
// ============================================================

import { NextResponse } from "next/server";
import {
  createClient as createAdminClient,
  type PostgrestError,
  type SupabaseClient,
} from "@supabase/supabase-js";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { isAccountRole } from "@/lib/auth/roles";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { serverSupabaseUrl } from "@/lib/supabase/urls";

/** GoTrue takes a Go duration; ~100 years is "until lifted". */
const BAN_DURATION = "876000h";

/** Service-role client for the Auth admin API (ban / unban). Only
 *  reached after the RPC has authorised the caller. */
function supabaseAdmin() {
  return createAdminClient(
    serverSupabaseUrl(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

// Map known SQLSTATEs from the RPCs (see migration 018) onto HTTP
// statuses. The `error.code` field is the SQLSTATE; the `message`
// is the human-readable RAISE message we put in the migration.
function rpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === "42501") {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err.code === "22023") {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error("[members route] unexpected RPC error:", err);
  return NextResponse.json(
    { error: "Failed to update member" },
    { status: 500 },
  );
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:memberRole:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const body = (await request.json().catch(() => null)) as
      | { role?: unknown; active?: unknown }
      | null;

    if (body && "active" in body) {
      if (typeof body.active !== "boolean") {
        return NextResponse.json(
          { error: "'active' must be true or false" },
          { status: 400 },
        );
      }
      return setActive(ctx.supabase, userId, body.active);
    }

    const role = body?.role;

    if (!isAccountRole(role)) {
      return NextResponse.json(
        { error: "'role' must be one of owner, admin, agent, viewer" },
        { status: 400 },
      );
    }

    // The RPC blocks promotion to / demotion from owner, but
    // surface the friendlier 400 before crossing the wire too.
    if (role === "owner") {
      return NextResponse.json(
        {
          error:
            "Use POST /api/account/transfer-ownership to promote a member to owner",
        },
        { status: 400 },
      );
    }

    const { error } = await ctx.supabase.rpc("set_member_role", {
      p_user_id: userId,
      p_new_role: role,
    });

    if (error) return rpcErrorToResponse(error);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Deactivate or reactivate a member. Two writes, in this order:
 *
 *   1. `set_member_active` — authorises the caller (admin+, same
 *      account, not the owner, not self) and flips
 *      `profiles.deactivated_at`. From here RLS hands a deactivated
 *      member nothing, even on an access token that is still valid.
 *   2. The Auth ban — refuses their password sign-in and every token
 *      refresh, which is what actually keeps them out of the app.
 *
 * The ban runs second because only the RPC knows whether the caller may
 * touch this user. If it fails, the flag is put back: a member shown as
 * deactivated who can still sign in (or shown active who cannot) is
 * worse than a clear error the admin can retry.
 */
async function setActive(
  supabase: SupabaseClient,
  userId: string,
  active: boolean,
): Promise<NextResponse> {
  const { error } = await supabase.rpc("set_member_active", {
    p_user_id: userId,
    p_active: active,
  });
  if (error) return rpcErrorToResponse(error);

  const { error: banError } = await supabaseAdmin().auth.admin.updateUserById(
    userId,
    { ban_duration: active ? "none" : BAN_DURATION },
  );
  if (banError) {
    console.error(
      `[members route] ${active ? "unban" : "ban"} failed for ${userId}:`,
      banError,
    );
    const { error: revertError } = await supabase.rpc("set_member_active", {
      p_user_id: userId,
      p_active: !active,
    });
    if (revertError) {
      console.error(
        `[members route] could not revert set_member_active for ${userId}; profile and login now disagree:`,
        revertError,
      );
    }
    return NextResponse.json(
      {
        error: active
          ? "Could not re-enable this user's login. Nothing was changed; try again."
          : "Could not disable this user's login. Nothing was changed; try again.",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, active });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:memberRemove:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const { data, error } = await ctx.supabase.rpc("remove_account_member", {
      p_user_id: userId,
    });

    if (error) return rpcErrorToResponse(error);

    return NextResponse.json({ ok: true, newPersonalAccountId: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
