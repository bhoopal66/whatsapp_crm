// ============================================================
// /api/banks/[id]/actions — the workspace's "Action needed" list (018c,
// 126). GET -> `{ actions }` (a task's status only where the caller may
// read its case).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { bankErrorResponse, loadBankWorkspace } from '@/lib/cases/bank-http';
import { bankWorkspaceStore } from '@/lib/cases/server';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const store = bankWorkspaceStore();
    const workspace = await loadBankWorkspace(store, ctx, id);
    return NextResponse.json({
      actions: await store.actions(workspace.bankWsId, ctx.userId),
    });
  } catch (err) {
    return bankErrorResponse(err);
  }
}
