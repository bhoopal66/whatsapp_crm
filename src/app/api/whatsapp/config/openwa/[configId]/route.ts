import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { openwaAdminApiKey } from '@/lib/whatsapp/openwa-api';
import { teardownOpenWASession } from '@/lib/whatsapp/openwa-cleanup';

/**
 * DELETE /api/whatsapp/config/openwa/[configId] — disconnect an OpenWA
 * number (also the Cancel of a QR that was never scanned). Admin+.
 *
 * The gateway side is best effort, each step logged: unlink the phone,
 * delete the session, revoke its scoped key. Then the row goes the way
 * the Whapi DELETE removes a number: its routes and allocations cascade,
 * its chat history stays (`channel_id` goes NULL), and if it was the
 * primary the oldest remaining number is promoted.
 *
 * Without OPENWA_API_KEY the row is still removed, so an install that
 * dropped OpenWA can clean up; the gateway side is then left alone.
 *
 * Answers `{ ok: true, gatewayCleanup }`. The row goes either way, but
 * when the gateway could not be reached (or there is no admin key) the
 * session may still be running a browser with a working key, and only
 * the admin can finish the job in the OpenWA dashboard: 'incomplete'
 * is how the Settings list knows to tell them.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ configId: string }> }
) {
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }
  const { supabase, accountId } = ctx;
  const { configId } = await context.params;

  const { data: row } = await supabase
    .from('whatsapp_config')
    .select('id, phone_number_id')
    .eq('account_id', accountId)
    .eq('provider', 'openwa')
    .eq('id', configId)
    .maybeSingle();
  if (!row) return NextResponse.json({ ok: true, gatewayCleanup: 'complete' });

  const sessionId = row.phone_number_id as string;
  const adminKey = openwaAdminApiKey();
  const gatewayCleanup =
    adminKey && sessionId
      ? (await teardownOpenWASession({
          adminKey,
          sessionId,
          logPrefix: '[openwa disconnect]',
        }))
        ? 'complete'
        : 'incomplete'
      : 'incomplete';

  const { error: deleteError } = await supabase
    .from('whatsapp_config')
    .delete()
    .eq('account_id', accountId)
    .eq('id', row.id);
  if (deleteError) {
    console.error('[openwa disconnect] delete row failed:', deleteError);
    return NextResponse.json(
      { error: 'Failed to delete configuration' },
      { status: 500 }
    );
  }

  // Same as the Whapi DELETE's ensurePrimary: never leave channels
  // without a deliberate fallback.
  const { data: rest } = await supabase
    .from('whatsapp_config')
    .select('id, is_primary, created_at')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true });
  if (rest && rest.length > 0 && !rest.some((r) => r.is_primary)) {
    await supabase
      .from('whatsapp_config')
      .update({ is_primary: true })
      .eq('id', rest[0].id)
      .eq('account_id', accountId);
  }

  return NextResponse.json({ ok: true, gatewayCleanup });
}
