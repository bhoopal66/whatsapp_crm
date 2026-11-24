// ============================================================
// Server-side account context — for API routes and server
// components. Reads the caller's profile + account in one round
// trip and verifies role on demand.
//
// IMPORTANT: this module is server-only. It imports the Supabase
// SSR client (`@/lib/supabase/server`), which reads `next/headers`
// cookies. Importing it from a client component will fail at
// build time with the standard Next.js "You're importing a
// component that needs `next/headers`" error — that's the
// boundary check; we don't need the `server-only` package.
//
// Calling convention
// ------------------
// API routes don't need to redo `supabase.auth.getUser()` — they
// receive a fully-loaded context from `requireRole`:
//
//   try {
//     const ctx = await requireRole("admin");
//     // ctx.supabase — the SSR client (RLS scoped to this user)
//     // ctx.userId  — auth.uid()
//     // ctx.accountId / ctx.role / ctx.account
//   } catch (err) {
//     return errorResponse(err); // see toErrorResponse() below
//   }
// ============================================================

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { pickActiveProfile } from "./active-profile";
import { AuthUnavailableError, isAuthUnavailable } from "./auth-unavailable";
import { hasMinRole, isAccountRole, type AccountRole } from "./roles";
import {
  isSalesRestricted,
  toDepartment,
  type Department,
} from "./departments";

// ------------------------------------------------------------
// Errors
//
// Custom classes so API routes can map a single `catch` to the
// right HTTP status without sprinkling 401/403 strings everywhere.
// ------------------------------------------------------------

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Convert one of the typed errors above (or anything else) into a
 * `NextResponse`. Routes can do:
 *
 *   } catch (err) {
 *     return toErrorResponse(err);
 *   }
 *
 * Unknown errors collapse to 500 with the generic message — we
 * never leak `err.message` for non-classified errors to keep
 * server internals out of the wire.
 */
export function toErrorResponse(err: unknown): NextResponse {
  if (
    err instanceof UnauthorizedError ||
    err instanceof ForbiddenError ||
    err instanceof AuthUnavailableError
  ) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[toErrorResponse] uncategorized error:", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

// ------------------------------------------------------------
// Account context
// ------------------------------------------------------------

export interface AccountContext {
  /** Supabase SSR client, RLS scoped to the calling user. */
  supabase: SupabaseClient;
  /** `auth.uid()` for the caller. Always defined when this resolves. */
  userId: string;
  /** Caller's account_id from their profile row. */
  accountId: string;
  /** Caller's role within their account. */
  role: AccountRole;
  /** Lightweight account meta — id + name. */
  account: { id: string; name: string };
  /** Caller's department (migration 192); 'sales' before 192. */
  department: Department;
  /**
   * True if the caller's department is restricted in this account and
   * they are not an owner/admin: the sales areas are closed to them
   * (`lib/auth/departments.ts`).
   */
  salesRestricted: boolean;
}

/**
 * Resolve the caller's user + account + role in one round trip.
 *
 * Throws `UnauthorizedError` if there's no Supabase session.
 * Throws `AuthUnavailableError` (503) if the auth service did not
 * answer or the profile could not be read: neither says who this is.
 * Throws `ForbiddenError` if the profile is missing account
 * fields (shouldn't happen post-017 migration; defensive guard
 * against profile rows that pre-date the backfill or were
 * inserted by hand).
 *
 * Use `requireRole(min)` instead when the route also needs a
 * minimum-role check — it's a thin wrapper over this.
 */
export async function getCurrentAccount(): Promise<AccountContext> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (isAuthUnavailable(userErr)) {
    // No answer from the auth service: that says nothing about the
    // session, so never a 401 (which signs people out).
    console.error("[getCurrentAccount] auth service unavailable:", userErr);
    throw new AuthUnavailableError();
  }
  if (userErr || !user) {
    throw new UnauthorizedError();
  }

  // `*` rather than a column list so this keeps working when
  // `deactivated_at` (migration 069) is not there yet — an unapplied
  // migration or PostgREST's stale schema cache right after one. Naming
  // a missing column fails the whole select, and with it every API route.
  //
  // Since migration 083 the caller has one row per workspace; take the
  // active one — the workspace RLS and `current_account_id()` resolve to.
  // `.maybeSingle()` would error for anyone in two workspaces.
  const { data: rows, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", user.id);
  const data = pickActiveProfile(
    rows as
      | {
          account_id: string | null;
          account_role: string | null;
          deactivated_at?: string | null;
          is_active?: boolean | null;
          department?: string | null;
        }[]
      | null,
  );

  if (error) {
    // A read that failed is not a refusal: 503, so the caller retries.
    console.error("[getCurrentAccount] profile fetch error:", error);
    throw new AuthUnavailableError("Could not load account context");
  }
  if (data?.deactivated_at) {
    // Migration 069. RLS already refuses this caller everything; say
    // why instead of letting the account lookup below fail obscurely.
    // Their login is banned too, so this only answers a session that
    // predates the deactivation.
    throw new ForbiddenError("Your access to this account has been deactivated");
  }
  if (!data || !data.account_id || !data.account_role) {
    // Pre-migration profile, or a manual insert that skipped the
    // signup trigger. The user is authenticated but the app has
    // no way to scope their queries — treat as forbidden.
    throw new ForbiddenError("Profile is not linked to an account");
  }
  if (!isAccountRole(data.account_role)) {
    // The DB enum should make this impossible, but a future
    // migration that broadens the enum without updating TS would
    // hit this — surface it rather than silently widening.
    throw new ForbiddenError(`Unknown account role: ${data.account_role}`);
  }

  // Load the account with a plain point lookup by id rather than an
  // embedded FK join (`account:accounts!inner(...)`). The embed forces
  // PostgREST to resolve the profiles.account_id → accounts.id
  // relationship from its schema cache; when that cache is stale — a
  // common Supabase state right after a migration adds the FK, or when
  // migrations are applied out of band — the embed fails hard with
  // PGRST200 ("could not find a relationship … in the schema cache")
  // and takes down the entire account context (issue #294). A lookup by
  // id needs no relationship inference and is gated by the same accounts
  // RLS, so it stays robust against cache staleness and older schemas.
  const { data: account, error: accountErr } = await supabase
    .from("accounts")
    .select("id, name")
    .eq("id", data.account_id)
    .maybeSingle();

  if (accountErr) {
    // As the profile read above: a failed read is not a refusal.
    console.error("[getCurrentAccount] account fetch error:", accountErr);
    throw new AuthUnavailableError("Could not load account context");
  }
  if (!account) {
    // account_id points at no readable account row — orphaned profile
    // or an RLS gap. Same "can't scope this user" outcome as above.
    throw new ForbiddenError("Profile is not linked to an account");
  }

  const department = toDepartment(data.department);
  const salesRestricted = isSalesRestricted({
    role: data.account_role,
    department,
    // Owners/admins are exempt, and a profile with no `department` key
    // predates migration 192: neither needs the round trip.
    restricted:
      !hasMinRole(data.account_role, "admin") && "department" in data
        ? await departmentRestricted(supabase, data.account_id, department)
        : false,
  });

  return {
    supabase,
    userId: user.id,
    accountId: data.account_id,
    role: data.account_role,
    account: { id: account.id, name: account.name },
    department,
    salesRestricted,
  };
}

/** PostgREST / Postgres codes for "no such function": 192 not applied. */
const MISSING_FUNCTION_CODES = new Set(["PGRST202", "42883"]);

/**
 * SQL `department_restricted()` (migration 192) as the caller. Never
 * throws, and answers false on any failure: failing closed would lock
 * every non-admin out of the sales areas the moment the function is
 * missing or the database hiccups, while RLS still guards the data.
 */
async function departmentRestricted(
  supabase: SupabaseClient,
  accountId: string,
  department: Department,
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("department_restricted", {
      p_account: accountId,
      p_department: department,
    });
    if (error) {
      if (!MISSING_FUNCTION_CODES.has(String(error.code ?? ""))) {
        console.error("[getCurrentAccount] department_restricted:", error);
      }
      return false;
    }
    return data === true;
  } catch (err) {
    console.error("[getCurrentAccount] department_restricted:", err);
    return false;
  }
}

/**
 * Resolve the caller's account context and enforce a minimum role.
 *
 * Throws `UnauthorizedError` / `ForbiddenError` as documented on
 * `getCurrentAccount`, plus `ForbiddenError("Insufficient role")`
 * when the caller is below `min`.
 */
export async function requireRole(min: AccountRole): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(
      `This action requires the '${min}' role or higher`,
    );
  }
  return ctx;
}

/**
 * Resolve the caller's account context and refuse a restricted
 * department (migration 192) with a 403. For the entry routes of the
 * sales areas (`RESTRICTED_PATHS` in `lib/auth/departments.ts`).
 */
export async function requireSalesAccess(): Promise<AccountContext> {
  return assertSalesAccess(await getCurrentAccount());
}

/** The same refusal for a context already loaded (after `requireRole`). */
export function assertSalesAccess(ctx: AccountContext): AccountContext {
  if (ctx.salesRestricted) {
    throw new ForbiddenError("Your department does not have access to this");
  }
  return ctx;
}
