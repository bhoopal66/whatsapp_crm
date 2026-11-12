// ============================================================
// POST /api/cases/[id]/macros/[macroId]/apply — apply a case macro (186)
// to one case, action by action, as the caller (lib/cases/macros.ts).
//
// Tenancy first: the case must be in the caller's active account and
// writable by them (404 / 403) before the macro is read; an invisible
// macro is 404 MACRO_NOT_FOUND. Nothing is written or logged on any of
// those. A refused ACTION is not an HTTP error:
//   200 `{ applied: [{ kind, ok, code?, reason?, groupEnd? }],
//          documentRequestPreview?, stoppedAt?: { index, code, reason } }`
// Earlier actions stay applied (no transaction across actions).
// request_documents only previews the text; nothing is sent.
// ============================================================

import { after, NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import {
  caseErrorResponse,
  CaseHttpError,
  isUuid,
  loadCaseForCaller,
  refusalText,
} from '@/lib/cases/http';
import { applyMacro } from '@/lib/cases/macros';
import { caseMacroDeps, caseStore } from '@/lib/cases/server';
import { brainSink, stageChangedEvent, type SinkEvent } from '@/lib/brain/sink';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string; macroId: string }> };

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id, macroId } = await params;
    const { case: c } = await loadCaseForCaller(
      ctx,
      id,
      caseStore(ctx.accountId),
      { write: true }
    );
    if (!isUuid(macroId))
      throw new CaseHttpError(404, 'Macro not found', {
        code: 'MACRO_NOT_FOUND',
      });

    const now = new Date();
    const deps = caseMacroDeps(ctx.accountId, now);
    // A stage the macro moved is handed to the brain after the response,
    // also when a later action stopped the run (earlier actions stay).
    const moves: SinkEvent[] = [];
    after(async () => {
      for (const ev of moves) await brainSink().record(ev);
    });
    const cases: typeof deps.cases = {
      setStage: async (caseId, actor, stage, outcome) => {
        const r = await deps.cases.setStage(caseId, actor, stage, outcome);
        const ev = stageChangedEvent(
          {
            accountId: ctx.accountId,
            caseId,
            contactId: c.contactId ?? null,
            bankCode: c.bankCode ?? null,
            createdBy: actor,
          },
          r
        );
        if (ev) moves.push(ev);
        return r;
      },
    };
    const result = await applyMacro(
      { ...deps, cases, refusalText },
      { case: c, actor: ctx.userId, macroId, now }
    );
    return NextResponse.json(result);
  } catch (err) {
    return caseErrorResponse(err, 'macro apply');
  }
}
