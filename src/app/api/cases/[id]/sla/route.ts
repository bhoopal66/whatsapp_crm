// ============================================================
// /api/cases/[id]/sla — the case's SLA timers (018c, migration 124).
// GET (any case role): `{ timers }`, each `{ timer, stage, startedAt,
// dueSoonAt, dueAt, stoppedAt, state }`. POST (case writers), one of:
//   `{ timer: 'customer_reply' | 'bank_response' | 'document_chase',
//      action: 'start' | 'stop' | 'reset' }`  (start / reset need a
//      config row for the case's bank and stage: SLA_NOT_CONFIGURED, 422)
//   `{ event: 'bank_response' | 'customer_message' }`, as the caller
// -> 200 `{ slaState }` (the case's state after it; null: none running).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import {
  CaseHttpError,
  caseErrorResponse,
  loadCaseForCaller,
  oneOf,
  readObject,
} from '@/lib/cases/http';
import { caseSlaStore, caseStore } from '@/lib/cases/server';
import type { SlaActorEvent, SlaTimer, SlaTimerAction } from '@/lib/cases/sla';

type Params = { params: Promise<{ id: string }> };

const TIMERS: readonly SlaTimer[] = [
  'customer_reply',
  'bank_response',
  'document_chase',
];
const ACTIONS: readonly SlaTimerAction[] = ['start', 'stop', 'reset'];
const EVENTS: readonly SlaActorEvent[] = ['bank_response', 'customer_message'];

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(
      ctx,
      id,
      caseStore(ctx.accountId),
      {
        write: false,
      }
    );
    return NextResponse.json({ timers: await caseSlaStore().timers(c.id) });
  } catch (err) {
    return caseErrorResponse(err, 'sla GET');
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { case: c } = await loadCaseForCaller(
      ctx,
      id,
      caseStore(ctx.accountId),
      {
        write: true,
      }
    );
    const b = await readObject(request);
    const hasTimer = b.timer !== undefined;
    if (hasTimer === (b.event !== undefined))
      throw new CaseHttpError(400, 'Send either timer and action, or event');

    const sla = caseSlaStore();
    const slaState = hasTimer
      ? await sla.timer(
          c.id,
          ctx.userId,
          oneOf(b.timer, TIMERS, 'timer'),
          oneOf(b.action, ACTIONS, 'action')
        )
      : await sla.event(c.id, ctx.userId, oneOf(b.event, EVENTS, 'event'));
    return NextResponse.json({ slaState });
  } catch (err) {
    return caseErrorResponse(err, 'sla POST');
  }
}
