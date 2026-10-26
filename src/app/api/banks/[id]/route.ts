// ============================================================
// /api/banks/[id] — one bank workspace (018c, migration 126).
// GET -> `{ workspace, cases }`: the workspace (from the caller's
// ACTIVE-account list, else 404) and its cases the caller may read
// (bank_ws_cases), open and closed, each with the tracker's own
// `submissionStatus` (lib/cases/submission-status.ts).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { bankErrorResponse, loadBankWorkspace } from '@/lib/cases/bank-http';
import { bankWorkspaceStore } from '@/lib/cases/server';
import { submissionStatuses } from '@/lib/cases/submission-status';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const store = bankWorkspaceStore();
    const workspace = await loadBankWorkspace(store, ctx, id);
    const cases = await store.cases(workspace.bankWsId, ctx.userId);
    const statuses = await submissionStatuses(
      supabaseAdmin(),
      ctx.accountId,
      cases.map((c) => c.caseId)
    );
    return NextResponse.json({
      workspace,
      cases: cases.map((c) => ({
        ...c,
        submissionStatus: statuses.get(c.caseId) ?? null,
      })),
    });
  } catch (err) {
    return bankErrorResponse(err);
  }
}
