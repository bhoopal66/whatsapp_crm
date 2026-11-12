// ============================================================
// GET /api/brain/digest — the caller's daily brain digest (022d-2): stale
// cases, unkept promises, related closed cases, follow-ups, built by
// buildDigest over SupabaseDigestSource with the server clock.
// Every caller with sales access reads their own. `?userId=<uuid>` naming
// someone else is admin and up only (else 403 `{ error: 'Not allowed' }`),
// and the teammate must be a live, non-guest member of the caller's ACTIVE
// account (checked through the caller's RLS client; else 404
// `{ error: 'Not found' }`, the same body for an unknown id). The digest is
// then built WITH THE TEAMMATE AS THE ACTOR, so it holds exactly what they
// can read, never what only the admin can. A malformed userId is 400 for an admin (a non-admin
// naming anyone else is 403 first); an empty one is 400 for everyone.
// `Cache-Control: no-store`.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { badRequest, isUuid } from '@/lib/cases/http';
import { buildDigest } from '@/lib/brain/digest';
import { SupabaseDigestSource } from '@/lib/brain/digest-store';
import {
  BrainHttpError,
  brainErrorResponse,
  requireBrain,
} from '@/lib/brain/server';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export async function GET(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    await requireBrain(ctx);
    const named = new URL(request.url).searchParams.get('userId');
    let actorId = ctx.userId;
    if (named !== null) {
      if (named === '') throw badRequest('userId must be a uuid');
      if (named !== ctx.userId) {
        // Role first: a non-admin learns nothing from how a value is judged.
        if (!hasMinRole(ctx.role, 'admin'))
          throw new BrainHttpError(403, 'Not allowed');
        if (!isUuid(named)) throw badRequest('userId must be a uuid');
        const { data, error } = await ctx.supabase
          .from('profiles')
          .select('user_id')
          .eq('user_id', named)
          .eq('account_id', ctx.accountId)
          .is('deactivated_at', null)
          .neq('role', 'bank_guest')
          .maybeSingle();
        if (error) throw new Error('member read failed');
        if (!data) throw new BrainHttpError(404, 'Not found');
        actorId = named;
      }
    }
    const digest = await buildDigest({
      actorId,
      accountId: ctx.accountId,
      now: new Date(),
      source: new SupabaseDigestSource(supabaseAdmin()),
    });
    return NextResponse.json(digest, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return brainErrorResponse(err, 'digest');
  }
}
