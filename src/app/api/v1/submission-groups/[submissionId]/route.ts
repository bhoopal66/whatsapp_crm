// ============================================================
// GET   /api/v1/submission-groups/{submission_id} — the case's group
//       (scope: submission_groups:read).
// PATCH /api/v1/submission-groups/{submission_id} — report the
//       submission's status (scope: submission_groups:write). Module 018a.
//
// PATCH records `status` on an ACTIVE group; a final status ends the
// group and closes its WhatsApp group (`closed`), or defers the close
// while a message is still being sent (`close_deferred`; the next call
// retries). On an ENDED group it records a later status (267) and reports
// the group's state (`ended: false` — this call did not end it).
// Account-scoped: a submission of another workspace → 404.
//
// A group without a case (the POST could not open it) gets one first, with
// the body's bank, product and amount; a failure there is a 500 and writes
// nothing else, so the submission app sends the PATCH again. Only a group
// with no agent left (an ENDED one) goes on without a case: `case: null`.
//
// PATCH also moves the group's case (module 018c): a final status sets
// its stage (case_apply_submission_status), and since 137 any other
// status moves the case to the stage of the same name (UNDER_REVIEW ->
// Under review), unless the same body carries an explicit `stage`, which
// wins. The answer carries
// `case: { id, stage, outcome }`. That holds on an ENDED group too (staff
// may have ended it before the bank decided): the submission app's final
// status is the case's outcome, and a case already at a final stage is
// left alone by the SQL. A status the case could not take answers 500, so
// the submission app sends it again: a repeat on the group this call
// ended re-applies the status (a repeated changed_at is not stale: only
// an older one is). Reading the case back for the answer is best effort
// (`case: null`). A status a closed case did not take is still a 200, with
// `case_status_applied: false` and `case_status_reason: 'case_closed'`.
//
// Case sync (migration 134): a body with changed_at, stage,
// outcome_reason, bank, product, amount, compass_url or documents
// (status then optional) is applied first through
// case_sync_from_submission, on ACTIVE and ENDED groups alike, and the
// answer adds `sync: { applied, reason?, rejected, changes }`. A stale
// update is 200 with `applied: false, reason: 'stale'`; a refusal is 422
// with its code (unknown_stage, presub_reentry, …) and writes nothing.
// A stale sync also skips every status step (note, end, case status):
// the body's status is as old as its changed_at.
// A sync that moves the case to a final stage on an ACTIVE group takes
// the case's group-end claim in SQL (group_end_token) and ends the group
// through the case store, as a person's stage move does, so the case
// sweeper never ends the same group concurrently; a failed end releases
// the claim for the sweeper. endIfDue then runs for nothing else.
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
import {
  caseErrorText,
  ensureGroupCase,
} from '@/lib/submission-groups/open-case';
import { isFinalStatus } from '@/lib/submission-groups/rules';
import type {
  SubmissionGroup,
  SubmissionGroupStore,
} from '@/lib/submission-groups/store';

export const maxDuration = 60;

type Params = { params: Promise<{ submissionId: string }> };

async function wire(store: SubmissionGroupStore, group: SubmissionGroup) {
  return serializeGroup(group, await store.listAccess(group));
}

/** The group's case as the answer carries it; null without one, or on any failure (best effort). */
async function readCase(accountId: string, groupId: string) {
  try {
    const cases = caseStore(accountId);
    const caseId = await cases.idForGroup(groupId);
    const c = caseId ? await cases.get(caseId) : null;
    return c ? { id: c.id, stage: c.stage, outcome: c.outcome } : null;
  } catch (err) {
    console.error(
      `[api/v1/submission-groups] case read for group ${groupId}:`,
      caseErrorText(err)
    );
    return null;
  }
}

/**
 * Applies the status (when given) to the group's case. `ok: false` when that
 * failed, logged: the caller answers 500 so the submission app sends the
 * status again, which is safe (a case already at a final stage, or at the
 * status's stage, is left alone by the SQL). `notApplied` is the part of
 * the answer for a status the case did not take because it is closed. The
 * SQL's false also covers a status that names no stage and the status the
 * case was closed with (a repeat, or a sync that just closed it): those
 * add nothing. Reading the case for it is best effort.
 */
async function applyCaseStatus(
  accountId: string,
  groupId: string,
  status: string | null
): Promise<
  | { ok: false }
  | {
      ok: true;
      notApplied: {
        case_status_applied?: false;
        case_status_reason?: 'case_closed';
      };
    }
> {
  if (status === null) return { ok: true, notApplied: {} };
  try {
    const cases = caseStore(accountId);
    if (await cases.applySubmissionStatus(groupId, status))
      return { ok: true, notApplied: {} };
  } catch (err) {
    console.error(
      `[api/v1/submission-groups] case status for group ${groupId}:`,
      caseErrorText(err)
    );
    return { ok: false };
  }
  try {
    const cases = caseStore(accountId);
    const caseId = await cases.idForGroup(groupId);
    const c = caseId ? await cases.get(caseId) : null;
    if (!c?.closedAt || closesAs(status, c.stage))
      return { ok: true, notApplied: {} };
    console.warn(
      `[api/v1/submission-groups] status not applied for group ${groupId}: case_closed`
    );
    return {
      ok: true,
      notApplied: {
        case_status_applied: false,
        case_status_reason: 'case_closed',
      },
    };
  } catch (err) {
    console.error(
      `[api/v1/submission-groups] closed case check for group ${groupId}:`,
      caseErrorText(err)
    );
    return { ok: true, notApplied: {} };
  }
}

/** Every final status ends in the word of its stage ("Customer Withdrawn"). */
function closesAs(status: string, stage: string): boolean {
  const last =
    status
      .trim()
      .split(/[\s_]+/)
      .pop() ?? '';
  return isFinalStatus(status) && last.toUpperCase() === stage.toUpperCase();
}

const caseStatusFailed = () =>
  fail('internal', "Failed to apply the status to the submission's case", 500);

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
    if (!parsed.ok)
      return parsed.code
        ? fail(parsed.code, parsed.message, 422)
        : fail('bad_request', parsed.message, 400);

    const { status, sync } = parsed.value;
    // 137: a non-final status names a stage, but Compass's own `stage` in
    // the same body wins, so the case then gets only a final status.
    const caseStatus =
      status !== null &&
      sync?.patch.stage !== undefined &&
      !isFinalStatus(status)
        ? null
        : status;

    const store = submissionGroupStore(ctx.supabase);
    let group = await store.findByRef(ctx.accountId, submissionId.trim());
    if (!group) return fail('not_found', 'Submission group not found', 404);

    // The case the POST could not open: the sync and the status below have
    // nothing to act on without it.
    try {
      const has = await ensureGroupCase(caseStore(ctx.accountId), group.id, {
        bankCode: sync?.patch.bank,
        product: sync?.patch.product,
        amount: sync?.patch.amount,
      });
      if (!has)
        console.warn(
          `[api/v1/submission-groups] no agent to open the case of group ${group.id} for`
        );
    } catch (err) {
      console.error(
        `[api/v1/submission-groups] case open for group ${group.id}:`,
        caseErrorText(err)
      );
      return fail('internal', "Failed to open the submission's case", 500);
    }

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

    if (synced && !synced.applied && synced.reason === 'stale')
      return ok({
        ...(await wire(store, group)),
        ended: false,
        closed: group.waClosedAt !== null,
        close_deferred: false,
        case: await readCase(ctx.accountId, group.id),
        ...syncBlock,
      });

    if (group.status !== 'ACTIVE') {
      // 267: a status after the final one (a correction, "disbursed") is
      // stored on the group and logged on the case; a repeat is a no-op.
      if (status !== null) {
        const { error } = await ctx.supabase.rpc('sg_note_submission_status', {
          p_group: group.id,
          p_status: status,
        });
        if (error) {
          console.error('[api/v1/submission-groups] status note:', error);
          return fail('internal', 'Failed to record the status', 500);
        }
        group = (await store.get(group.id)) ?? group;
      }
      const applied = await applyCaseStatus(
        ctx.accountId,
        group.id,
        caseStatus
      );
      if (!applied.ok) return caseStatusFailed();
      return ok({
        ...(await wire(store, group)),
        ended: false,
        closed: group.waClosedAt !== null,
        close_deferred: false,
        case: await readCase(ctx.accountId, group.id),
        ...applied.notApplied,
        ...syncBlock,
      });
    }

    if (status !== null) {
      const { error } = await ctx.supabase.rpc('sg_note_submission_status', {
        p_group: group.id,
        p_status: status,
      });
      if (error) {
        console.error('[api/v1/submission-groups] status note:', error);
        // The sync's final move already committed and holds the group-end
        // claim: settle it now (end, else release), or a retry finds the
        // stage unchanged, takes no claim and races the held one.
        if (synced?.groupEndToken && synced.caseId && synced.stage)
          await caseStore(ctx.accountId)
            .endClaimedGroup(synced.caseId, synced.stage, synced.groupEndToken)
            .catch(() => undefined);
        return fail('internal', 'Failed to record the status', 500);
      }
    }
    let end: { ended: boolean; closed: boolean; closeDeferred: boolean };
    if (synced?.groupEndToken && synced.caseId && synced.stage) {
      // The sync's final move holds the claim: end through the case path
      // (finish on an end, release otherwise), never endIfDue as well.
      const r = await caseStore(ctx.accountId).endClaimedGroup(
        synced.caseId,
        synced.stage,
        synced.groupEndToken
      );
      end = {
        ended: r.end?.ended ?? false,
        closed: r.end?.closed ?? false,
        closeDeferred: r.end?.closeDeferred ?? false,
      };
    } else if (status === null) {
      end = { ended: false, closed: false, closeDeferred: false };
    } else {
      end = await submissionGroupService(ctx.accountId, ctx.supabase).endIfDue({
        groupId: group.id,
        status,
        lastActivityAt: group.lastActivityAt,
        idleDays: null,
        now: new Date(),
      });
    }
    group = (await store.get(group.id)) ?? group;
    // After the end: a retry finds the group ENDED and re-applies it there.
    const applied = await applyCaseStatus(ctx.accountId, group.id, caseStatus);
    if (!applied.ok) return caseStatusFailed();
    return ok({
      ...(await wire(store, group)),
      ended: end.ended,
      closed: end.closed || group.waClosedAt !== null,
      close_deferred: end.closeDeferred,
      case: await readCase(ctx.accountId, group.id),
      ...applied.notApplied,
      ...syncBlock,
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
