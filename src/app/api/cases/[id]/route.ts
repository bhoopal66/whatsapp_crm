// ============================================================
// /api/cases/[id] — one case (018c).
//
// Both verbs load the case first: another account's case, or one the
// caller has no role on, is 404 (lib/cases/http.ts loadCaseForCaller).
//
// GET: the case, the caller's role and what it allows, the stage list for
// the case's bank, its history and SLA timers, and the outcome reason —
// read through the caller's own RLS client, so RLS decides whether it is
// shown. A case record, not a conversation: no view_case audit row.
// Also the account's Compass setting (134) and whether it locks this
// case; a missing settings row or a failed read is "not managed" (the
// SQL lock still holds, so the page only shows a control that 409s).
//
// PATCH: any of bank_code / product / amount (setDetails), priority,
// due_at (ISO string, or null to clear). Applied in that order, each its
// own RPC; a refusal part-way leaves the earlier ones applied. Answers
// the fresh case.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import {
  canReassignCase,
  canWriteCase,
  isManagedExternally,
} from '@/lib/cases/access';
import {
  badRequest,
  canSeeCaseAudit,
  caseErrorResponse,
  CaseHttpError,
  loadCaseForCaller,
  parseAmount,
  parseText,
  readJsonObject,
} from '@/lib/cases/http';
import { caseSlaStore, caseStore } from '@/lib/cases/server';
import { CaseStoreError } from '@/lib/cases/store';
import type { CasePriority } from '@/lib/cases/types';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const store = caseStore();
    const { case: c, role } = await loadCaseForCaller(ctx, id, store);
    const [stages, history, timers, reason, settings] = await Promise.all([
      store.stagesFor(c.accountId, c.bankCode),
      store.history(c.id),
      caseSlaStore().timers(c.id),
      ctx.supabase
        .from('case_outcome_reasons')
        .select('reason_code, reason_text, created_at')
        .eq('case_id', c.id)
        .maybeSingle(),
      ctx.supabase
        .from('case_account_settings')
        .select('managed_externally')
        .eq('account_id', c.accountId)
        .maybeSingle(),
    ]);
    if (settings.error)
      console.error(
        '[cases] case_account_settings read failed',
        settings.error.code ?? settings.error.message
      );
    const managedExternally =
      !settings.error &&
      (settings.data as Record<string, unknown> | null)?.managed_externally ===
        true;
    if (reason.error)
      throw new CaseStoreError(
        'case_outcome_reasons',
        reason.error.code ?? null
      );
    const r = reason.data as Record<string, unknown> | null;
    return NextResponse.json({
      case: c,
      role,
      permissions: {
        canWrite: canWriteCase(role),
        canReassign: canReassignCase(role),
        canSeeAudit: canSeeCaseAudit(role),
      },
      stages,
      history,
      timers,
      outcomeReason: r
        ? {
            reasonCode: String(r.reason_code),
            reasonText: r.reason_text == null ? null : String(r.reason_text),
            createdAt: String(r.created_at),
          }
        : null,
      managedExternally,
      locked: isManagedExternally({ managedExternally }, c),
    });
  } catch (err) {
    return caseErrorResponse(err);
  }
}

interface CasePatch {
  details: { bankCode?: string; product?: string; amount?: string };
  priority?: CasePriority;
  dueAt?: Date | null;
}

/** The PATCH body; 400 on a bad shape or when it changes nothing. */
function parsePatch(body: Record<string, unknown> | null): CasePatch {
  if (!body) throw badRequest('Body must be a JSON object');
  const out: CasePatch = { details: {} };
  const text = (key: string, parse: (v: unknown) => string | null) => {
    if (body[key] === undefined) return undefined;
    const v = parse(body[key]);
    if (v === null) throw badRequest(`${key} is not valid`);
    return v;
  };
  const bankCode = text('bank_code', (v) => parseText(v));
  const product = text('product', (v) => parseText(v));
  const amount = text('amount', parseAmount);
  if (bankCode !== undefined) out.details.bankCode = bankCode;
  if (product !== undefined) out.details.product = product;
  if (amount !== undefined) out.details.amount = amount;
  // A value outside the list is the database's PRIORITY_INVALID (422).
  if (body.priority !== undefined)
    out.priority = text('priority', (v) => parseText(v, 20)) as CasePriority;
  if (body.due_at !== undefined) {
    const d =
      body.due_at === null
        ? null
        : typeof body.due_at === 'string'
          ? new Date(body.due_at)
          : undefined;
    if (d === undefined || (d !== null && Number.isNaN(d.getTime())))
      throw badRequest('due_at is not valid');
    out.dueAt = d;
  }
  if (
    Object.keys(out.details).length === 0 &&
    out.priority === undefined &&
    out.dueAt === undefined
  )
    throw badRequest('Nothing to change');
  return out;
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const store = caseStore();
    const { case: c, role } = await loadCaseForCaller(ctx, id, store);
    if (!canWriteCase(role)) throw new CaseHttpError(403, 'Not allowed');
    const patch = parsePatch(await readJsonObject(request));

    if (Object.keys(patch.details).length > 0)
      await store.setDetails(c.id, ctx.userId, patch.details);
    if (patch.priority !== undefined)
      await store.setPriority(c.id, ctx.userId, patch.priority);
    if (patch.dueAt !== undefined)
      await store.setDue(c.id, ctx.userId, patch.dueAt);

    const fresh = await store.get(c.id);
    if (!fresh) throw new CaseHttpError(404, 'Case not found');
    return NextResponse.json({ case: fresh });
  } catch (err) {
    return caseErrorResponse(err);
  }
}
