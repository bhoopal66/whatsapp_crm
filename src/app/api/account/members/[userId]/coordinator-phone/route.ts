// PUT /api/account/members/[userId]/coordinator-phone
//
// Body: { phone: string | null }. Sets the WhatsApp number a
// coordinator is added to their banks' submission groups with
// (migration 142, set_coordinator_phone); null or blank clears it.
// Admin and up. [userId] is the auth user id, as in the sibling
// coordinator-banks route. The number is normalised as the public API
// normalises `coordinator_phone`; eligibility is the RPC's call.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { validateContactPhone } from '@/lib/contacts/phone-validation';
import { isUuid, mapCoordinatorError } from '@/lib/coordinators/errors';

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
      phone?: unknown;
    } | null;
    const raw = body?.phone;
    if (!body || (raw !== null && typeof raw !== 'string')) {
      return NextResponse.json(
        { error: 'phone must be a string or null' },
        { status: 400 }
      );
    }

    let phone: string | null = null;
    if (typeof raw === 'string' && raw.trim() !== '') {
      const checked = validateContactPhone(raw, "'phone'");
      if (!checked.ok) {
        return NextResponse.json({ error: checked.error }, { status: 400 });
      }
      phone = checked.normalized.replace(/\D/g, '');
    }

    const { data, error } = await supabase.rpc('set_coordinator_phone', {
      p_user_id: userId,
      p_phone: phone,
    });
    if (error) {
      const mapped = mapCoordinatorError(error);
      if (mapped.status >= 500) {
        console.error('[coordinator-phone] rpc failed:', error.code);
      }
      return NextResponse.json(
        { error: mapped.error },
        { status: mapped.status }
      );
    }
    return NextResponse.json({ phone: (data as string | null) ?? null });
  } catch (err) {
    return toErrorResponse(err);
  }
}
