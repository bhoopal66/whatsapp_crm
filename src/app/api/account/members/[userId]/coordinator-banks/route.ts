// PUT /api/account/members/[userId]/coordinator-banks
//
// Body: { bank_codes: string[], expected_bank_codes?: string[] }. Replaces
// the banks a person coordinates (migration 133, set_coordinator_banks);
// an empty list removes them as a coordinator. `expected_bank_codes` is
// what the page showed: when another set is stored (310) nothing changes
// and the answer is a 409 with that set. Admin and up. [userId] is the
// auth user id, as in the sibling members route. Eligibility and bank
// existence are the RPC's call.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  isBankCodeList,
  isUuid,
  mapCoordinatorError,
} from '@/lib/coordinators/errors';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { userId } = await params;
    if (!isUuid(userId)) {
      return NextResponse.json({ error: 'Invalid member id' }, { status: 400 });
    }

    const body = (await request.json().catch(() => null)) as {
      bank_codes?: unknown;
      expected_bank_codes?: unknown;
    } | null;
    const expected = body?.expected_bank_codes;
    if (
      !isBankCodeList(body?.bank_codes) ||
      (expected !== undefined && !isBankCodeList(expected))
    ) {
      return NextResponse.json(
        {
          error:
            'bank_codes must be a list of up to 50 distinct bank codes (A-Z, 0-9, _)',
        },
        { status: 400 }
      );
    }

    const args = { p_user_id: userId, p_bank_codes: body.bank_codes };
    const compared = expected !== undefined;
    let { data, error } = await supabase.rpc(
      'set_coordinator_banks',
      compared ? { ...args, p_expected: expected } : args
    );
    // Before 310 there is nothing to compare with.
    if (compared && error?.code === 'PGRST202') {
      ({ data, error } = await supabase.rpc('set_coordinator_banks', args));
    }
    if (error) {
      const mapped = mapCoordinatorError(error);
      if (mapped.status >= 500) {
        console.error('[coordinator-banks] rpc failed:', error.code);
      }
      if (mapped.status === 409) {
        const now = await supabase
          .from('coordinator_banks')
          .select('bank_code')
          .eq('account_id', accountId)
          .eq('user_id', userId)
          .order('bank_code');
        return NextResponse.json(
          {
            error: mapped.error,
            code: 'BANKS_CHANGED',
            ...(now.error
              ? {}
              : { bank_codes: now.data.map((r) => r.bank_code) }),
          },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: mapped.error },
        { status: mapped.status }
      );
    }
    return NextResponse.json({ bank_codes: (data as string[] | null) ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
