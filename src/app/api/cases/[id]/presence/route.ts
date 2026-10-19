// ============================================================
// POST /api/cases/[id]/presence — "who else is on this case" (018c).
//
// A UI hint only (lib/cases/presence.ts): one in-memory CasePresence per
// process, so a second instance simply shows fewer people. The case's
// account is checked first; the presence's own canRead (the caller's live
// role on the case) then decides whether the touch is recorded, and a
// refusal is 404 like every other case route. Body `{ state? }`
// ('viewing' default, or 'typing'). Answers `{ viewers }`: the user ids
// of the others on the case within the TTL, never the caller.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { canReadCase } from '@/lib/cases/access';
import {
  badRequest,
  caseErrorResponse,
  CASE_NOT_FOUND,
  CaseHttpError,
  isUuid,
  ownCase,
  readJsonObject,
} from '@/lib/cases/http';
import { CasePresence, type PresenceState } from '@/lib/cases/presence';
import { caseStore } from '@/lib/cases/server';

type Params = { params: Promise<{ id: string }> };

const presence = new CasePresence({
  canRead: async (caseId, userId) =>
    canReadCase(await caseStore().role(caseId, userId)),
});

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    if (!isUuid(id)) throw new CaseHttpError(404, CASE_NOT_FOUND);
    const c = ownCase(await caseStore().get(id), ctx.accountId);

    const body = await readJsonObject(request);
    const state: unknown = body?.state ?? 'viewing';
    if (state !== 'viewing' && state !== 'typing')
      throw badRequest("state must be 'viewing' or 'typing'");

    const me = { userId: ctx.userId };
    if (!(await presence.touch(c.id, me, state as PresenceState)))
      throw new CaseHttpError(404, CASE_NOT_FOUND);
    return NextResponse.json({
      viewers: presence.others(c.id, me).map((e) => e.userId),
    });
  } catch (err) {
    return caseErrorResponse(err);
  }
}
