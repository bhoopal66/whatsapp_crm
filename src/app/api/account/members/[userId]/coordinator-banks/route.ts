// PUT /api/account/members/[userId]/coordinator-banks
//
// Body: { bank_codes: string[] }. Replaces the banks a person
// coordinates (migration 133, set_coordinator_banks); an empty list
// removes them as a coordinator. Admin and up. [userId] is the auth user
// id, as in the sibling members route. Eligibility and bank existence
// are the RPC's call.

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
    const { supabase } = await requireRole('admin');
    const { userId } = await params;
    if (!isUuid(userId)) {
      return NextResponse.json({ error: 'Invalid member id' }, { status: 400 });
    }

    const body = (await request.json().catch(() => null)) as {
      bank_codes?: unknown;
    } | null;
    if (!isBankCodeList(body?.bank_codes)) {
      return NextResponse.json(
        {
          error:
            'bank_codes must be a list of up to 50 distinct bank codes (A-Z, 0-9, _)',
        },
        { status: 400 }
      );
    }

    const { data, error } = await supabase.rpc('set_coordinator_banks', {
      p_user_id: userId,
      p_bank_codes: body.bank_codes,
    });
    if (error) {
      const mapped = mapCoordinatorError(error);
      if (mapped.status >= 500) {
        console.error('[coordinator-banks] rpc failed:', error.code);
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
