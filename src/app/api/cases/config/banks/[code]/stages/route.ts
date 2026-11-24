// ============================================================
// /api/cases/config/banks/[code]/stages — one bank's stage list (module
// 018c, migration 122). GET (agent and up): `{ stages, isDefault }`; a
// bank with no list of its own gets the defaults (isDefault true). PUT
// (owner / admin) `{ stages: string[] }` (each trimmed, 1–100 characters,
// at most 50; [] = back to the defaults) -> `{ count }`. The database
// refuses dropping a stage an open case is at (STAGE_IN_USE), a list
// without the final stages (BANK_STAGES_*), and a repeated stage
// (STAGE_DUPLICATE), each 422. With `expected` (the list the screen had
// loaded, unchanged) the save is compared with what is stored (309): 409
// STAGES_CHANGED, and 409 STAGE_IN_USE with `{ mappings, sla }`, nothing
// saved, when a Compass status or a deadline rule uses a dropped stage
// and `confirmDropped` is not true.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, requireRole } from '@/lib/auth/account';
import {
  bankCodeParam,
  configErrorResponse,
  readRows,
  requireBank,
} from '@/lib/cases/config-http';
import { badRequest, readObject, requiredText } from '@/lib/cases/http';
import { caseStore } from '@/lib/cases/server';

type Params = { params: Promise<{ code: string }> };

const STAGE_MAX = 100;
const STAGES_MAX = 50;

function stageList(value: unknown): string[] {
  if (!Array.isArray(value)) throw badRequest('stages must be a list');
  if (value.length > STAGES_MAX)
    throw badRequest(`stages may hold at most ${STAGES_MAX} stages`);
  return value.map((s) => requiredText(s, 'stage', STAGE_MAX));
}

/** The list the screen had loaded, as it was sent; absent = not compared. */
function expectedList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((s) => typeof s !== 'string'))
    throw badRequest('expected must be a list of stages');
  return value as string[];
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await requireRole('agent'));
    const code = bankCodeParam((await params).code);
    const [, own, stages] = await Promise.all([
      requireBank(ctx.supabase, ctx.accountId, code),
      readRows(
        ctx.supabase
          .from('case_bank_stages')
          .select('position')
          .eq('account_id', ctx.accountId)
          .eq('bank_code', code)
          .limit(1),
        'case_bank_stages'
      ),
      caseStore().stagesFor(ctx.accountId, code),
    ]);
    return NextResponse.json({ stages, isDefault: own.length === 0 });
  } catch (err) {
    return configErrorResponse(err, 'config stages GET');
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await requireRole('admin'));
    const code = bankCodeParam((await params).code);
    const body = await readObject(request);
    const stages = stageList(body.stages);
    const expected = expectedList(body.expected);
    if (expected === undefined) {
      const count = await caseStore().setStages(
        ctx.userId,
        ctx.accountId,
        code,
        stages
      );
      return NextResponse.json({ count });
    }
    const { saved, count, mappings, sla } = await caseStore().setStages(
      ctx.userId,
      ctx.accountId,
      code,
      stages,
      { expected, confirmDropped: body.confirmDropped === true }
    );
    if (!saved)
      return NextResponse.json(
        {
          error: 'A stage that would be dropped is still used',
          code: 'STAGE_IN_USE',
          mappings,
          sla,
        },
        { status: 409 }
      );
    return NextResponse.json({ count });
  } catch (err) {
    return configErrorResponse(err, 'config stages PUT');
  }
}
