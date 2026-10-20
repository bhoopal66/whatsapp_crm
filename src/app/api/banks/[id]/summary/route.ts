// ============================================================
// /api/banks/[id]/summary — the bank page header's figures (migration 131).
// GET -> `{ summary }` (BankWsSummary: open cases, members by role, open
// actions, the caller's role here). The workspace must be in the caller's
// ACTIVE-account list, and bank_ws_summary's NULL (no access) is the same
// 404 as any other bank route, so a non-member never learns it exists.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import {
  BANK_WS_NOT_FOUND,
  bankErrorResponse,
  loadBankWorkspace,
} from '@/lib/cases/bank-http';
import { CaseHttpError } from '@/lib/cases/http';
import { bankWorkspaceStore } from '@/lib/cases/server';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const store = bankWorkspaceStore();
    const workspace = await loadBankWorkspace(store, ctx, id);
    const summary = await store.summary(workspace.bankWsId, ctx.userId);
    if (!summary) throw new CaseHttpError(404, BANK_WS_NOT_FOUND);
    return NextResponse.json(
      { summary },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return bankErrorResponse(err);
  }
}
