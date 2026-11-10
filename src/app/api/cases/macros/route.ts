// ============================================================
// /api/cases/macros — the caller's case macros (186).
//
//   GET  → `{ macros }`: the caller's own macros and the shared macros of
//          their active workspace.
//   POST `{ macroId?, name, actions, shared? }` → `{ macro }`: creates, or
//          (macroId) updates the caller's own macro. 422 NAME_INVALID /
//          ACTION_INVALID, 403 NOT_ALLOWED (someone else's shared macro),
//          404 MACRO_NOT_FOUND. The SQL validates name and actions.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import {
  badRequest,
  caseErrorResponse,
  CaseHttpError,
  isUuid,
  readObject,
} from '@/lib/cases/http';
import { caseMacroStore } from '@/lib/cases/server';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const macros = await caseMacroStore().list(ctx.userId);
    return NextResponse.json({ macros });
  } catch (err) {
    return caseErrorResponse(err, 'macros list');
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = await readObject(request);

    let macroId: string | null = null;
    if (body.macroId !== undefined && body.macroId !== null) {
      if (!isUuid(body.macroId))
        throw new CaseHttpError(404, 'Macro not found', {
          code: 'MACRO_NOT_FOUND',
        });
      macroId = body.macroId;
    }
    let shared: boolean | null = null;
    if (body.shared !== undefined && body.shared !== null) {
      if (typeof body.shared !== 'boolean')
        throw badRequest('shared must be true or false');
      shared = body.shared;
    }

    const macro = await caseMacroStore().save(ctx.userId, {
      macroId,
      name: body.name ?? null,
      actions: body.actions ?? null,
      shared,
    });
    return NextResponse.json({ macro });
  } catch (err) {
    return caseErrorResponse(err, 'macro save');
  }
}
