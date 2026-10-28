import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import { OpenWAError, getQr, getSession } from '@/lib/whatsapp/openwa-api';

/**
 * GET /api/whatsapp/config/openwa/[configId]/status — what the connect
 * dialog polls. Admin+.
 *
 * Answers `{ status, qrCode?, phone? }` in OpenWA's own words. Uses the
 * row's scoped key, never the admin key, so a row can only ever ask
 * about its own session.
 *
 * On `ready` it writes `connected`, the number and `connected_at` for
 * the FIRST link only (`connected_at IS NULL`). After that the row's
 * status belongs to the health sweep alone: the Settings list calls this
 * route to show live state, and a write here would flip a number that
 * went down back to 'connected' silently, so the sweep would never see
 * the transition and owners would never get the "connected again" alert.
 * The answer still carries the live state either way.
 */
export async function GET(
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
    .select('id, phone_number_id, access_token, waba_id, status, connected_at')
    .eq('account_id', accountId)
    .eq('provider', 'openwa')
    .eq('id', configId)
    .maybeSingle();
  if (!row) {
    return NextResponse.json({ error: 'Number not found' }, { status: 404 });
  }

  let creds: { apiKey: string; sessionId: string };
  try {
    creds = {
      apiKey: decrypt(row.access_token as string),
      sessionId: row.phone_number_id as string,
    };
  } catch {
    return NextResponse.json(
      {
        error:
          'The stored OpenWA key cannot be read. Disconnect and reconnect.',
      },
      { status: 500 }
    );
  }

  try {
    const session = await getSession(creds);
    if (session.status === 'qr_ready') {
      // The QR can rotate between the two calls; a missing one just
      // waits for the next poll.
      const qr = await getQr(creds).catch(() => null);
      return NextResponse.json({
        status: session.status,
        ...(qr?.qrCode ? { qrCode: qr.qrCode } : {}),
      });
    }
    if (session.status === 'ready') {
      if (row.connected_at == null) {
        const { error } = await supabase
          .from('whatsapp_config')
          .update({
            status: 'connected',
            waba_id: session.phone ?? row.waba_id,
            connected_at: new Date().toISOString(),
          })
          .eq('account_id', accountId)
          .eq('id', row.id)
          // The sweep may have stamped the first link a moment ago.
          .is('connected_at', null);
        if (error) console.error('[openwa status] update failed:', error);
      }
      return NextResponse.json({
        status: session.status,
        ...(session.phone ? { phone: session.phone } : {}),
      });
    }
    return NextResponse.json({ status: session.status });
  } catch (err) {
    console.error('[openwa status] probe failed:', err);
    const status = err instanceof OpenWAError ? 502 : 500;
    return NextResponse.json(
      { error: 'The OpenWA gateway did not answer. Try again shortly.' },
      { status }
    );
  }
}
