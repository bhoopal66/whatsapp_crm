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

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  ASSIGNABLE_ROLES,
  canManageMembers,
  isAccountRole,
  type AssignableRole,
} from "@/lib/auth/roles";
import { serverSupabaseUrl } from "@/lib/supabase/urls";
import type { AccountMember } from "@/types";


/** Matches the minimum GoTrue enforces, stated here so the caller gets
 *  a useful message instead of a raw provider error. */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Service-role client. Creating a login is an admin-API operation and
 * cannot be done with the caller's own token; the route authorises the
 * caller first and only then reaches for this.
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
// Create a teammate's login directly, with their role chosen up
// front. This replaces self-service signup: /signup is gone, so an
// admin provisioning the account is the ONLY way in.
//
// Order matters. The auth user is created first, which fires
// `handle_new_user()` and hands them their own private account; the
// `provision_account_member` RPC then moves them into the caller's
// account and discards that orphan. If the RPC fails we delete the
// auth user again, because a login that exists but belongs to an
// invisible account is worse than no login: nobody can see it to fix
// it, and the email is now taken so the admin cannot simply retry.
// ============================================================
export async function POST(request: Request) {
  try {
    // Same gate as the rest of the Members tab.
    const ctx = await requireRole("admin");

    const body = await request.json().catch(() => ({}));
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
    const role = body.role;

    if (!email || !email.includes("@")) {
      return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
        { status: 400 },
      );
    }
    if (!ASSIGNABLE_ROLES.includes(role as AssignableRole)) {
      return NextResponse.json(
        { error: `Role must be one of: ${ASSIGNABLE_ROLES.join(", ")}` },
        { status: 400 },
      );
    }

    const admin = supabaseAdmin();

    // `email_confirm: true` because an admin typing the address IS the
    // verification, and this deployment has no outbound mail — waiting
    // on a confirmation link nobody receives would lock the new user
    // out permanently.
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });

    if (createError || !created?.user) {
      const message = createError?.message ?? "Failed to create the user";
      // GoTrue reports a taken address with 422; surface it as a
      // conflict so the dialog can point at the email field.
      const taken = /already|registered|exists/i.test(message);
      return NextResponse.json(
        { error: taken ? "That email already has an account" : message },
        { status: taken ? 409 : 500 },
      );
    }

    const newUserId = created.user.id;

    const { error: moveError } = await admin.rpc("provision_account_member", {
      p_user_id: newUserId,
      p_account_id: ctx.accountId,
      p_role: role,
    });

    if (moveError) {
      // Compensating delete — see the header comment.
      const { error: cleanupError } = await admin.auth.admin.deleteUser(newUserId);
      if (cleanupError) {
        console.error(
          `[POST /api/account/members] orphaned auth user ${newUserId} after a failed move; delete it manually:`,
          cleanupError,
        );
      }
      console.error("[POST /api/account/members] provision failed:", moveError);
      return NextResponse.json(
        { error: "Could not add the user to this account" },
        { status: 500 },
      );
    }

    const member: AccountMember = {
      user_id: newUserId,
      full_name: fullName,
      email,
      avatar_url: null,
      role: role as AssignableRole,
      joined_at: new Date().toISOString(),
      deactivated_at: null,
    };

    return NextResponse.json({ member }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
