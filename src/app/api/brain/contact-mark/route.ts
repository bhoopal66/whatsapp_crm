// ============================================================
// POST /api/brain/contact-mark — mark a contact opted out / for deletion
// in the brain (022b, migration 194): its items stop being returned and
// nothing new is stored for it. Agent and up. Body `{ contactId (uuid),
// kind: 'opt_out' | 'deletion' }`; the contact must be visible through the
// caller's RLS client (404 otherwise) -> 200 `{ ok: true }`. Marks only
// narrow: there is no "clear".
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
import {
  brainDeps,
  brainErrorResponse,
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
    return NextResponse.json({ ok: true });
  } catch (err) {
    return brainErrorResponse(err, 'contact-mark');
  }
}
