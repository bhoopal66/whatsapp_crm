// ============================================================
// GET /api/account/members
//
// Lists every member of the caller's account. Admin+ only.
//
// It used to be readable by any member — agents and viewers got a
// names-only roster with emails stripped. That went with Settings ->
// Team members becoming an admin-only section: the roster is now
// consumed solely by admin surfaces (the Members tab, the create-user
// dialog, the automation builder's assignee picker), so leaving the
// endpoint open would have left the section's data reachable by a
// route the UI no longer offers.
//
// Agent-facing features that need teammate NAMES — assignment labels
// in the inbox, for one — read `profiles` directly under RLS and are
// unaffected by this.
//
// The `canSeeEmails` branch below is now always true in practice; it
// is kept rather than inlined so the field-visibility rule survives if
// this is ever reopened to more roles.
// ============================================================

import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

import {
  ADDABLE_ROLES,
  addOrCreateMember,
  isAddableRole,
} from "@/lib/account/add-member";
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import {
  canGrantRole,
  canInviteMembers,
  canManageMembers,
  isAccountRole,
} from "@/lib/auth/roles";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { serverSupabaseUrl } from "@/lib/supabase/urls";
import type { AccountMember } from "@/types";


/**
 * Service-role client. Creating a login is an admin-API operation and
 * cannot be done with the caller's own token; `add_workspace_member`
 * authorises the caller before `addOrCreateMember` reaches for this,
 * and only an owner's or admin's call may create a login.
 */
function supabaseAdmin() {
  return createAdminClient(
    serverSupabaseUrl(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

interface ProfileRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  account_role: string;
  created_at: string;
  deactivated_at: string | null;
  /** Migration 083; undefined on a database that predates it. */
  bank_code?: string | null;
}

export async function GET() {
  try {
    const ctx = await requireRole("admin");

    // RLS on profiles allows reading any row whose account matches
    // the caller's, so this query is naturally account-scoped; since
    // migration 083 it also returns the caller's own row in every other
    // workspace, hence the explicit `account_id` filter.
    //
    // `*` rather than a column list so a database without 083 (no
    // `bank_code` yet) still answers: naming a missing column fails the
    // whole select. The mapping below picks the fields that are returned.
    const { data, error } = await ctx.supabase
      .from("profiles")
      .select("*")
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[GET /api/account/members] fetch error:", error);
      return NextResponse.json(
        { error: "Failed to load members" },
        { status: 500 },
      );
    }

    const canSeeEmails = canManageMembers(ctx.role);

    const members: AccountMember[] = (data as ProfileRow[]).flatMap((row) => {
      // Defensive: the DB enum should never let an unknown role
      // through, but if a migration ever broadens the enum without
      // updating TS, skip the row rather than crash the page.
      if (!isAccountRole(row.account_role)) return [];
      return [
        {
          user_id: row.user_id,
          full_name: row.full_name ?? "",
          email: canSeeEmails ? row.email : null,
          avatar_url: row.avatar_url,
          role: row.account_role,
          joined_at: row.created_at,
          deactivated_at: row.deactivated_at ?? null,
          bank_code: row.bank_code ?? null,
        },
      ];
    });

    return NextResponse.json({ members });
  } catch (err) {
    return toErrorResponse(err);
  }
}

// ============================================================
// POST /api/account/members
//
// Add a person to the caller's workspace, with their role chosen up
// front: one of `ASSIGNABLE_ROLES`, or `bank_guest` with a `bankCode`.
// There is no self-service signup, so someone adding them is the ONLY
// way in: an owner or admin with any of those roles, or (migration 099)
// a team leader with an agent or viewer role (`canGrantRole`).
// `add_workspace_member` applies the same rule.
//
// Body: { email, role, full_name?, password?, bankCode? }. Since
// migration 083 the email decides what happens (`addOrCreateMember`):
// an existing login gets a row here and needs no password; a new one
// is created with `password` and moved in. 201 { member, created }.
//
// Only an owner or admin creates a login (`mayCreateLogin`): whoever
// does chooses its password and claims its address. A team leader adds
// an existing login (083's rule: someone they administer elsewhere) and
// invites anyone else by link; `add_workspace_member` never answers
// them the P0002 that leads to the service-role provision (099).
// ============================================================
export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    if (!canInviteMembers(ctx.role)) {
      return NextResponse.json(
        { error: "Adding people requires the team leader role or higher" },
        { status: 403 },
      );
    }

    // 30/min per user, as for invite links: a script in a loop or a
    // compromised session cannot add people, or create logins, without
    // bound.
    const limit = checkRateLimit(
      `admin:memberAdd:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => ({}));
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
    const bankCode = typeof body.bankCode === "string" ? body.bankCode.trim() : "";
    const role = body.role;

    if (!email || !email.includes("@")) {
      return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
    }
    if (!isAddableRole(role)) {
      return NextResponse.json(
        { error: `Role must be one of: ${ADDABLE_ROLES.join(", ")}` },
        { status: 400 },
      );
    }
    if (!canGrantRole(ctx.role, role)) {
      return NextResponse.json(
        { error: "A team leader can add agents and viewers only" },
        { status: 403 },
      );
    }

    const result = await addOrCreateMember({
      supabase: ctx.supabase,
      admin: supabaseAdmin(),
      accountId: ctx.accountId,
      email,
      role,
      bankCode: bankCode || null,
      password,
      fullName,
      mayCreateLogin: canManageMembers(ctx.role),
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    let member: AccountMember = {
      user_id: result.userId,
      full_name: fullName,
      email,
      avatar_url: null,
      role,
      joined_at: new Date().toISOString(),
      deactivated_at: null,
      bank_code: role === "bank_guest" ? bankCode : null,
    };

    if (!result.created) {
      // An existing login brings the name and avatar of its other
      // workspaces: read the row add_workspace_member just made.
      const { data: row } = await ctx.supabase
        .from("profiles")
        .select("*")
        .eq("user_id", result.userId)
        .eq("account_id", ctx.accountId)
        .maybeSingle();
      if (row) {
        const profile = row as ProfileRow;
        member = {
          ...member,
          full_name: profile.full_name ?? "",
          email: profile.email ?? email,
          avatar_url: profile.avatar_url,
          joined_at: profile.created_at,
        };
      }
    }

    return NextResponse.json({ member, created: result.created }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
