// ============================================================
// GET /api/cases/[id]/rule-runs — what the case rules did on this case
// (migration 187), oldest first. Anyone who can read the case. Answers
// `{ items: [{ ruleId, trigger, matched, applied, at }] }`.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { loadCaseForCaller } from '@/lib/cases/http';
import { CaseRulesStore } from '@/lib/cases/rules';
import { caseRulesErrorResponse } from '@/lib/cases/rules-http';
import { caseStore } from '@/lib/cases/server';
import { supabaseAdmin } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(ctx, id, caseStore());
    const runs = await new CaseRulesStore(supabaseAdmin()).runs(
      ctx.userId,
      c.id
    );
    return NextResponse.json({
      items: runs.map(({ ruleId, trigger, matched, applied, at }) => ({
        ruleId,
        trigger,
        matched,
        applied,
        at,
      })),
    });
  } catch (err) {
    return caseRulesErrorResponse(err);
  }
}
