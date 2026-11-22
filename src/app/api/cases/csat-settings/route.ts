// /api/cases/csat-settings — case CSAT switches (migration 246). Owners
// and admins.
//   GET -> `{ settings }` (defaults when never saved; updatedAt null)
//   PUT `{ enabled, askOnSubmitted, askOnApproved, templateSubmitted,
//        templateApproved, language,
//        replyWindowDays, sendStartHour, sendEndHour, expectedUpdatedAt }`
//        -> `{ settings }`; 409 STALE when someone saved in between, 422
//        INVALID for a value out of range.
import { NextResponse } from 'next/server';

import { assertSalesAccess, requireRole } from '@/lib/auth/account';
import {
  check,
  csatErrorResponse,
  settingsArgs,
  settingsFromRow,
} from '@/lib/cases/csat-http';
import { supabaseAdmin } from '@/lib/submission-groups/server';

async function read(userId: string, accountId: string) {
  const { data, error } = await supabaseAdmin().rpc('case_csat_settings_get', {
    p_actor: userId,
    p_account: accountId,
  });
  check('case_csat_settings_get', error);
  return settingsFromRow(data);
}

export async function GET() {
  try {
    const ctx = assertSalesAccess(await requireRole('admin'));
    return NextResponse.json({
      settings: await read(ctx.userId, ctx.accountId),
    });
  } catch (err) {
    return csatErrorResponse(err, 'csat settings');
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = assertSalesAccess(await requireRole('admin'));
    const s = settingsArgs(await request.json().catch(() => null));
    const { error } = await supabaseAdmin().rpc('case_csat_settings_set', {
      p_actor: ctx.userId,
      p_account: ctx.accountId,
      p_enabled: s.enabled,
      p_ask_on_submitted: s.askOnSubmitted,
      p_ask_on_approved: s.askOnApproved,
      p_template_submitted: s.templateSubmitted,
      p_template_approved: s.templateApproved,
      p_language: s.language,
      p_reply_window_days: s.replyWindowDays,
      p_send_start_hour: s.sendStartHour,
      p_send_end_hour: s.sendEndHour,
      p_expected: s.expectedUpdatedAt,
    });
    check('case_csat_settings_set', error);
    return NextResponse.json({
      settings: await read(ctx.userId, ctx.accountId),
    });
  } catch (err) {
    return csatErrorResponse(err, 'csat settings save');
  }
}
