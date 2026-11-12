// ============================================================
// POST /api/brain/pages/rebuild — rebuild the caller's account's dirty
// summary pages, oldest dirty first (022c). Admin and up (403 before any
// store call). Body `{ limit? }`: an integer 1-50, default 20; an empty
// body is the default. -> 200 `{ rebuilt, failed, remaining }`. A page
// that fails is counted in `failed`, never thrown. No scheduler: this
// route (or a job calling rebuildDirtyPages) is the only builder.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  assertSalesAccess,
  getCurrentAccount,
} from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { badRequest } from '@/lib/cases/http';
import { ExtractiveSummariser, rebuildDirtyPages } from '@/lib/brain/pages';
import {
  brainErrorResponse,
  brainPages,
  requireBrain,
} from '@/lib/brain/server';

const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 50;

async function readLimit(request: Request): Promise<number> {
  const raw = await request.text();
  if (!raw.trim()) return LIMIT_DEFAULT;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw badRequest('Body must be a JSON object');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw badRequest('Body must be a JSON object');
  const limit = (body as Record<string, unknown>).limit;
  if (limit === undefined || limit === null) return LIMIT_DEFAULT;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > LIMIT_MAX
  )
    throw badRequest(`limit must be an integer from 1 to ${LIMIT_MAX}`);
  return limit;
}

export async function POST(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    await requireBrain(ctx);
    if (!hasMinRole(ctx.role, 'admin')) throw new ForbiddenError();
    const limit = await readLimit(request);
    const r = await rebuildDirtyPages({
      store: brainPages(),
      summariser: new ExtractiveSummariser(),
      accountId: ctx.accountId,
      limit,
    });
    return NextResponse.json({
      rebuilt: r.rebuilt,
      failed: r.failed,
      remaining: r.remaining,
    });
  } catch (err) {
    return brainErrorResponse(err, 'pages-rebuild');
  }
}
