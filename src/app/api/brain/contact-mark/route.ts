// ============================================================
// POST /api/brain/contact-mark — mark a contact opted out / for deletion
// in the brain (022b, migration 194): its items stop being returned and
// nothing new is stored for it. Agent and up. Body `{ contactId (uuid),
// kind: 'opt_out' | 'deletion' }`; the contact must be visible through the
// caller's RLS client (404 otherwise) -> 200 `{ ok: true }`. Marks only
// narrow: there is no "clear". The contact's summary page is then
// forgotten (022c), best-effort.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  assertSalesAccess,
  getCurrentAccount,
} from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { badRequest, oneOf, readObject } from '@/lib/cases/http';
import type { ContactMarkKind } from '@/lib/brain/ports';
import { brainSinkCounters } from '@/lib/brain/sink';
import {
  brainDeps,
  brainErrorResponse,
  brainPages,
  optionalUuid,
  requireBrain,
  requireVisibleContact,
} from '@/lib/brain/server';

const KINDS: readonly ContactMarkKind[] = ['opt_out', 'deletion'];

export async function POST(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    await requireBrain(ctx);
    if (!hasMinRole(ctx.role, 'agent')) throw new ForbiddenError();
    const body = await readObject(request);
    const contactId = optionalUuid(body.contactId, 'contactId');
    if (!contactId) throw badRequest('contactId is required');
    const kind = oneOf(body.kind, KINDS, 'kind');
    await requireVisibleContact(ctx, contactId);
    await brainDeps().store.markContact(
      ctx.userId,
      ctx.accountId,
      contactId,
      kind
    );
    // 022c: delete the contact's page and wipe every page built from its
    // items. Best-effort: the mark stands, a failure is logged and counted.
    try {
      await brainPages().forget(
        { actorId: ctx.userId },
        ctx.accountId,
        contactId,
        'opt_out'
      );
    } catch (err) {
      brainSinkCounters.brain_page_dirty_failures++;
      console.warn(
        '[brain] contact-mark page forget failed',
        err instanceof Error ? err.name : typeof err
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return brainErrorResponse(err, 'contact-mark');
  }
}
