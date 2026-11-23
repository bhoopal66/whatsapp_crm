// /api/account/members/[userId]/handover
//
//   GET  — what this person still holds: { counts, keys }.       Admin+.
//          `keys` are the live API keys they made (null: not readable).
//   POST — { to, what } moves it to a colleague: { moved }.      Admin+.
//
// `member_work_counts` and `member_handover` (migration 266) do the real
// authorisation, as the caller; this maps their SQLSTATEs.

import { NextResponse } from 'next/server';
import type { PostgrestError } from '@supabase/supabase-js';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  parseHandoverKinds,
  parseWorkCounts,
} from '@/lib/auth/member-handover';
import { listLiveKeys } from '@/lib/api-keys/made-by';
import { isUuid } from '@/lib/coordinators/errors';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

type Params = { params: Promise<{ userId: string }> };

function rpcErrorToResponse(err: PostgrestError, fallback: string) {
  if (err.code === '42501') {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err.code === '22023') {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error('[member handover] unexpected RPC error:', err);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const { userId } = await params;
    if (!isUuid(userId)) return bad('Invalid member id');

    const { data, error } = await ctx.supabase.rpc('member_work_counts', {
      p_user: userId,
    });
    if (error) {
      return rpcErrorToResponse(error, "Failed to load this person's work");
    }
    // Keys outlive their maker's role and are never revoked by themselves:
    // listed here for the admin to decide. A failed read costs only them.
    const live = await listLiveKeys(ctx.supabase, ctx.accountId);
    const keys = live ? live.filter((k) => k.createdBy === userId) : null;
    return NextResponse.json({ counts: parseWorkCounts(data), keys });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:memberHandover:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;
    if (!isUuid(userId)) return bad('Invalid member id');

    const body = (await request.json().catch(() => null)) as {
      to?: unknown;
      what?: unknown;
    } | null;
    const to = body?.to;
    if (typeof to !== 'string' || !isUuid(to)) {
      return bad("'to' must be a member id");
    }
    const what = parseHandoverKinds(body?.what);
    if (!what) {
      return bad(
        "'what' must list one or more of chats, tasks, deals, contacts"
      );
    }

    const { data, error } = await ctx.supabase.rpc('member_handover', {
      p_from: userId,
      p_to: to,
      p_what: what,
    });
    if (error) return rpcErrorToResponse(error, 'Failed to hand over the work');
    return NextResponse.json({ moved: parseWorkCounts(data) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
