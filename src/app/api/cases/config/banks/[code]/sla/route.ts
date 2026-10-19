// ============================================================
// /api/cases/config/banks/[code]/sla — one bank's SLA timers (module
// 018c, migration 124). GET (agent and up): `{ config, stages }`: the
// bank's rows, each `{ accountId, bankCode, stage, timer, amount, unit,
// dueSoonPct, dueSoonMinutes }`, and its stage list for the editor. POST
// (owner / admin) `{ stage, timer, amount, unit, due_soon_pct?,
// due_soon_minutes? }` -> `{ config }` (create or update; a stage not in
// the bank's list is 422 STAGE_NOT_CONFIGURED). DELETE `?stage=&timer=`
// -> `{ deleted }`.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import {
  bankCodeParam,
  configErrorResponse,
  optionalPositiveInt,
  positiveInt,
  queryParam,
  requireBank,
} from '@/lib/cases/config-http';
import { oneOf, readObject, requiredText } from '@/lib/cases/http';
import { caseSlaStore, caseStore } from '@/lib/cases/server';
import type { SlaTimer, SlaUnit } from '@/lib/cases/sla';

type Params = { params: Promise<{ code: string }> };

/** 124's case_sla_config CHECKs. */
const TIMERS: readonly SlaTimer[] = [
  'customer_reply',
  'bank_response',
  'document_chase',
];
const UNITS: readonly SlaUnit[] = ['minutes', 'days'];
const STAGE_MAX = 100;
const PCT_MAX = 99;

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('agent');
    const code = bankCodeParam((await params).code);
    await requireBank(ctx.supabase, ctx.accountId, code);
    const [config, stages] = await Promise.all([
      caseSlaStore().listConfig(ctx.accountId, code),
      caseStore().stagesFor(ctx.accountId, code),
    ]);
    return NextResponse.json({ config, stages });
  } catch (err) {
    return configErrorResponse(err, 'config sla GET');
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const code = bankCodeParam((await params).code);
    const body = await readObject(request);
    const config = await caseSlaStore().upsertConfig(ctx.userId, {
      accountId: ctx.accountId,
      bankCode: code,
      stage: requiredText(body.stage, 'stage', STAGE_MAX),
      timer: oneOf(body.timer, TIMERS, 'timer'),
      amount: positiveInt(body.amount, 'amount'),
      unit: oneOf(body.unit, UNITS, 'unit'),
      dueSoonPct:
        optionalPositiveInt(body.due_soon_pct, 'due_soon_pct', PCT_MAX) ??
        undefined,
      dueSoonMinutes: optionalPositiveInt(
        body.due_soon_minutes,
        'due_soon_minutes'
      ),
    });
    return NextResponse.json({ config });
  } catch (err) {
    return configErrorResponse(err, 'config sla POST');
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const code = bankCodeParam((await params).code);
    const stage = requiredText(
      queryParam(request, 'stage'),
      'stage',
      STAGE_MAX
    );
    const timer = oneOf(queryParam(request, 'timer'), TIMERS, 'timer');
    const deleted = await caseSlaStore().deleteConfig(
      ctx.userId,
      ctx.accountId,
      code,
      stage,
      timer
    );
    return NextResponse.json({ deleted });
  } catch (err) {
    return configErrorResponse(err, 'config sla DELETE');
  }
}
