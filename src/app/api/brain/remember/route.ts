// ============================================================
// POST /api/brain/remember — a staff member's "remember this" (022b,
// migration 194). Agent and up. Body `{ text (1-4000), caseId?,
// contactId? }`: a case must be readable by the caller (404 otherwise), a
// contact visible through the caller's RLS client (404 otherwise). The
// text is redacted before it is stored; a redaction refusal is 422
// `{ error: 'REDACTION_REFUSED' }`. -> 201 `{ itemIds, duplicate }`, where
// `duplicate` means every chunk was already stored. Text is never logged.
// The pages built from the new items are then marked dirty (022d-2),
// best-effort: a failure is counted in brain_page_dirty_failures only.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  assertSalesAccess,
  getCurrentAccount,
} from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { loadCaseForCaller, readObject, requiredText } from '@/lib/cases/http';
import { caseStore } from '@/lib/cases/server';
import { ingestRemember } from '@/lib/brain/ingest';
import { markPagesDirty } from '@/lib/brain/sink';
import {
  BrainHttpError,
  brainDeps,
  brainPages,
  brainErrorResponse,
  optionalUuid,
  requireBrain,
  requireVisibleContact,
} from '@/lib/brain/server';

const TEXT_MAX = 4000;

export async function POST(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    await requireBrain(ctx);
    if (!hasMinRole(ctx.role, 'agent')) throw new ForbiddenError();
    const body = await readObject(request);
    const text = requiredText(body.text, 'text', TEXT_MAX);
    const caseId = optionalUuid(body.caseId, 'caseId');
    const contactId = optionalUuid(body.contactId, 'contactId');
    if (caseId) await loadCaseForCaller(ctx, caseId, caseStore(ctx.accountId));
    if (contactId) await requireVisibleContact(ctx, contactId);
    const r = await ingestRemember(brainDeps(), ctx.userId, text, {
      accountId: ctx.accountId,
      caseId,
      contactId,
    });
    if (!r.ok) throw new BrainHttpError(422, 'REDACTION_REFUSED');
    // 022d-2: pages built from these items go dirty; never fails the call.
    await markPagesDirty(brainPages(), ctx.accountId, r.itemIds);
    return NextResponse.json(
      {
        itemIds: r.itemIds,
        duplicate: r.itemIds.length === 0 && r.skipped > 0,
      },
      { status: 201 }
    );
  } catch (err) {
    return brainErrorResponse(err, 'remember');
  }
}
