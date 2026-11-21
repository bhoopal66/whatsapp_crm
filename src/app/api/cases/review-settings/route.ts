// /api/cases/review-settings — the case file reviewer's switches
// (migration 225). Owners and admins.
//   GET -> `{ enabled, sendToModel }`
//   PUT `{ enabled, sendToModel }` (sendToModel needs enabled: 422)
import { NextResponse } from 'next/server';

import { assertSalesAccess, requireRole } from '@/lib/auth/account';
import {
  check,
  reviewErrorResponse,
  ReviewRefused,
} from '@/lib/case-review/http';
import { supabaseAdmin } from '@/lib/submission-groups/server';

function shape(data: unknown) {
  const r = (
    data as Array<{
      review_enabled: boolean;
      review_send_to_model: boolean;
    }> | null
  )?.[0];
  return {
    enabled: r?.review_enabled === true,
    sendToModel: r?.review_send_to_model === true,
  };
}

export async function GET() {
  try {
    const ctx = assertSalesAccess(await requireRole('admin'));
    const { data, error } = await supabaseAdmin().rpc('case_review_settings', {
      p_account: ctx.accountId,
    });
    check('case_review_settings', error);
    return NextResponse.json(shape(data));
  } catch (err) {
    return reviewErrorResponse(err, 'review settings');
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = assertSalesAccess(await requireRole('admin'));
    const body = (await request.json().catch(() => null)) as {
      enabled?: unknown;
      sendToModel?: unknown;
    } | null;
    if (
      typeof body?.enabled !== 'boolean' ||
      typeof body?.sendToModel !== 'boolean'
    )
      throw new ReviewRefused('INVALID');
    const { data, error } = await supabaseAdmin().rpc(
      'case_settings_set_review',
      {
        p_actor: ctx.userId,
        p_account: ctx.accountId,
        p_enabled: body.enabled,
        p_send_to_model: body.sendToModel,
      }
    );
    check('case_settings_set_review', error);
    return NextResponse.json(shape(data));
  } catch (err) {
    return reviewErrorResponse(err, 'review settings');
  }
}
