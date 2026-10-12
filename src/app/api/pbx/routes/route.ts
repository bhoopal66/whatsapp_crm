// ============================================================
// /api/pbx/routes — which workspace each dialled number (DID) of the
// workspace's PBX belongs to (pbx_did_routes, migration 089).
//
//   GET — the routes, plus the workspaces the caller may route to.
//   PUT — { routes: [{ didNumber, nameOnPbx?, accountId }] } replaces
//         the list. Numbers are reduced to digits and may not repeat.
//
// A row that points a number at a workspace must name one where the
// caller is an active owner or admin (my_workspaces()); a row left
// exactly as it was is kept even if they are not. Writes are the
// service role's. Admin+.
// ============================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { ownConnection, pbxServiceDb } from '@/lib/pbx/admin';
import { adminWorkspaces, digitsOnly } from '@/lib/pbx/extensions';
import type { Workspace } from '@/lib/auth/my-workspaces';

const MAX_ROUTES = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteRow {
  id: string;
  did_number: string;
  name_on_pbx: string | null;
  account_id: string;
}
interface Input {
  didNumber: string;
  nameOnPbx: string | null;
  accountId: string;
}

const fail = (error: string, status = 400) =>
  NextResponse.json({ error }, { status });

async function readRoutes(
  db: SupabaseClient,
  connectionId: string
): Promise<RouteRow[]> {
  const { data, error } = await db
    .from('pbx_did_routes')
    .select('id, did_number, name_on_pbx, account_id')
    .eq('connection_id', connectionId)
    .order('did_number', { ascending: true });
  if (error) throw new Error(`pbx_did_routes read failed: ${error.message}`);
  return (data ?? []) as RouteRow[];
}

const reply = (rows: RouteRow[], workspaces: Workspace[]) =>
  NextResponse.json({
    routes: rows.map((r) => ({
      id: r.id,
      didNumber: r.did_number,
      nameOnPbx: r.name_on_pbx,
      accountId: r.account_id,
    })),
    workspaces: workspaces.map((w) => ({
      accountId: w.accountId,
      name: w.name,
    })),
  });

function parse(body: unknown): Input[] | string {
  const list = (body as { routes?: unknown } | null)?.routes;
  if (!Array.isArray(list)) return 'routes must be a list';
  if (list.length > MAX_ROUTES) return `At most ${MAX_ROUTES} routes`;
  const out: Input[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const didNumber = digitsOnly(r.didNumber);
    if (!/^[0-9]{1,20}$/.test(didNumber))
      return 'Each didNumber must have 1 to 20 digits';
    if (seen.has(didNumber)) return `${didNumber} is listed twice`;
    seen.add(didNumber);
    let nameOnPbx: string | null = null;
    if (r.nameOnPbx !== undefined && r.nameOnPbx !== null) {
      if (typeof r.nameOnPbx !== 'string' || r.nameOnPbx.trim().length > 100)
        return 'nameOnPbx must be text of at most 100 characters';
      nameOnPbx = r.nameOnPbx.trim() || null;
    }
    if (typeof r.accountId !== 'string' || !UUID.test(r.accountId))
      return `${didNumber}: accountId must be a workspace id`;
    out.push({ didNumber, nameOnPbx, accountId: r.accountId });
  }
  return out;
}

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const db = pbxServiceDb();
    const [conn, workspaces] = await Promise.all([
      ownConnection(db, ctx.accountId),
      adminWorkspaces(ctx.supabase),
    ]);
    return reply(conn ? await readRoutes(db, conn.id) : [], workspaces);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const input = parse(await request.json().catch(() => null));
    if (typeof input === 'string') return fail(input);

    const db = pbxServiceDb();
    const conn = await ownConnection(db, ctx.accountId);
    if (!conn) return fail('No PBX connection is configured', 404);
    const [existing, workspaces] = await Promise.all([
      readRoutes(db, conn.id),
      adminWorkspaces(ctx.supabase),
    ]);
    const adminIds = new Set(workspaces.map((w) => w.accountId));
    const before = new Map(existing.map((r) => [r.did_number, r.account_id]));
    for (const r of input) {
      if (before.get(r.didNumber) === r.accountId) continue;
      if (!adminIds.has(r.accountId)) {
        return fail(
          `${r.didNumber}: you can only route a number to a workspace where you are an owner or admin`,
          403
        );
      }
    }

    if (input.length) {
      const { error } = await db.from('pbx_did_routes').upsert(
        input.map((r) => ({
          connection_id: conn.id,
          did_number: r.didNumber,
          name_on_pbx: r.nameOnPbx,
          account_id: r.accountId,
        })),
        { onConflict: 'connection_id,did_number' }
      );
      if (error)
        throw new Error(`pbx_did_routes write failed: ${error.message}`);
    }
    const kept = new Set(input.map((r) => r.didNumber));
    const removed = existing
      .filter((r) => !kept.has(r.did_number))
      .map((r) => r.id);
    if (removed.length) {
      const { error } = await db
        .from('pbx_did_routes')
        .delete()
        .eq('connection_id', conn.id)
        .in('id', removed);
      if (error)
        throw new Error(`pbx_did_routes delete failed: ${error.message}`);
    }
    return reply(await readRoutes(db, conn.id), workspaces);
  } catch (err) {
    return toErrorResponse(err);
  }
}
