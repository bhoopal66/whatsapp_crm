// ============================================================
// /api/banks/[id]/dashboard — the bank's figures (018c, migration 127).
// GET -> `{ dashboard }` (BankDashboardData: scope 'all' for admins,
// 'own' otherwise; counts and amounts, never a case or customer id).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { bankErrorResponse, loadBankWorkspace } from '@/lib/cases/bank-http';
import { bankDashboard, bankWorkspaceStore } from '@/lib/cases/server';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const workspace = await loadBankWorkspace(bankWorkspaceStore(), ctx, id);
    return NextResponse.json({
      dashboard: await bankDashboard().get(ctx.userId, workspace.bankWsId),
    });
  } catch (err) {
    return bankErrorResponse(err);
  }
}
