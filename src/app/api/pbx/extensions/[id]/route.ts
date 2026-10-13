// ============================================================
// PATCH /api/pbx/extensions/[id] — map an extension of the workspace's
// PBX: { userId?: string | null, accountId?, softphoneEnabled?,
// presenceMonitor? }.
//
// The target workspace (accountId, else the extension's own) must be one
// where the caller is an active owner or admin (my_workspaces(), on the
// caller's client); the person must be an active owner, admin, team
// leader or agent there (pbx_extensions_guard says the same). Then the
// write is the service role's. One extension per person per workspace:
// a second is 409. Admin+.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { ownConnection, pbxServiceDb } from '@/lib/pbx/admin';
import {
  EXTENSION_COLUMNS,
  adminWorkspaces,
  canHoldExtension,
  extensionViews,
} from '@/lib/pbx/extensions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLAGS = [
  ['softphoneEnabled', 'softphone_enabled'],
  ['presenceMonitor', 'presence_monitor'],
] as const;

interface Patch {
  userId?: string | null;
  accountId?: string;
  softphoneEnabled?: boolean;
  presenceMonitor?: boolean;
}

const fail = (error: string, status = 400) =>
  NextResponse.json({ error }, { status });

function parse(b: Record<string, unknown>): Patch | string {
  const out: Patch = {};
  if (b.userId !== undefined) {
    if (
      b.userId !== null &&
      !(typeof b.userId === 'string' && UUID.test(b.userId))
    )
      return 'userId must be a user id or null';
    out.userId = b.userId;
  }
  if (b.accountId !== undefined) {
    if (!(typeof b.accountId === 'string' && UUID.test(b.accountId)))
      return 'accountId must be a workspace id';
    out.accountId = b.accountId;
  }
  for (const [field] of FLAGS) {
    if (b[field] === undefined) continue;
    if (typeof b[field] !== 'boolean') return `${field} must be true or false`;
    out[field] = b[field];
  }
  return Object.keys(out).length ? out : 'Nothing to change';
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      return fail('Invalid JSON body');
    const input = parse(body as Record<string, unknown>);
    if (typeof input === 'string') return fail(input);

    const db = pbxServiceDb();
    const conn = await ownConnection(db, ctx.accountId);
    const { data: row, error: readError } = conn
      ? await db
          .from('pbx_extensions')
          .select(EXTENSION_COLUMNS)
          .eq('id', id)
          .eq('connection_id', conn.id)
          .maybeSingle()
      : { data: null, error: null };
    if (readError)
      throw new Error(`pbx_extensions read failed: ${readError.message}`);
    if (!conn || !row) return fail('Extension not found', 404);
    const current = row as {
      extension: string;
      account_id: string;
      user_id: string | null;
    };

    const target = input.accountId ?? current.account_id;
    const workspaces = await adminWorkspaces(ctx.supabase);
    const adminIds = new Set(workspaces.map((w) => w.accountId));
    if (!adminIds.has(target)) {
      return fail(
        'You can only map extensions in a workspace where you are an owner or admin',
        403
      );
    }

    const user = input.userId !== undefined ? input.userId : current.user_id;
    const remapped = user !== current.user_id || target !== current.account_id;
    if (user && remapped) {
      const { data: person, error } = await db
        .from('profiles')
        .select('account_role, deactivated_at')
        .eq('user_id', user)
        .eq('account_id', target)
        .maybeSingle();
      if (error) throw new Error(`profiles read failed: ${error.message}`);
      const p = person as { account_role?: unknown; deactivated_at?: unknown };
      if (!p || p.deactivated_at || !canHoldExtension(p.account_role)) {
        return fail(
          'That person is not an active owner, admin, team leader or agent of the workspace'
        );
      }
    }

    const fields: Record<string, unknown> = {};
    if (input.accountId !== undefined) fields.account_id = input.accountId;
    if (input.userId !== undefined) fields.user_id = input.userId;
    for (const [field, column] of FLAGS)
      if (input[field] !== undefined) fields[column] = input[field];
    const { data: saved, error } = await db
      .from('pbx_extensions')
      .update(fields)
      .eq('id', id)
      .eq('connection_id', conn.id)
      .select(EXTENSION_COLUMNS)
      .single();
    if (error?.code === '23505')
      return fail(
        'That person already has an extension in this workspace',
        409
      );
    if (error?.code === '23514')
      return fail(
        'An extension can only be mapped to an active staff member of its workspace'
      );
    if (error || !saved)
      throw new Error(`pbx_extensions update failed: ${error?.message}`);

    // The presence row follows the mapping and the Presence switch in
    // the same transaction: migration 101's pbx_presence_follow_mapping.

    const [view] = await extensionViews(
      db,
      [saved as Record<string, unknown> & { account_id: string }],
      adminIds
    );
    return NextResponse.json({ extension: view });
  } catch (err) {
    return toErrorResponse(err);
  }
}
