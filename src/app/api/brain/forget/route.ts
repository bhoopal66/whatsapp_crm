// ============================================================
// POST /api/brain/forget — erase brain items (022b, migration 194).
// Admin and up (checked here before any call; SQL refuses anyone else
// with NOT_ALLOWED too). Body: exactly one of `itemId` (uuid) |
// `contactId` (uuid) | `olderThan` (ISO date), plus `reason` (1-500)
// -> 200 `{ forgotten: n }`.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  assertSalesAccess,
  getCurrentAccount,
} from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import {
  badRequest,
  readObject,
  requiredDate,
  requiredText,
} from '@/lib/cases/http';
import type { ForgetScope } from '@/lib/brain/ports';
import {
  brainDeps,
  brainErrorResponse,
  optionalUuid,
  requireBrain,
} from '@/lib/brain/server';

const REASON_MAX = 500;
const present = (v: unknown) => v !== undefined && v !== null;

export async function POST(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    await requireBrain(ctx);
    if (!hasMinRole(ctx.role, 'admin')) throw new ForbiddenError();
    const body = await readObject(request);
    const n = [body.itemId, body.contactId, body.olderThan].filter(
      present
    ).length;
    if (n !== 1)
      throw badRequest('Give exactly one of itemId, contactId or olderThan');
    const reason = requiredText(body.reason, 'reason', REASON_MAX);
    let scope: ForgetScope;
    if (present(body.itemId))
      scope = { itemId: optionalUuid(body.itemId, 'itemId') as string };
    else if (present(body.contactId))
      scope = {
        contactId: optionalUuid(body.contactId, 'contactId') as string,
      };
    else scope = { olderThan: requiredDate(body.olderThan, 'olderThan') };
    const forgotten = await brainDeps().store.forget(
      { actorId: ctx.userId },
      ctx.accountId,
      scope,
      reason
    );
    return NextResponse.json({ forgotten });
  } catch (err) {
    return brainErrorResponse(err, 'forget');
  }
}
