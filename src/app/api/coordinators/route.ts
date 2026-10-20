// GET /api/coordinators[?bank=CODE]
//
// Coordinators of the active workspace (migration 130): live agents and
// team leaders holding at least one bank. Agent and up. Reads run on the
// caller's RLS client; the profile lookup is scoped to the active
// account because one login can hold a profile in several workspaces.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { canManageMembers, type AccountRole } from '@/lib/auth/roles';
import { canHoldCoordinatorBanks } from '@/lib/coordinators/ui';
import { isBankCode } from '@/lib/coordinators/errors';

export async function GET(request: Request) {
  try {
    const { supabase, accountId, role } = await requireRole('agent');

    const bank = new URL(request.url).searchParams.get('bank');
    if (bank !== null && !isBankCode(bank)) {
      return NextResponse.json({ error: 'Invalid bank code' }, { status: 400 });
    }

    const { data: rows, error } = await supabase
      .from('coordinator_banks')
      .select('user_id, bank_code')
      .eq('account_id', accountId)
      .order('bank_code', { ascending: true });
    if (error) {
      console.error('[GET /api/coordinators] banks:', error);
      return NextResponse.json(
        { error: 'Failed to load coordinators' },
        { status: 500 }
      );
    }

    const byUser = new Map<string, string[]>();
    for (const r of rows ?? []) {
      const list = byUser.get(r.user_id) ?? [];
      list.push(r.bank_code);
      byUser.set(r.user_id, list);
    }
    // A bank filter keeps people who hold it, still listing all their banks.
    const userIds = [...byUser.entries()]
      .filter(([, banks]) => bank === null || banks.includes(bank))
      .map(([id]) => id);
    if (userIds.length === 0) return NextResponse.json({ coordinators: [] });

    const { data: profiles, error: pErr } = await supabase
      .from('profiles')
      .select('user_id, full_name, email, account_role')
      .eq('account_id', accountId)
      .is('deactivated_at', null)
      .in('user_id', userIds);
    if (pErr) {
      console.error('[GET /api/coordinators] profiles:', pErr);
      return NextResponse.json(
        { error: 'Failed to load coordinators' },
        { status: 500 }
      );
    }

    const showEmail = canManageMembers(role);
    // Holding a bank row is not enough: a person since promoted to admin
    // or demoted to viewer keeps the row but is no coordinator (130).
    const coordinators = (profiles ?? [])
      .filter((p) => canHoldCoordinatorBanks(p.account_role as AccountRole))
      .map((p) => ({
        user_id: p.user_id as string,
        name: (p.full_name as string | null) ?? '',
        ...(showEmail ? { email: (p.email as string | null) ?? null } : {}),
        banks: byUser.get(p.user_id as string) ?? [],
      }));
    return NextResponse.json({ coordinators });
  } catch (err) {
    return toErrorResponse(err);
  }
}
