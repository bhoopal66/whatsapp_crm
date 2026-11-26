// ============================================================
// PATCH  /api/account/webhooks/[id] — switch an endpoint off.
// DELETE /api/account/webhooks/[id] — remove it.
//
// Admin+. Only off: an endpoint belongs to the key that switched it on
// (315), and a dashboard session has no key to give it, so switching on
// stays with /api/v1/webhooks and a live key.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isUuid } from '@/lib/coordinators/errors';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

function notFound() {
  return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:webhookUpdate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!isUuid(id)) return notFound();

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (body?.is_active === true) {
      return NextResponse.json(
        {
          error:
            'A webhook is switched on through the API, with a live API key',
        },
        { status: 400 }
      );
    }
    if (body?.is_active !== false || Object.keys(body).length !== 1) {
      return NextResponse.json(
        { error: "Only { 'is_active': false } is accepted" },
        { status: 400 }
      );
    }

    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .update({ is_active: false })
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')
      .maybeSingle();
    if (error) {
      console.error('[PATCH /api/account/webhooks/[id]] error:', error);
      return NextResponse.json(
        { error: 'Failed to switch off the webhook' },
        { status: 500 }
      );
    }
    if (!data) return notFound();

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:webhookDelete:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!isUuid(id)) return notFound();

    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')
      .maybeSingle();
    if (error) {
      console.error('[DELETE /api/account/webhooks/[id]] error:', error);
      return NextResponse.json(
        { error: 'Failed to delete the webhook' },
        { status: 500 }
      );
    }
    if (!data) return notFound();

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
