// ============================================================
// Adding a person to the caller's workspace (migration 083).
//
// One login can belong to several workspaces, so "add a member" is two
// operations behind one email field:
//
//   - The email has a login: `add_workspace_member` gives it a row in
//     the caller's active workspace. No password; the person keeps the
//     name and avatar of their other rows. A login that is banned
//     because every membership it had was deactivated (PATCH
//     /api/account/members/[userId]) has the ban lifted, or the new row
//     would be a member who cannot sign in.
//   - Otherwise (`P0002 'no_such_user'`): the login is created here
//     with the admin's password and moved in by
//     `provision_account_member`, the path every add took before 083.
//     Only for a caller who may create logins (`mayCreateLogin`, an
//     owner or admin): a team leader is answered `INVITE_BY_LINK`
//     instead, and since migration 099 the RPC never says P0002 to one.
//     The RPC adds only someone the caller already administers in
//     another workspace and answers `no_such_user` for anyone else, so
//     a registered address can still land here; GoTrue then refuses
//     it and the answer is `EMAIL_HAS_LOGIN`, never GoTrue's text.
//
// Shared by POST /api/account/members and the invites of POST
// /api/workspaces. The RPCs authorise the caller and validate the role
// and bank code; this maps their SQLSTATEs onto HTTP statuses. Callers
// check the email's shape and narrow the role first.
// ============================================================

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';

import { ASSIGNABLE_ROLES, type AccountRole } from '@/lib/auth/roles';

/** Matches the minimum GoTrue enforces, stated here so the caller gets
 *  a useful message instead of a raw provider error. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Roles a person can be added with: the assignable staff roles, plus a
 * partner bank's guest, who also needs a bank code.
 */
export const ADDABLE_ROLES = [
  ...ASSIGNABLE_ROLES,
  'bank_guest',
] as const satisfies readonly AccountRole[];

export type AddableRole = (typeof ADDABLE_ROLES)[number];

export function isAddableRole(value: unknown): value is AddableRole {
  return (
    typeof value === 'string' &&
    (ADDABLE_ROLES as readonly string[]).includes(value)
  );
}

export interface AddMemberInput {
  /** The caller's own client. `add_workspace_member` checks they are an
   *  admin of their active workspace, which is where the person lands. */
  supabase: SupabaseClient;
  /** Service role: the Auth admin API and `provision_account_member`. */
  admin: SupabaseClient;
  /** The caller's active workspace; a new login is provisioned into it. */
  accountId: string;
  email: string;
  role: AddableRole;
  /** Required for `bank_guest`, refused for staff (the RPCs enforce both). */
  bankCode?: string | null;
  /** Used, and then required, only when the email has no login yet. */
  password?: string;
  /** Used only for a new login; an existing one keeps its name. */
  fullName?: string;
  /**
   * May the caller create a login? Owner / admin only
   * (`canManageMembers`). Whoever creates one chooses its password and
   * claims its address, so a team leader brings a new person in with an
   * invite link instead (migration 099).
   */
  mayCreateLogin: boolean;
}

/** The one answer for an address that already has a login the caller
 *  may not add (see `add_workspace_member`, migration 083). */
export const EMAIL_HAS_LOGIN =
  "This email already has a login. An administrator of one of that person's workspaces can add them here.";

/** The answer to a caller who may not create logins, for an email that
 *  is no login they may add: one answer for both, as 083 gives one.
 *  `add_workspace_member` raises the same words (42501) since 099. */
export const INVITE_BY_LINK =
  'This email is not a login you can add. Invite them with a link instead.';

export type AddMemberResult =
  | { ok: true; userId: string; created: boolean }
  | { ok: false; status: 400 | 403 | 409 | 500 | 502; error: string };

export async function addOrCreateMember(
  input: AddMemberInput
): Promise<AddMemberResult> {
  const email = input.email.trim().toLowerCase();
  const bankCode = input.bankCode?.trim() || null;

  const { data, error } = await input.supabase.rpc('add_workspace_member', {
    p_email: email,
    p_role: input.role,
    p_bank_code: bankCode,
  });
  if (error) {
    if (error.code === 'P0002' && error.message === 'no_such_user') {
      if (!input.mayCreateLogin) {
        return { ok: false, status: 403, error: INVITE_BY_LINK };
      }
      return createLogin(input, email, bankCode);
    }
    return rpcFailure(error);
  }

  const userId = data as string;
  if (await liftBan(input.admin, userId)) {
    return { ok: true, userId, created: false };
  }

  // Same rule as deactivation: a roster row whose login cannot sign in
  // is worse than a clear error the admin can retry.
  const { error: revertError } = await input.supabase.rpc(
    'remove_account_member',
    { p_user_id: userId }
  );
  if (revertError) {
    console.error(
      `[addOrCreateMember] ${userId} was added but is still banned, and removing them again failed:`,
      revertError
    );
    return {
      ok: false,
      status: 502,
      error:
        'They were added, but their login is still disabled. Deactivate and reactivate them to fix it.',
    };
  }
  return {
    ok: false,
    status: 502,
    error:
      "Could not re-enable this person's login. Nothing was changed; try again.",
  };
}

/**
 * Create the login, then move it into the workspace.
 *
 * Order matters. Creating the auth user fires `handle_new_user()`,
 * which hands them their own private account; `provision_account_member`
 * then moves them into this one and discards that orphan. If the move
 * fails the auth user is deleted again, because a login that exists but
 * belongs to an invisible account is worse than no login: nobody can
 * see it to fix it, and the email is now taken so the admin cannot
 * simply retry.
 */
async function createLogin(
  input: AddMemberInput,
  email: string,
  bankCode: string | null
): Promise<AddMemberResult> {
  const password = input.password ?? '';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `No login uses this email yet: set a password of at least ${MIN_PASSWORD_LENGTH} characters to create one`,
    };
  }

  // `email_confirm: true` because an admin typing the address IS the
  // verification, and this deployment has no outbound mail — waiting
  // on a confirmation link nobody receives would lock the new user
  // out permanently.
  const { data: created, error: createError } =
    await input.admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: input.fullName?.trim() ?? '' },
    });

  if (createError || !created?.user) {
    const message = createError?.message ?? 'Failed to create the user';
    // GoTrue reports a taken address as 422 `email_exists` (older
    // releases only in the wording): a conflict, so the dialog can
    // point at the email field.
    const taken =
      createError?.code === 'email_exists' ||
      /already|registered|exists/i.test(message);
    return {
      ok: false,
      status: taken ? 409 : 500,
      error: taken ? EMAIL_HAS_LOGIN : message,
    };
  }

  const userId = created.user.id;
  const { error: moveError } = await input.admin.rpc(
    'provision_account_member',
    {
      p_user_id: userId,
      p_account_id: input.accountId,
      p_role: input.role,
      p_bank_code: bankCode,
    }
  );

  if (moveError) {
    // Compensating delete — see the comment above.
    const { error: cleanupError } =
      await input.admin.auth.admin.deleteUser(userId);
    if (cleanupError) {
      console.error(
        `[addOrCreateMember] orphaned auth user ${userId} after a failed move; delete it manually:`,
        cleanupError
      );
    }
    console.error('[addOrCreateMember] provision failed:', moveError);
    return {
      ok: false,
      status: 500,
      error: 'Could not add the user to this account',
    };
  }

  return { ok: true, userId, created: true };
}

/** True when the login can sign in afterwards. A login whose state
 *  cannot be read is unbanned anyway: lifting no ban changes nothing. */
async function liftBan(
  admin: SupabaseClient,
  userId: string
): Promise<boolean> {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (!error && !isBanned(data.user?.banned_until)) return true;

  const { error: unbanError } = await admin.auth.admin.updateUserById(userId, {
    ban_duration: 'none',
  });
  if (unbanError) {
    console.error(
      `[addOrCreateMember] could not lift the ban on ${userId}:`,
      unbanError
    );
    return false;
  }
  return true;
}

function isBanned(bannedUntil: string | undefined): boolean {
  if (!bannedUntil) return false;
  const until = Date.parse(bannedUntil);
  return Number.isNaN(until) || until > Date.now();
}

// SQLSTATEs from migration 083: 42501 forbidden, 22023 bad input,
// 23505 already a member. The RAISE messages are written for people.
function rpcFailure(error: PostgrestError): AddMemberResult {
  switch (error.code) {
    case '42501':
      return { ok: false, status: 403, error: error.message };
    case '22023':
      return { ok: false, status: 400, error: error.message };
    case '23505':
      return { ok: false, status: 409, error: error.message };
  }
  console.error('[addOrCreateMember] add_workspace_member failed:', error);
  return { ok: false, status: 500, error: 'Could not add this person' };
}
