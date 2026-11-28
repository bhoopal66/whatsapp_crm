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
// And the case's snoozed_until (185) as `snoozedUntil`, read the same
// soft way: any error, the column missing before 185 included, is null.
// And (333) `permissions.canSendToGroup`: whether the caller may send to
// the case's group, as sg_can_send decides (ACTIVE, live staff, and on
// the list, leading the agent, holding the bank, or an owner/admin of the
// account). Separate from canWrite, which stays the case write rule. A
// lead has no group (false); a failed check reads as false, and the send
// path decides again under the group lock.
//
// PATCH: any of bank_code / product / amount (setDetails), priority,
// due_at (ISO string, or null to clear). Applied in that order, each its
// own RPC; a priority or a date that is not valid is refused before the
// first of them, but a refusal only the database can make part-way leaves
// the earlier ones applied. Answers the fresh case.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, assertSalesAccess } from '@/lib/auth/account';
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
  optionalDate,
  parseAmount,
  parseText,
  readJsonObject,
} from '@/lib/cases/http';
import { caseSlaStore, caseStore } from '@/lib/cases/server';
import { CaseRefusedError, CaseStoreError } from '@/lib/cases/store';
import { PRIORITIES, type CasePriority } from '@/lib/cases/types';
import { submissionGroupStore } from '@/lib/submission-groups/server';

type Params = { params: Promise<{ id: string }> };

/** sg_can_send for the case's group (333); the caller's tenancy is checked. */
async function canSendToCaseGroup(
  groupId: string | null,
  userId: string
): Promise<boolean> {
  if (!groupId) return false;
  try {
    return await submissionGroupStore().canSend(groupId, userId);
  } catch (err) {
    console.error(
      '[cases] sg_can_send failed',
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const store = caseStore();
    const { case: c, role } = await loadCaseForCaller(ctx, id, store);
    const [stages, history, timers, reason, settings, snooze, canSendToGroup] =
      await Promise.all([
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
        // Soft, like the settings read: before 185 the column does not
        // exist, and any error reads as "not snoozed". Deliberately not in
        // the store's CASE_COLUMNS, which would fail the whole page then.
        ctx.supabase
          .from('cases')
          .select('snoozed_until')
          .eq('id', c.id)
          .maybeSingle(),
        canSendToCaseGroup(c.groupId, ctx.userId),
      ]);
    const snoozedRaw = snooze.error
      ? null
      : (snooze.data as Record<string, unknown> | null)?.snoozed_until;
    const snoozedUntil =
      typeof snoozedRaw === 'string' &&
      !Number.isNaN(new Date(snoozedRaw).getTime())
        ? new Date(snoozedRaw).toISOString()
        : null;
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
        canSendToGroup,
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
      snoozedUntil,
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
  if (body.priority !== undefined) {
    const priority = text('priority', (v) => parseText(v, 20)) as CasePriority;
    // The database's own refusal (422), before anything is written.
    if (!PRIORITIES.includes(priority))
      throw new CaseRefusedError('PRIORITY_INVALID');
    out.priority = priority;
  }
  if (body.due_at !== undefined)
    out.dueAt = optionalDate(body.due_at, 'due_at');
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
    const ctx = assertSalesAccess(await getCurrentAccount());
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
