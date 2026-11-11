// ============================================================
// GET /api/broadcasts/[id]/reply-classes   (migration 148)
//
// Campaign reply sorting's counts for one broadcast:
//
//   { counts: Record<class, number>, unclassifiedReplies: number,
//     enabled: boolean, available: boolean }
//
// `unclassifiedReplies` is replied recipients with no class yet — what
// POST ./classify-replies would work through. `enabled` is the
// account's switch, `available` whether Jev can run at all. Counts go
// through the caller's RLS client, so they can never cover a row the
// caller could not read. Admin and up, like the broadcasts screens
// (their layout is AdminOnlyLayout).
// ============================================================

import { NextResponse } from 'next/server';

import {
  requireRole,
  toErrorResponse,
  assertSalesAccess,
} from '@/lib/auth/account';
import { getInsightSettings, insightsAvailable } from '@/lib/insights/settings';
import {
  REPLY_CLASS_NAMES,
  type ReplyClass,
} from '@/lib/typesafe/questions/reply-class';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = assertSalesAccess(
      await requireRole('admin')
    );
    const { id } = await params;
    if (!UUID.test(id))
      return NextResponse.json(
        { error: 'Invalid broadcast id' },
        { status: 400 }
      );

    const { data: broadcast, error: bErr } = await supabase
      .from('broadcasts')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (bErr) throw new Error(bErr.message);
    if (!broadcast)
      return NextResponse.json(
        { error: 'Broadcast not found' },
        { status: 404 }
      );

    const base = () =>
      supabase
        .from('broadcast_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('broadcast_id', id);
    const count = async (
      narrow: (q: ReturnType<typeof base>) => ReturnType<typeof base>
    ): Promise<number> => {
      const { count: n, error } = await narrow(base());
      if (error) throw new Error(error.message);
      return n ?? 0;
    };

    const [classCounts, unclassifiedReplies, settings] = await Promise.all([
      Promise.all(
        REPLY_CLASS_NAMES.map((cls) => count((q) => q.eq('reply_class', cls)))
      ),
      count((q) => q.eq('status', 'replied').is('reply_class', null)),
      getInsightSettings(accountId),
    ]);
    const counts = Object.fromEntries(
      REPLY_CLASS_NAMES.map((cls, i) => [cls, classCounts[i]])
    ) as Record<ReplyClass, number>;

    return NextResponse.json({
      counts,
      unclassifiedReplies,
      enabled: settings.replyClassEnabled,
      available: insightsAvailable(accountId),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
