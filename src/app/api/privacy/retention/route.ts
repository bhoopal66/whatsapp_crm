// /api/privacy/retention — the workspace's retention policy (migration
// 223). Owners and admins only.
//   GET -> `{ policy, apply, updatedAt, lastRun, rules }` (rules = the
//   allow-list; lastRun = the newest sweep's outcome, 282)
//   PUT `{ policy: { tables: { <key>: { days, action } } }, apply,
//          expectedUpdatedAt }` (the GET's `updatedAt`): 409 STALE when
//          somebody saved since, or when none was sent over a saved policy.
// The automations cron sweeps once a day; a dry run unless `apply`.
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import {
  noStore,
  PrivacyBadRequest,
  privacyErrorResponse,
  readBody,
} from '@/lib/privacy/http';
import { RETENTION_RULES, retentionProblem } from '@/lib/privacy/retention';
import { PrivacyStore } from '@/lib/privacy/store';
import { isStaleSave, staleSaveResponse } from '@/lib/settings/stale';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const out = await new PrivacyStore(supabaseAdmin()).retention(
      ctx.userId,
      ctx.accountId
    );
    return noStore(NextResponse.json({ ...out, rules: RETENTION_RULES }));
  } catch (err) {
    return privacyErrorResponse(err, 'retention get');
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = await readBody(request);
    const problem = retentionProblem(body.policy);
    if (problem) throw new PrivacyBadRequest(problem);
    if (typeof body.apply !== 'boolean')
      throw new PrivacyBadRequest('apply must be true or false');
    const store = new PrivacyStore(supabaseAdmin());
    const current = await store.retention(ctx.userId, ctx.accountId);
    // The save replaces policy and apply together, and apply deletes
    // customer data: a form that does not say which version it was loaded
    // from is stale too.
    if (isStaleSave(body.expectedUpdatedAt ?? null, current.updatedAt))
      return noStore(staleSaveResponse());
    const out = await store.retention(ctx.userId, ctx.accountId, {
      policy: body.policy,
      apply: body.apply,
    });
    return noStore(NextResponse.json({ ...out, rules: RETENTION_RULES }));
  } catch (err) {
    return privacyErrorResponse(err, 'retention set');
  }
}
