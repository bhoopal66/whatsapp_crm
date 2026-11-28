import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { canEnforceSendProtection } from '@/lib/auth/roles';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import {
  INT4_MAX,
  RECENT_DECISIONS,
  isCapValue,
  parseDecisions,
  readMicros,
} from '@/lib/whatsapp/meta-health/protection';

/**
 * /api/whatsapp/meta/protection  (admin+)
 *
 * Number protection: 188's `enforce` switch and daily marketing count
 * cap, 334's daily marketing and AI spend caps (micros, NULL = no cap),
 * and the last 50 rows of the send guard's decision log.
 *
 * GET reads on the caller's RLS client (188's and 334's policies:
 * owners and admins of the account). PATCH calls the setters, which are
 * granted to the service role only and check the actor themselves
 * (`p_actor` = auth user id): enforce is owner-only, the caps owner or
 * admin. The owner check is repeated here so an admin gets a clean 403
 * without a round trip.
 */
export async function GET() {
  try {
    const { supabase, accountId, role } = await requireRole('admin');

    const [settingsRes, capsRes, decisionsRes] = await Promise.all([
      supabase
        .from('meta_protection_settings')
        .select('enforce, daily_marketing_cap')
        .eq('account_id', accountId)
        .maybeSingle(),
      supabase
        .from('send_protection_caps')
        .select('daily_marketing_spend_micros, daily_ai_spend_micros')
        .eq('account_id', accountId)
        .maybeSingle(),
      supabase
        .from('send_protection_decisions')
        .select('id, at, decision, reason, template, enforced')
        .eq('account_id', accountId)
        .order('at', { ascending: false })
        .limit(RECENT_DECISIONS),
    ]);

    const failed = [settingsRes, capsRes, decisionsRes].find((r) => r.error);
    if (failed?.error) {
      console.error('[meta/protection GET] read:', failed.error.message);
      return NextResponse.json(
        { error: 'Failed to load number protection' },
        { status: 500 }
      );
    }

    const settings = settingsRes.data as {
      enforce?: unknown;
      daily_marketing_cap?: unknown;
    } | null;
    const caps = capsRes.data as Record<string, unknown> | null;

    return NextResponse.json({
      enforce: settings?.enforce === true,
      can_set_enforce: canEnforceSendProtection(role),
      daily_marketing_cap:
        typeof settings?.daily_marketing_cap === 'number'
          ? settings.daily_marketing_cap
          : null,
      marketing_spend_micros: readMicros(caps?.daily_marketing_spend_micros),
      ai_spend_micros: readMicros(caps?.daily_ai_spend_micros),
      decisions: parseDecisions(decisionsRes.data),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

type RpcError = { message?: string; hint?: string } | null;

function rpcFailure(where: string, error: RpcError) {
  if (error?.hint === 'NOT_ALLOWED') {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 });
  }
  if (error?.hint === 'SETTING_INVALID') {
    return NextResponse.json({ error: 'Invalid setting' }, { status: 400 });
  }
  console.error(`[meta/protection PATCH] ${where}:`, error?.message);
  return NextResponse.json(
    { error: 'Failed to save number protection' },
    { status: 500 }
  );
}

/**
 * PATCH body, either part optional:
 *   { enforce?: boolean,
 *     limits?: { daily_marketing_cap, marketing_spend_micros,
 *                ai_spend_micros } }   each a whole number ≥ 0 or null
 * The two spend caps are one setter (334), so `limits` carries all three.
 */
export async function PATCH(request: Request) {
  try {
    const { accountId, userId, role } = await requireRole('admin');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }
    const { enforce, limits } = body as {
      enforce?: unknown;
      limits?: Record<string, unknown> | null;
    };
    if (enforce !== undefined && typeof enforce !== 'boolean') {
      return NextResponse.json({ error: 'Invalid enforce' }, { status: 400 });
    }
    if (limits !== undefined) {
      if (
        !limits ||
        typeof limits !== 'object' ||
        !isCapValue(limits.daily_marketing_cap, INT4_MAX) ||
        !isCapValue(limits.marketing_spend_micros) ||
        !isCapValue(limits.ai_spend_micros)
      ) {
        return NextResponse.json({ error: 'Invalid limits' }, { status: 400 });
      }
    }
    if (enforce === undefined && limits === undefined) {
      return NextResponse.json({ error: 'Nothing to save' }, { status: 400 });
    }
    if (enforce !== undefined && !canEnforceSendProtection(role)) {
      return NextResponse.json(
        { error: 'Only the owner can switch enforcement' },
        { status: 403 }
      );
    }

    const admin = supabaseAdmin();
    if (enforce !== undefined) {
      const { error } = await admin.rpc('meta_protection_set_enforce', {
        p_actor: userId,
        p_account: accountId,
        p_on: enforce,
      });
      if (error) return rpcFailure('enforce', error);
    }
    if (limits) {
      const { error: capError } = await admin.rpc(
        'meta_protection_set_marketing_cap',
        {
          p_actor: userId,
          p_account: accountId,
          p_cap: limits.daily_marketing_cap,
        }
      );
      if (capError) return rpcFailure('marketing cap', capError);
      const { error: spendError } = await admin.rpc(
        'send_protection_set_caps',
        {
          p_actor: userId,
          p_account: accountId,
          p_marketing_micros: limits.marketing_spend_micros,
          p_ai_micros: limits.ai_spend_micros,
        }
      );
      if (spendError) return rpcFailure('spend caps', spendError);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
