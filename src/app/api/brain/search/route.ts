// ============================================================
// POST /api/brain/search — second brain search (022b, migration 194).
// Body `{ query (1-300 chars after trim), caseId?, contactId?, bankCode?,
// limit? (1-20) }` -> 200 `{ hits }`, `Cache-Control: no-store`. The query
// travels in the body, never the URL, and is never logged. Every member
// may call it (a viewer gets what SQL lets them see: nothing); account
// and actor are the session's.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import {
  badRequest,
  optionalText,
  readObject,
  requiredText,
} from '@/lib/cases/http';
import { RateLimiter, RpcRateStore } from '@/lib/edge';
import type { BrainFilters } from '@/lib/brain/ports';
import { searchBrain } from '@/lib/brain/search';
import {
  brainDeps,
  brainErrorResponse,
  optionalUuid,
  requireBrain,
} from '@/lib/brain/server';
import { supabaseAdmin } from '@/lib/submission-groups/server';

const QUERY_MAX = 300;
const LIMIT_MAX = 20;

export async function POST(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    await requireBrain(ctx);
    // 60 a minute per person: search is the one brain route that fans out
    // to the embedding provider. Fails open if the store is down.
    const decision = await new RateLimiter(
      new RpcRateStore(supabaseAdmin())
    ).check('brain.search', `${ctx.accountId}:${ctx.userId}`);
    if (!decision.allowed)
      return NextResponse.json(
        { error: 'rate_limited' },
        {
          status: 429,
          headers: {
            'Retry-After': String(
              Math.max(1, Math.ceil(decision.retryAfterMs / 1000))
            ),
          },
        }
      );
    const body = await readObject(request);
    const query = requiredText(body.query, 'query', QUERY_MAX);
    const filters: BrainFilters = {};
    const caseId = optionalUuid(body.caseId, 'caseId');
    const contactId = optionalUuid(body.contactId, 'contactId');
    const bankCode = optionalText(body.bankCode, 'bankCode', 50);
    if (caseId) filters.caseId = caseId;
    if (contactId) filters.contactId = contactId;
    if (bankCode) filters.bankCode = bankCode;
    let limit: number | undefined;
    if (body.limit !== undefined && body.limit !== null) {
      if (
        typeof body.limit !== 'number' ||
        !Number.isInteger(body.limit) ||
        body.limit < 1 ||
        body.limit > LIMIT_MAX
      )
        throw badRequest(`limit must be an integer from 1 to ${LIMIT_MAX}`);
      limit = body.limit;
    }
    const hits = await searchBrain(brainDeps(), {
      actorId: ctx.userId,
      accountId: ctx.accountId,
      query,
      filters,
      limit,
    });
    return NextResponse.json(
      { hits },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return brainErrorResponse(err, 'search');
  }
}
