// ============================================================
// /api/assignment/settings — Settings -> Chat assignment
// (migration 236). Owner / admin only, the caller's active workspace.
//
// GET -> { available, settings, members }
//   settings: { broadcastRotationEnabled, broadcastPool,
//               compassAssignEnabled, limitsEnabled, defaultChatLimit }
//               (the defaults, everything off, when never saved)
//   members:  live staff (no bank guests), plus anyone holding a limit
//             of their own: { userId, name, role, deactivated,
//             openCount, limit } where `limit` is the person's own
//             limit (null = the default applies).
//   available is false before migration 236.
// PUT { any of the settings fields } -> { settings } as stored, through
//   assignment_settings_set on the caller's RLS client (it re-checks
//   owner/admin and the pool). Fields left out keep their value.
//   Refusals: 422 bad_limit / pool_member_invalid / pool_too_large,
//   403 not_allowed, 503 not_available, 400 invalid_body.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  loadMemberLoads,
  parseAssignmentSettings,
  saveAssignmentSettings,
  type AssignmentSettings,
} from '@/lib/assignment/rotation';
import {
  MAX_POOL_SIZE,
  assignmentErrorOf,
  isUuid,
  parseChatLimit,
} from '@/lib/assignment/ui';

const SETTINGS_SELECT =
  'broadcast_rotation_enabled, broadcast_pool, compass_assign_enabled, limits_enabled, default_chat_limit';

function isMissingObject(error: { code?: string } | null): boolean {
  return assignmentErrorOf(error?.code)?.error === 'not_available';
}

interface ProfileRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  account_role: string;
  deactivated_at: string | null;
}

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const db = ctx.supabase;

    const [settingsRes, profilesRes, limitsRes, loads] = await Promise.all([
      db
        .from('assignment_settings')
        .select(SETTINGS_SELECT)
        .eq('account_id', ctx.accountId)
        .maybeSingle(),
      db
        .from('profiles')
        .select('user_id, full_name, email, account_role, deactivated_at')
        .eq('account_id', ctx.accountId),
      db
        .from('assignment_chat_limits')
        .select('user_id, max_open')
        .eq('account_id', ctx.accountId),
      loadMemberLoads(db),
    ]);

    if (settingsRes.error && isMissingObject(settingsRes.error)) {
      return NextResponse.json({
        available: false,
        settings: parseAssignmentSettings(null),
        members: [],
      });
    }
    if (settingsRes.error || profilesRes.error) {
      console.error(
        '[assignment] settings read failed:',
        (settingsRes.error ?? profilesRes.error)?.message
      );
      return NextResponse.json({ error: 'load_failed' }, { status: 500 });
    }

    const own = new Map<string, number>();
    for (const r of (limitsRes.data ?? []) as {
      user_id: string;
      max_open: number;
    }[]) {
      own.set(r.user_id, r.max_open);
    }
    const open = new Map(loads.map((l) => [l.userId, l.openCount]));

    const members = ((profilesRes.data ?? []) as ProfileRow[])
      .filter(
        (p) =>
          p.account_role !== 'bank_guest' &&
          (!p.deactivated_at || own.has(p.user_id))
      )
      .map((p) => ({
        userId: p.user_id,
        name: p.full_name?.trim() || p.email || p.user_id,
        role: p.account_role,
        deactivated: !!p.deactivated_at,
        openCount: open.get(p.user_id) ?? 0,
        limit: own.get(p.user_id) ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({
      available: true,
      settings: parseAssignmentSettings(
        settingsRes.data as Record<string, unknown> | null
      ),
      members,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

const invalid = () =>
  NextResponse.json({ error: 'invalid_body' }, { status: 400 });

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return invalid();
    }

    const patch: Partial<AssignmentSettings> = {};
    for (const key of [
      'broadcastRotationEnabled',
      'compassAssignEnabled',
      'limitsEnabled',
    ] as const) {
      const v = body[key];
      if (v === undefined) continue;
      if (typeof v !== 'boolean') return invalid();
      patch[key] = v;
    }
    if (body.broadcastPool !== undefined) {
      const pool = body.broadcastPool;
      if (!Array.isArray(pool) || !pool.every(isUuid)) return invalid();
      if (pool.length > MAX_POOL_SIZE) {
        return NextResponse.json({ error: 'pool_too_large' }, { status: 422 });
      }
      patch.broadcastPool = pool;
    }
    if (body.defaultChatLimit !== undefined) {
      const limit =
        typeof body.defaultChatLimit === 'number'
          ? parseChatLimit(body.defaultChatLimit)
          : null;
      if (limit === null) {
        return NextResponse.json({ error: 'bad_limit' }, { status: 422 });
      }
      patch.defaultChatLimit = limit;
    }
    if (Object.keys(patch).length === 0) return invalid();

    const result = await saveAssignmentSettings(ctx.supabase, patch);
    if (!result.ok) {
      const known = assignmentErrorOf(result.code);
      if (known) {
        return NextResponse.json(
          { error: known.error },
          { status: known.status }
        );
      }
      console.error('[assignment] settings save failed:', result.error);
      return NextResponse.json({ error: 'save_failed' }, { status: 500 });
    }
    return NextResponse.json({ settings: result.settings });
  } catch (err) {
    return toErrorResponse(err);
  }
}
