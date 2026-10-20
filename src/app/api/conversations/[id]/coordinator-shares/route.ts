// GET  /api/conversations/[id]/coordinator-shares  open shares of a chat
// POST /api/conversations/[id]/coordinator-shares  { coordinator_user_id, bank_code }
//
// Migration 130. Agent and up. Reads run on the caller's RLS client (the
// shares policy follows conversation visibility); the write is
// share_conversation_with_coordinator, which holds every rule.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  isBankCode,
  isUuid,
  mapCoordinatorError,
} from '@/lib/coordinators/errors';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Ctx) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await context.params;
    if (!isUuid(id)) {
      return NextResponse.json({ error: 'Invalid chat id' }, { status: 400 });
    }

    const { data: shares, error } = await supabase
      .from('conversation_coordinator_shares')
      .select('id, coordinator_user_id, bank_code, shared_by, created_at')
      .eq('account_id', accountId)
      .eq('conversation_id', id)
      .is('revoked_at', null)
      .order('created_at', { ascending: true });
    if (error) {
      console.error('[coordinator-shares] list:', error);
      return NextResponse.json(
        { error: 'Failed to load shares' },
        { status: 500 }
      );
    }
    if (!shares || shares.length === 0) {
      return NextResponse.json({ shares: [] });
    }

    const userIds = [...new Set(shares.map((s) => s.coordinator_user_id))];
    const codes = [...new Set(shares.map((s) => s.bank_code))];
    const [profiles, banks] = await Promise.all([
      supabase
        .from('profiles')
        .select('user_id, full_name')
        .eq('account_id', accountId)
        .in('user_id', userIds),
      supabase
        .from('case_banks')
        .select('code, name')
        .eq('account_id', accountId)
        .in('code', codes),
    ]);
    const names = new Map(
      (profiles.data ?? []).map((p) => [p.user_id, p.full_name as string])
    );
    const bankNames = new Map(
      (banks.data ?? []).map((b) => [b.code, b.name as string])
    );

    return NextResponse.json({
      shares: shares.map((s) => ({
        id: s.id,
        coordinator_user_id: s.coordinator_user_id,
        coordinator_name: names.get(s.coordinator_user_id) ?? '',
        bank_code: s.bank_code,
        bank_name: bankNames.get(s.bank_code) ?? s.bank_code,
        shared_by: s.shared_by,
        created_at: s.created_at,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, context: Ctx) {
  try {
    const { supabase } = await requireRole('agent');
    const { id } = await context.params;
    if (!isUuid(id)) {
      return NextResponse.json({ error: 'Invalid chat id' }, { status: 400 });
    }

    const body = (await request.json().catch(() => null)) as {
      coordinator_user_id?: unknown;
      bank_code?: unknown;
    } | null;
    const coordinatorId = body?.coordinator_user_id;
    const bankCode = body?.bank_code;
    if (!isUuid(coordinatorId) || !isBankCode(bankCode)) {
      return NextResponse.json(
        { error: 'coordinator_user_id and bank_code are required' },
        { status: 400 }
      );
    }

    const { data, error } = await supabase.rpc(
      'share_conversation_with_coordinator',
      {
        p_conversation_id: id,
        p_coordinator_user_id: coordinatorId,
        p_bank_code: bankCode,
      }
    );
    if (error) {
      const mapped = mapCoordinatorError(error);
      if (mapped.status >= 500) {
        console.error('[coordinator-shares] share failed:', error.code);
      }
      return NextResponse.json(
        { error: mapped.error },
        { status: mapped.status }
      );
    }
    return NextResponse.json({ id: data as string });
  } catch (err) {
    return toErrorResponse(err);
  }
}
