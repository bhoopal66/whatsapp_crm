// ============================================================
// GET   /api/v1/submission-groups/{submission_id} — the case's group
//       (scope: submission_groups:read).
// PATCH /api/v1/submission-groups/{submission_id} — report the
//       submission's status (scope: submission_groups:write). Module 018a.
//
// PATCH records `status` on an ACTIVE group; a final status ends the
// group and closes its WhatsApp group (`closed`), or defers the close
// while a message is still being sent (`close_deferred`; the next call
// retries). On an ENDED group it records nothing and only reports the
// group's state (`ended: false` — this call did not end it).
// Account-scoped: a submission of another workspace → 404.
//
// PATCH also moves the group's case (module 018c): a final status sets
// its stage (case_apply_submission_status), and the answer carries
// `case: { id, stage, outcome }`. That holds on an ENDED group too (staff
// may have ended it before the bank decided): the submission app's final
// status is the case's outcome, and a case already at a final stage is
// left alone by the SQL. Best effort: a case failure is logged and
// answers `case: null`, never an error; a group without a case too.
//
// Case sync (migration 134): a body with changed_at, stage,
// outcome_reason, bank, product, amount, compass_url or documents
// (status then optional) is applied first through
// case_sync_from_submission, on ACTIVE and ENDED groups alike, and the
// answer adds `sync: { applied, reason?, rejected, changes }`. A stale
// update is 200 with `applied: false, reason: 'stale'`; a refusal is 422
// with its code (unknown_stage, presub_reentry, …) and writes nothing.
// A sync that moves the case to a final stage ends an ACTIVE group
// through the same endIfDue a final status uses.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  submissionGroupService,
  submissionGroupStore,
} from '@/lib/submission-groups/server';
import {
  parsePatchInput,
  serializeGroup,
} from '@/lib/submission-groups/api-input';
import { caseStore } from '@/lib/cases/server';
import {
  CaseSyncRefusedError,
  syncCaseFromSubmission,
  syncWire,
} from '@/lib/submission-groups/case-sync';
import type {
  SubmissionGroup,
  SubmissionGroupStore,
} from '@/lib/submission-groups/store';

export const maxDuration = 60;

type Params = { params: Promise<{ submissionId: string }> };

async function wire(store: SubmissionGroupStore, group: SubmissionGroup) {
  return serializeGroup(group, await store.listAccess(group));
}

/** Applies the status to the group's case (when given) and reads it back; null on any failure. */
async function patchCase(
  accountId: string,
  groupId: string,
  status: string | null
) {
  try {
    const cases = caseStore(accountId);
    const caseId = await cases.idForGroup(groupId);
    if (!caseId) return null;
    if (status !== null) await cases.applySubmissionStatus(groupId, status);
    const c = await cases.get(caseId);
    return c ? { id: c.id, stage: c.stage, outcome: c.outcome } : null;
  } catch (err) {
    console.error(
      `[api/v1/submission-groups] case status for group ${groupId}:`,
      err instanceof Error ? err.message : 'unknown error'
    );
    return null;
  }
}

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = await requireApiKey(request, 'submission_groups:read');
    const { submissionId } = await params;
    const store = submissionGroupStore(ctx.supabase);
    const group = await store.findByRef(ctx.accountId, submissionId.trim());
    if (!group) return fail('not_found', 'Submission group not found', 404);
    return ok(await wire(store, group));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireApiKey(request, 'submission_groups:write');
    const { submissionId } = await params;
    const parsed = parsePatchInput(await request.json().catch(() => null));
    if (!parsed.ok) return fail('bad_request', parsed.message, 400);

    const { status, sync } = parsed.value;

    const store = submissionGroupStore(ctx.supabase);
    let group = await store.findByRef(ctx.accountId, submissionId.trim());
    if (!group) return fail('not_found', 'Submission group not found', 404);

    // ctx.supabase is the service-role client (requireApiKey).
    let synced: Awaited<ReturnType<typeof syncCaseFromSubmission>> | null =
      null;
    if (sync) {
      try {
        synced = await syncCaseFromSubmission(ctx.supabase, group.id, sync);
      } catch (err) {
        if (err instanceof CaseSyncRefusedError)
          return fail(
            err.apiCode,
            `The case update was refused (${err.code})`,
            422
          );
        console.error(
          '[api/v1/submission-groups] case sync:',
          err instanceof Error ? err.message : 'unknown error'
        );
        return fail('internal', 'Failed to apply the case update', 500);
      }
    }
    const syncBlock = synced ? { sync: syncWire(synced) } : {};

    if (group.status !== 'ACTIVE')
      return ok({
        ...(await wire(store, group)),
        ended: false,
        closed: group.waClosedAt !== null,
        close_deferred: false,
        case: await patchCase(ctx.accountId, group.id, status),
        ...syncBlock,
      });

    if (status !== null) {
      const { error } = await ctx.supabase.rpc('sg_note_submission_status', {
        p_group: group.id,
        p_status: status,
      });
      if (error) {
        console.error('[api/v1/submission-groups] status note:', error);
        return fail('internal', 'Failed to record the status', 500);
      }
    }
    // A final stage (Approved, Declined, Withdrawn, Closed) is a final
    // status to endIfDue, so a sync that closed the case ends the group
    // exactly as a final status does.
    const endStatus = synced?.final && synced.stage ? synced.stage : status;
    const service = submissionGroupService(ctx.accountId, ctx.supabase);
    const end =
      endStatus === null
        ? { ended: false, closed: false, closeDeferred: false }
        : await service.endIfDue({
            groupId: group.id,
            status: endStatus,
            lastActivityAt: group.lastActivityAt,
            idleDays: null,
            now: new Date(),
          });
    group = (await store.get(group.id)) ?? group;
    const caseWire = await patchCase(ctx.accountId, group.id, status);
    return ok({
      ...(await wire(store, group)),
      ended: end.ended,
      closed: end.closed || group.waClosedAt !== null,
      close_deferred: end.closeDeferred,
      case: caseWire,
      ...syncBlock,
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
