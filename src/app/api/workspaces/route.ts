// ============================================================
// /api/workspaces — the caller's workspaces (migration 083)
//
//   GET  — every workspace the caller belongs to, for the switcher:
//          { workspaces: [{ accountId, name, shortName, role,
//          isActive, deactivated, archived }] }, the active one
//          first; an archived workspace (105) only for its owners, last.
//   POST — { name, shortName, invites?: [{ email, role, bankCode?,
//          fullName?, password? }] }: create a workspace, switch into
//          it, and add each invite there. Owner/admin of the active
//          workspace only. 201 { accountId, invites: [{ email, ok,
//          error? }] }, invites in the order sent.
//
// GET authenticates with the session alone, not `getCurrentAccount`:
// that refuses a caller whose active workspace deactivated them, and
// such a person must still see their other workspaces to move to one
// (POST /api/workspaces/switch follows the same rule).
// ============================================================

import { NextResponse } from 'next/server';
import {
  createClient as createAdminClient,
  type PostgrestError,
} from '@supabase/supabase-js';

import {
  ADDABLE_ROLES,
  addOrCreateMember,
  isAddableRole,
  type AddableRole,
} from '@/lib/account/add-member';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isAccountRole } from '@/lib/auth/roles';
import { createClient } from '@/lib/supabase/server';
import { serverSupabaseUrl } from '@/lib/supabase/urls';

/** One request creates at most this many logins. */
const MAX_INVITES = 50;

interface WorkspaceRow {
  account_id: string;
  name: string;
  short_name: string | null;
  role: string;
  is_active: boolean;
  deactivated: boolean;
  archived?: boolean;
}

interface Invite {
  email: string;
  role: AddableRole;
  bankCode?: string;
  fullName?: string;
  password?: string;
}

/** Service role, for creating a new login. Only reached after
 *  `create_workspace` has authorised the caller. */
function supabaseAdmin() {
  return createAdminClient(
    serverSupabaseUrl(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data, error } = await supabase.rpc('my_workspaces');
    if (error) {
      console.error('[GET /api/workspaces] my_workspaces failed:', error);
      return NextResponse.json(
        { error: 'Failed to load workspaces' },
        { status: 500 }
      );
    }

    const workspaces = ((data ?? []) as WorkspaceRow[]).flatMap((row) =>
      isAccountRole(row.role)
        ? [
            {
              accountId: row.account_id,
              name: row.name,
              shortName: row.short_name,
              role: row.role,
              isActive: row.is_active,
              deactivated: row.deactivated,
              archived: row.archived === true,
            },
          ]
        : []
    );
    return NextResponse.json({ workspaces });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** The invites, or the message for the first malformed one. Checked
 *  before anything is created, so a bad list leaves no workspace. */
function parseInvites(raw: unknown): Invite[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return "'invites' must be a list";
  if (raw.length > MAX_INVITES) {
    return `At most ${MAX_INVITES} invites at a time`;
  }
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const invites: Invite[] = [];
  for (const [i, item] of raw.entries()) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const email = text(entry.email)?.trim() ?? '';
    if (!email.includes('@')) {
      return `Invite ${i + 1}: a valid email is required`;
    }
    if (!isAddableRole(entry.role)) {
      return `Invite ${i + 1}: role must be one of: ${ADDABLE_ROLES.join(', ')}`;
    }
    invites.push({
      email,
      role: entry.role,
      bankCode: text(entry.bankCode),
      fullName: text(entry.fullName),
      password: text(entry.password),
    });
  }
  return invites;
}

function rpcErrorResponse(error: PostgrestError): NextResponse {
  if (error.code === '42501') {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (error.code === '22023') {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  console.error('[POST /api/workspaces] create_workspace failed:', error);
  return NextResponse.json(
    { error: 'Could not create the workspace' },
    { status: 500 }
  );
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const invites = parseInvites(body?.invites);
    if (typeof invites === 'string') {
      return NextResponse.json({ error: invites }, { status: 400 });
    }

    // Name and short-name rules live in create_workspace (22023 → 400).
    const { data, error: createError } = await ctx.supabase.rpc(
      'create_workspace',
      {
        p_name: typeof body?.name === 'string' ? body.name : '',
        p_short_name: typeof body?.shortName === 'string' ? body.shortName : '',
      }
    );
    if (createError) return rpcErrorResponse(createError);
    const accountId = data as string;

    // The owner row starts inactive. Switch BEFORE the invites:
    // add_workspace_member adds to the caller's active workspace, so
    // inviting first would put these people in the old one.
    const { error: switchError } = await ctx.supabase.rpc('switch_account', {
      p_account_id: accountId,
    });
    if (switchError) {
      console.error(
        '[POST /api/workspaces] switch_account failed:',
        switchError
      );
      return NextResponse.json(
        {
          error:
            'The workspace was created but could not be opened; switch to it from the workspace menu and add people there',
          accountId,
        },
        { status: 500 }
      );
    }

    const results: { email: string; ok: boolean; error?: string }[] = [];
    if (invites.length > 0) {
      const admin = supabaseAdmin();
      // One at a time: each may create a login, and the RPCs lock the
      // person's rows.
      for (const invite of invites) {
        const result = await addOrCreateMember({
          supabase: ctx.supabase,
          admin,
          accountId,
          ...invite,
          // An admin, who now owns the new workspace.
          mayCreateLogin: true,
        });
        results.push(
          result.ok
            ? { email: invite.email, ok: true }
            : { email: invite.email, ok: false, error: result.error }
        );
      }
    }

    return NextResponse.json({ accountId, invites: results }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
