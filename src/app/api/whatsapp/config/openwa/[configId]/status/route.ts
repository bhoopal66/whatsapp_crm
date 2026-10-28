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
 * about its own session. On `ready` the number and `connected` are
 * written once; later polls see the row already connected and skip it.
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
    .select('id, phone_number_id, access_token, waba_id, status')
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
      if (row.status !== 'connected' || row.waba_id !== session.phone) {
        const { error } = await supabase
          .from('whatsapp_config')
          .update({
            status: 'connected',
            waba_id: session.phone ?? row.waba_id,
            connected_at: new Date().toISOString(),
          })
          .eq('account_id', accountId)
          .eq('id', row.id);
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
