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
// `case: { id, stage, outcome }`. Best effort: a case failure is logged
// and answers `case: null`, never an error; a group without a case too.
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

    const store = submissionGroupStore(ctx.supabase);
    let group = await store.findByRef(ctx.accountId, submissionId.trim());
    if (!group) return fail('not_found', 'Submission group not found', 404);

    if (group.status !== 'ACTIVE')
      return ok({
        ...(await wire(store, group)),
        ended: false,
        closed: group.waClosedAt !== null,
        close_deferred: false,
        case: await patchCase(ctx.accountId, group.id, null),
      });

    const { error } = await ctx.supabase.rpc('sg_note_submission_status', {
      p_group: group.id,
      p_status: parsed.value.status,
    });
    if (error) {
      console.error('[api/v1/submission-groups] status note:', error);
      return fail('internal', 'Failed to record the status', 500);
    }
    const service = submissionGroupService(ctx.accountId, ctx.supabase);
    const end = await service.endIfDue({
      groupId: group.id,
      status: parsed.value.status,
      lastActivityAt: group.lastActivityAt,
      idleDays: null,
      now: new Date(),
    });
    group = (await store.get(group.id)) ?? group;
    const caseWire = await patchCase(
      ctx.accountId,
      group.id,
      parsed.value.status
    );
    return ok({
      ...(await wire(store, group)),
      ended: end.ended,
      closed: end.closed || group.waClosedAt !== null,
      close_deferred: end.closeDeferred,
      case: caseWire,
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
