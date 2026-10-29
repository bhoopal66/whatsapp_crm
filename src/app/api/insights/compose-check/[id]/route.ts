import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/ai/admin-client';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/insights/compose-check/[id] { outcome } → { ok: true }
 * Records what the agent did after a warning. Only the service role
 * writes compose_check_events, so ownership is checked in the filter:
 * their own, still pending, in their account. Anything else matches
 * nothing and answers 404.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { accountId, userId } = await requireRole('agent');
    const { id } = await params;
    if (!UUID_RE.test(id))
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const outcome = ((json ?? {}) as Record<string, unknown>).outcome;
    if (outcome !== 'sent_anyway' && outcome !== 'edited')
      return NextResponse.json(
        { error: 'outcome must be sent_anyway or edited' },
        { status: 400 }
      );

    const { data, error } = await supabaseAdmin()
      .from('compose_check_events')
      .update({ outcome, decided_at: new Date().toISOString() })
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('user_id', userId)
      .eq('outcome', 'pending')
      .select('id');
    if (error) {
      console.error('[compose-check PATCH] update error:', error.message);
      return NextResponse.json(
        { error: 'Failed to record the outcome' },
        { status: 500 }
      );
    }
    if (!data || data.length === 0)
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
