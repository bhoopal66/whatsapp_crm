// /api/privacy/retention — the workspace's retention policy (migration
// 223). Owners and admins only.
//   GET -> `{ policy, apply, updatedAt, rules }` (rules = the allow-list)
//   PUT `{ policy: { tables: { <key>: { days, action } } }, apply }`
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
    const out = await new PrivacyStore(supabaseAdmin()).retention(
      ctx.userId,
      ctx.accountId,
      {
        policy: body.policy,
        apply: body.apply,
      }
    );
    return noStore(NextResponse.json({ ...out, rules: RETENTION_RULES }));
  } catch (err) {
    return privacyErrorResponse(err, 'retention set');
  }
}
