// ============================================================
// /api/cases/config/settings — Settings -> Cases: the account's case
// settings (migration 134). GET (agent and up, the caller's RLS client):
// `{ settings: { managedExternally } }`, false when never saved. PUT
// (owner / admin) `{ managed_externally: boolean }` -> the same shape,
// through case_settings_set on the service role (it is granted only
// there, and re-checks the writer: NOT_ALLOWED). The account is the
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
        .select('managed_externally')
        .eq('account_id', ctx.accountId)
        .limit(1),
      'case_account_settings'
    );
    return NextResponse.json({
      settings: { managedExternally: row?.managed_externally === true },
    });
  } catch (err) {
    return configErrorResponse(err, 'settings GET');
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = await readObject(request);
    if (typeof body.managed_externally !== 'boolean')
      throw badRequest('managed_externally must be true or false');
    const { data, error } = await supabaseAdmin().rpc('case_settings_set', {
      p_actor: ctx.userId,
      p_account: ctx.accountId,
      p_managed_externally: body.managed_externally,
    });
    if (error) fail('case_settings_set', error);
    return NextResponse.json({
      settings: { managedExternally: data === true },
    });
  } catch (err) {
    return configErrorResponse(err, 'settings PUT');
  }
}
