import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  toErrorResponse,
  type AccountContext,
} from '@/lib/auth/account';
import { isBankGuest } from '@/lib/auth/roles';
import { openwaAdminApiKey } from '@/lib/whatsapp/openwa-api';
import { connectOpenWANumber } from '@/lib/whatsapp/openwa-number';
import { personalNumbersAdmin } from '@/lib/whatsapp/personal-numbers';

/**
 * /api/whatsapp/personal — the caller's own WhatsApp number in their
 * active workspace (migration 190), linked through OpenWA.
 *
 *   GET  — `{ allowed, configured, number }`: whether an admin has let
 *          them connect one, whether this server has OpenWA at all
 *          (OPENWA_API_KEY), and their number or null.
 *   POST — connect it (`{ label? }` → `{ configId }`); the QR then comes
 *          from `[configId]/status`, exactly as on the admin path.
 *
 * Bank guests get 403. Every read and write of `whatsapp_config` here
 * is on the service role (its RLS writes are admin-only), and only for
 * the caller's own personal row in their active account; the permission
 * itself is read from the caller's own profile through RLS.
 */
export async function GET() {
  let ctx: AccountContext;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }
  if (isBankGuest(ctx.role)) {
    return NextResponse.json({ error: 'not_allowed' }, { status: 403 });
  }

  const allowed = await mayConnect(ctx);
  const { data: number, error } = await personalNumbersAdmin()
    .from('whatsapp_config')
    .select('id, label, status, waba_id, connected_at, created_at')
    .eq('account_id', ctx.accountId)
    .eq('user_id', ctx.userId)
    .eq('is_personal', true)
    .maybeSingle();
  if (error) {
    console.error('[whatsapp/personal] load failed:', error);
    return NextResponse.json(
      { error: 'Failed to load your WhatsApp number' },
      { status: 500 }
    );
  }

  return NextResponse.json({
    allowed,
    configured: Boolean(openwaAdminApiKey()),
    number: number
      ? {
          id: number.id as string,
          label: (number.label as string | null) ?? null,
          status: (number.status as string | null) ?? null,
          phone: (number.waba_id as string | null) ?? null,
          connected_at: (number.connected_at as string | null) ?? null,
          created_at: (number.created_at as string | null) ?? null,
        }
      : null,
  });
}

export async function POST(request: Request) {
  let ctx: AccountContext;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }
  if (isBankGuest(ctx.role) || !(await mayConnect(ctx))) {
    return NextResponse.json({ error: 'not_allowed' }, { status: 403 });
  }

  const db = personalNumbersAdmin();
  const { data: existing, error: existingError } = await db
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', ctx.accountId)
    .eq('user_id', ctx.userId)
    .eq('is_personal', true)
    .maybeSingle();
  if (existingError) {
    console.error('[whatsapp/personal] lookup failed:', existingError);
    return NextResponse.json(
      { error: 'Failed to load your WhatsApp number' },
      { status: 500 }
    );
  }
  if (existing) {
    return NextResponse.json({ error: 'already_connected' }, { status: 409 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    label?: unknown;
  };
  const label =
    typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '';

  return connectOpenWANumber({
    db,
    accountId: ctx.accountId,
    userId: ctx.userId,
    label,
    personal: true,
  });
}

/**
 * The admin's permission, from the caller's own profile row in the
 * active workspace (RLS lets everyone read their own). `*` so a
 * database without 190 answers "not allowed" instead of failing.
 */
async function mayConnect(ctx: AccountContext): Promise<boolean> {
  const { data, error } = await ctx.supabase
    .from('profiles')
    .select('*')
    .eq('user_id', ctx.userId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) {
    console.error('[whatsapp/personal] profile read failed:', error);
    return false;
  }
  return (
    (data as { may_connect_personal_whatsapp?: boolean | null } | null)
      ?.may_connect_personal_whatsapp === true
  );
}
