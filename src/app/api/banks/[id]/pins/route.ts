// ============================================================
// /api/banks/[id]/pins — the workspace's pinned info (018c, 126), one
// versioned text per kind (PIN_KINDS). INTERNAL ONLY, never logged.
// GET (`?history=1` for every version, blank ones included) -> `{ pins }`.
// PUT `{ kind, body }` (body up to 8000, trimmed; blank clears the kind)
// -> `{ pinId }`. An unknown kind is KIND_INVALID (422).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { bankErrorResponse, loadBankWorkspace } from '@/lib/cases/bank-http';
import {
  BANK_WS_CAPS,
  BankWorkspaceRefusedError,
  PIN_KINDS,
  type PinKind,
} from '@/lib/cases/bank-workspaces';
import { badRequest, readJsonObject } from '@/lib/cases/http';
import { bankWorkspaceStore } from '@/lib/cases/server';

type Params = { params: Promise<{ id: string }> };

const isPinKind = (v: unknown): v is PinKind =>
  (PIN_KINDS as readonly unknown[]).includes(v);

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const store = bankWorkspaceStore();
    const workspace = await loadBankWorkspace(store, ctx, id);
    const h = new URL(request.url).searchParams.get('history');
    const pins = await store.pins(workspace.bankWsId, ctx.userId, {
      history: h === '1' || h === 'true',
    });
    return NextResponse.json({ pins });
  } catch (err) {
    return bankErrorResponse(err);
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const store = bankWorkspaceStore();
    const workspace = await loadBankWorkspace(store, ctx, id);
    const input = await readJsonObject(request);
    if (!input) throw badRequest('Body must be a JSON object');
    if (!isPinKind(input.kind))
      throw new BankWorkspaceRefusedError('KIND_INVALID');
    if (typeof input.body !== 'string') throw badRequest('body is required');
    const body = input.body.trim();
    if (body.length > BANK_WS_CAPS.pin)
      throw badRequest(`body must be at most ${BANK_WS_CAPS.pin} characters`);

    const pinId = await store.setPin(
      workspace.bankWsId,
      ctx.userId,
      input.kind,
      body
    );
    return NextResponse.json({ pinId });
  } catch (err) {
    return bankErrorResponse(err);
  }
}
