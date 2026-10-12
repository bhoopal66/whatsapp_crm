// ============================================================
// GET /api/pbx/extensions — the extensions of the workspace's PBX
// (migration 089), each with its workspace and mapped person, plus the
// workspaces the caller administers and the people in each who may hold
// an extension (owner/admin/team leader/agent, not deactivated).
//
// A person is named only in a workspace the caller administers. Admin+.
// Sync from the PBX is POST ./sync; mapping is PATCH ./[id].
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { ownConnection, pbxServiceDb } from '@/lib/pbx/admin';
import {
  adminWorkspaces,
  connectionExtensions,
  mappableWorkspaces,
} from '@/lib/pbx/extensions';

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const db = pbxServiceDb();
    const [conn, workspaces] = await Promise.all([
      ownConnection(db, ctx.accountId),
      adminWorkspaces(ctx.supabase),
    ]);
    const adminIds = new Set(workspaces.map((w) => w.accountId));
    return NextResponse.json({
      extensions: conn ? await connectionExtensions(db, conn.id, adminIds) : [],
      workspaces: await mappableWorkspaces(db, workspaces),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
