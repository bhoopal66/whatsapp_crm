// ============================================================
// /api/banks — bank workspaces of the caller's ACTIVE account (018c,
// migration 126; the UI calls them "Banks").
//
// GET -> `{ workspaces, creatable }`: the workspaces the caller has access
// to (bank_ws_list; viewers and bank guests get none), and for owners /
// admins the account's banks (case_banks, read with the caller's RLS
// client) that have no workspace yet, as `{ code, name }`; empty for
// everyone else.
//
// POST `{ bank_code }` (owner / admin) -> 201 `{ id }` when created, 200
// `{ id }` when the bank already had one (bank_ws_create is idempotent).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import {
  bankErrorResponse,
  canCreateBankWorkspace,
} from '@/lib/cases/bank-http';
import {
  badRequest,
  CaseHttpError,
  parseText,
  readJsonObject,
} from '@/lib/cases/http';
import { bankWorkspaceStore } from '@/lib/cases/server';
import { CaseStoreError } from '@/lib/cases/store';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const workspaces = await bankWorkspaceStore().list(
      ctx.userId,
      ctx.accountId
    );
    let creatable: { code: string; name: string }[] = [];
    if (canCreateBankWorkspace(ctx.role)) {
      const { data, error } = await ctx.supabase
        .from('case_banks')
        .select('code, name')
        .eq('account_id', ctx.accountId)
        .order('name');
      if (error) throw new CaseStoreError('case_banks', error.code ?? null);
      const taken = new Set(workspaces.map((w) => w.bankCode));
      creatable = ((data ?? []) as { code: string; name: string }[])
        .filter((b) => !taken.has(b.code))
        .map((b) => ({ code: b.code, name: b.name }));
    }
    return NextResponse.json({ workspaces, creatable });
  } catch (err) {
    return bankErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    if (!canCreateBankWorkspace(ctx.role))
      throw new CaseHttpError(403, 'Only owners and admins can add a bank');
    const bankCode = parseText((await readJsonObject(request))?.bank_code, 32);
    if (bankCode === null) throw badRequest('bank_code is required');

    const store = bankWorkspaceStore();
    const before = await store.list(ctx.userId, ctx.accountId);
    const id = await store.create(ctx.userId, ctx.accountId, bankCode);
    const existed = before.some((w) => w.bankWsId === id);
    return NextResponse.json({ id }, { status: existed ? 200 : 201 });
  } catch (err) {
    return bankErrorResponse(err);
  }
}
