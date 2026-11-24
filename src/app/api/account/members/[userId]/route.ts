// ============================================================
// /api/account/members/[userId]
//
//   PATCH  — change a member's role, deactivate / reactivate them,
//            allow personal WhatsApp, or allow reviewing every call
//            ({ role }, { active }, { personalWhatsapp },
//            { reviewAllCalls } or { department }).   Admin+.
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

import {
  requireRole,
  toErrorResponse,
  type AccountContext,
} from "@/lib/auth/account";
import { isDepartment } from "@/lib/auth/departments";
import { isAccountRole } from "@/lib/auth/roles";
import { cutMemberSeats } from "@/lib/meetings/cut";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { serverSupabaseUrl } from "@/lib/supabase/urls";
import { disconnectPersonalNumbersOf } from "@/lib/whatsapp/personal-offboarding";

/** GoTrue takes a Go duration; ~100 years is "until lifted". */
const BAN_DURATION = "876000h";

/** Service-role client for the Auth admin API (ban / unban) and the
 *  person's rows elsewhere. Writes only after the RPC has authorised the
 *  caller. */
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
      | {
          role?: unknown;
          active?: unknown;
          personalWhatsapp?: unknown;
          reviewAllCalls?: unknown;
          department?: unknown;
        }
      | null;

    if (body && "personalWhatsapp" in body) {
      if (typeof body.personalWhatsapp !== "boolean") {
        return NextResponse.json(
          { error: "'personalWhatsapp' must be true or false" },
          { status: 400 },
        );
      }
      return setPersonalWhatsapp(ctx, userId, body.personalWhatsapp);
    }

    if (body && "reviewAllCalls" in body) {
      if (typeof body.reviewAllCalls !== "boolean") {
        return NextResponse.json(
          { error: "'reviewAllCalls' must be true or false" },
          { status: 400 },
        );
      }
      return setCallReview(ctx, userId, body.reviewAllCalls);
    }

    if (body && "department" in body) {
      if (!isDepartment(body.department)) {
        return NextResponse.json(
          { error: "'department' must be one of sales, hr, it, accounts" },
          { status: 400 },
        );
      }
      return setDepartment(ctx, userId, body.department);
    }

    if (body && "active" in body) {
      if (typeof body.active !== "boolean") {
        return NextResponse.json(
          { error: "'active' must be true or false" },
          { status: 400 },
        );
      }
      return setActive(ctx, userId, body.active);
    }

    const role = body?.role;

    if (!isAccountRole(role)) {
      return NextResponse.json(
        { error: "'role' must be one of owner, admin, team_leader, agent, viewer" },
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
 * Put a member in a department (migration 192). `set_member_department`
 * authorises the caller (owner/admin) and refuses an unknown department
 * or a person who is not a member of this workspace.
 */
async function setDepartment(
  ctx: AccountContext,
  userId: string,
  department: string,
): Promise<NextResponse> {
  const { error } = await ctx.supabase.rpc("set_member_department", {
    p_user_id: userId,
    p_department: department,
  });
  if (!error) return NextResponse.json({ ok: true });

  if (error.code === "42501") {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (error.code === "22023") {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error.code === "P0002") {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }
  console.error("[members route] set_member_department error:", error);
  return NextResponse.json(
    { error: "Failed to update member" },
    { status: 500 },
  );
}

/**
 * Let a member connect (or stop letting them connect) a personal
 * WhatsApp number (migration 190). `set_member_personal_whatsapp`
 * authorises the caller and refuses ineligible targets and a revoke
 * while the person still has a personal number; its HINT tells the
 * last two apart because both are SQLSTATE 22023.
 */
async function setPersonalWhatsapp(
  ctx: AccountContext,
  userId: string,
  allowed: boolean,
): Promise<NextResponse> {
  const { error } = await ctx.supabase.rpc("set_member_personal_whatsapp", {
    p_user_id: userId,
    p_allowed: allowed,
  });
  if (!error) return NextResponse.json({ ok: true });

  if (error.code === "22023" && error.hint === "PERSONAL_NUMBER_EXISTS") {
    return NextResponse.json(
      { error: "personal_number_exists" },
      { status: 409 },
    );
  }
  if (error.code === "22023" && error.hint === "not_eligible") {
    return NextResponse.json({ error: "not_eligible" }, { status: 422 });
  }
  if (error.code === "P0002") {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }
  if (error.code === "42501") {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  console.error("[members route] set_member_personal_whatsapp error:", error);
  return NextResponse.json(
    { error: "Failed to update member" },
    { status: 500 },
  );
}

/**
 * Let a member review every call of the workspace (migration 198).
 * `set_member_call_review` authorises the caller and refuses ineligible
 * targets; the HINT tells the two SQLSTATE 22023 refusals apart.
 */
async function setCallReview(
  ctx: AccountContext,
  userId: string,
  allowed: boolean,
): Promise<NextResponse> {
  const { error } = await ctx.supabase.rpc("set_member_call_review", {
    p_user_id: userId,
    p_allowed: allowed,
  });
  if (!error) return NextResponse.json({ ok: true });

  if (error.code === "22023" && error.hint === "not_eligible") {
    return NextResponse.json({ error: "not_eligible" }, { status: 422 });
  }
  if (error.code === "22023") {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error.code === "P0002") {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }
  if (error.code === "42501") {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  console.error("[members route] set_member_call_review error:", error);
  return NextResponse.json(
    { error: "Failed to update member" },
    { status: 500 },
  );
}

/**
 * Deactivate or reactivate a member. Whether they work elsewhere is read
 * first: a read that fails then has changed nothing. Two writes follow,
 * in this order:
 *
 *   1. `set_member_active` — authorises the caller (admin+, same
 *      account, not the owner, not self) and flips
 *      `profiles.deactivated_at` on this workspace's row only. From
 *      here RLS hands the member nothing here, even on an access token
 *      that is still valid.
 *   2. The Auth ban — refuses their password sign-in and every token
 *      refresh. The login is shared by every workspace the person is in
 *      (083), so it is banned only when no other workspace still has
 *      them active; reactivation always lifts it.
 *
 * The ban runs second because only the RPC knows whether the caller may
 * touch this user. If it fails, the flag is put back: a member shown as
 * deactivated who can still sign in (or shown active who cannot) is worse
 * than a clear error the admin can retry. What the deactivation's triggers
 * took (199, 256) is not given back, and the answer says so.
 *
 * Last, once the deactivation stands, the person's personal WhatsApp
 * number of this workspace is disconnected (they can no longer do it). A
 * failure there only adds a `warning`. Reactivating reconnects nothing.
 * The call they are in, if any, is cut with it (`cutMemberSeats`).
 */
async function setActive(
  ctx: AccountContext,
  userId: string,
  active: boolean,
): Promise<NextResponse> {
  const admin = supabaseAdmin();

  const elsewhere = active
    ? false
    : await worksElsewhere(admin, ctx.accountId, userId);
  if (elsewhere === null) {
    return NextResponse.json(
      {
        error:
          "Could not check this person's other workspaces. Nothing was changed; try again.",
      },
      { status: 502 },
    );
  }

  const { error } = await ctx.supabase.rpc("set_member_active", {
    p_user_id: userId,
    p_active: active,
  });
  if (error) return rpcErrorToResponse(error);

  // Still working elsewhere: the deactivation is this workspace's row
  // alone, and the login stays open for the others. Asked again now that
  // it stands, or two workspaces letting the person go at the same moment
  // would each leave the ban to the other. A failed second read keeps the
  // first answer.
  if (
    elsewhere &&
    (await worksElsewhere(admin, ctx.accountId, userId)) !== false
  ) {
    return NextResponse.json({
      ok: true,
      active,
      ...(await departed(admin, ctx.accountId, userId)),
    });
  }

  const { error: banError } = await admin.auth.admin.updateUserById(
    userId,
    { ban_duration: active ? "none" : BAN_DURATION },
  );
  if (banError) {
    console.error(
      `[members route] ${active ? "unban" : "ban"} failed for ${userId}:`,
      banError,
    );
    return revertActive(ctx.supabase, userId, active);
  }

  return NextResponse.json({
    ok: true,
    active,
    ...(active
      ? {}
      : await departed(admin, ctx.accountId, userId)),
  });
}

/**
 * Has the person a live row in another workspace? NULL when it cannot be
 * read. Service role: the caller cannot read the person's rows in
 * workspaces they are not in themselves.
 */
async function worksElsewhere(
  admin: SupabaseClient,
  accountId: string,
  userId: string,
): Promise<boolean | null> {
  const { data, error } = await admin
    .from("profiles")
    .select("account_id")
    .eq("user_id", userId)
    .is("deactivated_at", null)
    .neq("account_id", accountId)
    .limit(1);
  if (error) {
    console.error(
      `[members route] could not read ${userId}'s other memberships:`,
      error,
    );
    return null;
  }
  return (data?.length ?? 0) > 0;
}

/**
 * What a departure that stands takes with it: the person's seat in any
 * call they are in here, and their own number. The answer is what to tell
 * the admin; a seat that could not be cut is left to the minute sweep.
 */
async function departed(
  admin: SupabaseClient,
  accountId: string,
  userId: string,
): Promise<{ warning?: "personal_number_not_disconnected" }> {
  const [warning] = await Promise.all([
    personalNumberWarning(admin, accountId, userId),
    cutMemberSeats(admin, accountId, userId),
  ]);
  return warning;
}

/** Disconnect the departed person's own number; what to tell the admin. */
async function personalNumberWarning(
  admin: SupabaseClient,
  accountId: string,
  userId: string,
): Promise<{ warning?: "personal_number_not_disconnected" }> {
  return (await disconnectPersonalNumbersOf(admin, accountId, userId))
    ? {}
    : { warning: "personal_number_not_disconnected" };
}

/**
 * Put the flag back after the login could not be brought in line, and say
 * how things now stand. `code` is what the screen translates.
 */
async function revertActive(
  supabase: SupabaseClient,
  userId: string,
  active: boolean,
): Promise<NextResponse> {
  const { error: revertError } = await supabase.rpc("set_member_active", {
    p_user_id: userId,
    p_active: !active,
  });
  if (revertError) {
    console.error(
      `[members route] could not revert set_member_active for ${userId}; profile and login now disagree:`,
      revertError,
    );
    return NextResponse.json(
      active
        ? {
            error:
              "They are active here again, but their login is still disabled: deactivate them and try again.",
            code: "reactivation_half_done",
          }
        : {
            error:
              "They are deactivated here, but their login could not be disabled: reactivate them, then deactivate them again.",
            code: "deactivation_half_done",
          },
      { status: 502 },
    );
  }
  return NextResponse.json(
    active
      ? {
          error:
            "Could not re-enable this user's login. Nothing was changed; try again.",
        }
      : {
          error:
            "Could not disable this user's login. They are active again, but any team, phone extension and report access they had were cleared: set them again.",
          code: "deactivation_undone",
        },
    { status: 502 },
  );
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

    // A ban a deactivation put on the login is NOT lifted here, though the
    // person may now own nothing but an empty private account: somebody
    // who was removed must not be able to sign in. Adding them back is what
    // lifts it (`addOrCreateMember`).
    //
    // The person's new personal account when this was their only
    // workspace; NULL when they keep another membership (083).
    return NextResponse.json({
      ok: true,
      newPersonalAccountId: (data as string | null) ?? null,
      ...(await departed(supabaseAdmin(), ctx.accountId, userId)),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
