// ============================================================
// The caller's own profile row, since workspaces (migration 083).
//
// profiles became one row per (user, account) with exactly one row
// per person marked `is_active` — the workspace they are working in,
// which is also the one `current_account_id()` and every RLS policy
// read. A lookup of the caller's profile by `user_id` alone now
// returns every membership (RLS hands a person all of their own
// rows), so `.maybeSingle()` errors for anyone in two workspaces and
// `rows[0]` is an arbitrary workspace. Take the active row instead.
//
// `is_active` is absent on a database where 083 is not applied yet
// (callers select `*` so a missing column doesn't fail the read). The
// person then has exactly one row, and it is the one — hence
// `!== false` rather than `=== true`.
// ============================================================

export interface MaybeActiveRow {
  /** Migration 083. Undefined on a database that predates it. */
  is_active?: boolean | null;
}

/** The active row of the caller's own profile rows, else the first. */
export function pickActiveProfile<T extends MaybeActiveRow>(
  rows: readonly T[] | null | undefined
): T | null {
  if (!rows || rows.length === 0) return null;
  return rows.find((row) => row.is_active !== false) ?? rows[0];
}
