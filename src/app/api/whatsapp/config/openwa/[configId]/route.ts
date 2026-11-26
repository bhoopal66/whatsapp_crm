import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  disconnectOpenWANumber,
  loadOpenWARow,
} from '@/lib/whatsapp/openwa-number';
import { wantsForce } from '@/lib/whatsapp/waiting-messages';

/**
 * DELETE /api/whatsapp/config/openwa/[configId] — disconnect an OpenWA
 * number (also the Cancel of a QR that was never scanned). Admin+, and
 * any number of the account, a person's own one included.
 *
 * Gateway teardown, row delete and default promotion are
 * `disconnectOpenWANumber`. Answers `{ ok: true, gatewayCleanup }`:
 * 'incomplete' when the session may still be running on the gateway and
 * only the admin can finish the job in the OpenWA dashboard.
 */
export async function DELETE(
  request: Request,
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

  let row;
  try {
    row = await loadOpenWARow(supabase, { accountId, configId });
  } catch (err) {
    console.error('Error loading OpenWA number:', err);
    return NextResponse.json(
      { error: 'Failed to read the number' },
      { status: 500 }
    );
  }
  if (!row) return NextResponse.json({ ok: true, gatewayCleanup: 'complete' });

  return disconnectOpenWANumber(supabase, accountId, row, {
    force: wantsForce(request),
  });
}
