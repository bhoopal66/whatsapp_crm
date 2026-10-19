// ============================================================
// POST /api/contacts/[id]/memory/forget — erase the customer's CRM
// memory (019b, a privacy request). Workspace owner / admin only, with
// the contact loaded first through the caller's RLS client (one they
// cannot see is 404). `{ reason }` (non-blank, at most 1000 characters;
// redacted before it reaches the audit). Answers `{ erased }`, the count
// removed.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import {
  loadContactScope,
  memoryBadRequest,
  memoryErrorResponse,
  MemoryHttpError,
  readJsonObject,
} from '@/lib/memory/contact-http';
import { memoryStore } from '@/lib/memory/server';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const scope = await loadContactScope(ctx, id);
    if (ctx.role !== 'owner' && ctx.role !== 'admin')
      throw new MemoryHttpError(403, 'Not allowed');

    const body = await readJsonObject(request);
    if (!body || typeof body.reason !== 'string')
      throw memoryBadRequest('reason is required');

    let erased: number;
    try {
      erased = await memoryStore().forget(
        ctx.userId,
        ctx.accountId,
        scope,
        body.reason
      );
    } catch (err) {
      if (err instanceof RangeError)
        throw memoryBadRequest('reason must be 1–1000 characters');
      throw err;
    }
    return NextResponse.json({ erased });
  } catch (err) {
    return memoryErrorResponse(err);
  }
}
