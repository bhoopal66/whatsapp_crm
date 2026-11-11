// ============================================================
// Personal WhatsApp numbers (migration 190): a staff member's own
// WhatsApp, linked through OpenWA by a QR scan, once an admin has
// allowed it (`profiles.may_connect_personal_whatsapp`).
//
// A personal number is a `whatsapp_config` row with `is_personal`, owned
// by `user_id`. It is never the account's default, never a routing
// target and never allocated to anyone else; triggers refuse each of
// those with HINT 'PERSONAL_NUMBER'. So every "promote the oldest number
// to default" path skips personal rows, and the routing and allocation
// routes turn that refusal into a 409 the admin can read.
// ============================================================

import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { serverSupabaseUrl } from '@/lib/supabase/urls';

/** The HINT migration 190's triggers raise for a misuse of one. */
export const PERSONAL_NUMBER_HINT = 'PERSONAL_NUMBER';

/** The HINT `set_member_personal_whatsapp` raises on a revoke that a
 *  connected personal number blocks. */
export const PERSONAL_NUMBER_EXISTS_HINT = 'PERSONAL_NUMBER_EXISTS';

/**
 * A 409 for a write migration 190 refused because it named a personal
 * number, else null (the caller keeps its own handling).
 */
export function personalNumberRefusal(
  error: { hint?: string | null } | null | undefined
): NextResponse | null {
  if (error?.hint !== PERSONAL_NUMBER_HINT) return null;
  return NextResponse.json(
    {
      error:
        'A personal WhatsApp number belongs to one person: it cannot be the default number, a route or shared with others.',
    },
    { status: 409 }
  );
}

/**
 * Never leave the account's numbers without a deliberate default: when
 * none is primary (the one just removed was), promote the oldest
 * remaining shared number. Personal numbers are skipped, since migration
 * 190 refuses one as the default.
 */
export async function promoteOldestToPrimary(
  db: SupabaseClient,
  accountId: string
): Promise<void> {
  const { data: rows } = await db
    .from('whatsapp_config')
    .select('id, is_primary, created_at')
    .eq('account_id', accountId)
    .eq('is_personal', false)
    .order('created_at', { ascending: true });
  if (!rows || rows.length === 0 || rows.some((r) => r.is_primary)) return;
  await db
    .from('whatsapp_config')
    .update({ is_primary: true })
    .eq('id', rows[0].id)
    .eq('account_id', accountId);
}

let _admin: SupabaseClient | null = null;

/**
 * Service-role client for the self-service routes. `whatsapp_config`
 * writes are admin-only under RLS (017), so a staff member's own
 * connect, status and disconnect go through this, and only after the
 * route has checked the permission and the row's owner itself.
 */
export function personalNumbersAdmin(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(
      serverSupabaseUrl(),
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
  }
  return _admin;
}
