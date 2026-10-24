// ============================================================
// /api/cases/config/settings — Settings -> Cases: the account's case
// settings (migrations 134, 136). GET (agent and up, the caller's RLS
// client): `{ settings: { managedExternally, submissionWhatsappGroups } }`,
// each false when never saved. PUT (owner / admin) takes
// `{ managed_externally?: boolean, submission_whatsapp_groups?: boolean }`
// (at least one; each sent key must be a boolean) and answers the same
// shape with both stored values, through case_settings_set /
// case_settings_set_whatsapp_groups on the service role (granted only
// there; each re-checks the writer: NOT_ALLOWED). The account is the
// caller's active one, never a body value.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { configErrorResponse, readRows } from '@/lib/cases/config-http';
import { badRequest, readObject } from '@/lib/cases/http';
import { fail } from '@/lib/cases/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    const [row] = await readRows(
      ctx.supabase
        .from('case_account_settings')
        .select('managed_externally, submission_whatsapp_groups')
        .eq('account_id', ctx.accountId)
        .limit(1),
      'case_account_settings'
    );
    return NextResponse.json({
      settings: {
        managedExternally: row?.managed_externally === true,
        submissionWhatsappGroups: row?.submission_whatsapp_groups === true,
      },
    });
  } catch (err) {
    return configErrorResponse(err, 'settings GET');
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = await readObject(request);
    const managed = body.managed_externally;
    const groups = body.submission_whatsapp_groups;
    if (managed === undefined && groups === undefined)
      throw badRequest(
        'managed_externally or submission_whatsapp_groups is required'
      );
    if (managed !== undefined && typeof managed !== 'boolean')
      throw badRequest('managed_externally must be true or false');
    if (groups !== undefined && typeof groups !== 'boolean')
      throw badRequest('submission_whatsapp_groups must be true or false');
    const db = supabaseAdmin();
    if (managed !== undefined) {
      const { error } = await db.rpc('case_settings_set', {
        p_actor: ctx.userId,
        p_account: ctx.accountId,
        p_managed_externally: managed,
      });
      if (error) fail('case_settings_set', error);
    }
    if (groups !== undefined) {
      const { error } = await db.rpc('case_settings_set_whatsapp_groups', {
        p_actor: ctx.userId,
        p_account: ctx.accountId,
        p_on: groups,
      });
      if (error) fail('case_settings_set_whatsapp_groups', error);
    }
    // Both values as stored (a key not sent is read back, not assumed).
    const [{ data: m, error: me }, { data: g, error: ge }] = await Promise.all([
      db.rpc('case_managed_externally', { p_account: ctx.accountId }),
      db.rpc('case_submission_whatsapp_groups', { p_account: ctx.accountId }),
    ]);
    if (me) fail('case_managed_externally', me);
    if (ge) fail('case_submission_whatsapp_groups', ge);
    return NextResponse.json({
      settings: {
        managedExternally: m === true,
        submissionWhatsappGroups: g === true,
      },
    });
  } catch (err) {
    return configErrorResponse(err, 'settings PUT');
  }
}
