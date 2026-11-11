// ============================================================
// /api/cases/rules — case automation rules (migration 187).
// GET (agent and up) -> `{ rules }`. POST (owner / admin) `{ ruleId?,
// name, enabled, trigger, conditions, actions, position? }` -> `{ rule }`.
// Only the types are checked here; what conditions and actions mean is
// the SQL validator's (RULE_INVALID, 422).
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, requireRole } from '@/lib/auth/account';
import { isUuid, readObject } from '@/lib/cases/http';
import { CaseRulesRefusedError, CaseRulesStore } from '@/lib/cases/rules';
import { caseRulesErrorResponse } from '@/lib/cases/rules-http';
import { supabaseAdmin } from '@/lib/submission-groups/server';

const POSITION_MAX = 2147483647;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

export async function GET() {
  try {
    const ctx = assertSalesAccess(await requireRole('agent'));
    const rules = await new CaseRulesStore(supabaseAdmin()).list(ctx.userId);
    return NextResponse.json({ rules });
  } catch (err) {
    return caseRulesErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = assertSalesAccess(await requireRole('admin'));
    const body = await readObject(request);

    let ruleId: string | null = null;
    if (body.ruleId !== undefined && body.ruleId !== null) {
      if (typeof body.ruleId !== 'string' || !isUuid(body.ruleId))
        throw new CaseRulesRefusedError('RULE_NOT_FOUND');
      ruleId = body.ruleId;
    }

    const { name, enabled, trigger, conditions, actions, position } = body;
    const positionBad =
      position !== undefined &&
      position !== null &&
      !(
        typeof position === 'number' &&
        Number.isInteger(position) &&
        position >= 0 &&
        position <= POSITION_MAX
      );
    if (
      typeof name !== 'string' ||
      typeof enabled !== 'boolean' ||
      typeof trigger !== 'string' ||
      !isPlainObject(conditions) ||
      !Array.isArray(actions) ||
      positionBad
    )
      throw new CaseRulesRefusedError('RULE_INVALID');

    const rule = await new CaseRulesStore(supabaseAdmin()).save(ctx.userId, {
      ruleId,
      name,
      enabled,
      trigger,
      conditions,
      actions,
      position: typeof position === 'number' ? position : null,
    });
    return NextResponse.json({ rule });
  } catch (err) {
    return caseRulesErrorResponse(err);
  }
}
