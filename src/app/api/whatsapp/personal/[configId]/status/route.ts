import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { wantsFreshStatus } from '@/lib/whatsapp/openwa-connect';
import { loadOpenWARow, probeOpenWANumber } from '@/lib/whatsapp/openwa-number';
import { personalNumbersAdmin } from '@/lib/whatsapp/personal-numbers';

/**
 * GET /api/whatsapp/personal/[configId]/status[?fresh=1] — what the
 * caller's own connect dialog polls (and, with `fresh`, its close-check):
 * `{ status, qrCode?, phone? }`, as the admin status route. Only the
 * caller's own personal number in their active account; any other id
 * answers 404.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ configId: string }> }
) {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }
  const { configId } = await context.params;

  const db = personalNumbersAdmin();
  let row;
  try {
    row = await loadOpenWARow(db, {
      accountId: ctx.accountId,
      configId,
      ownerId: ctx.userId,
    });
  } catch (err) {
    console.error('Error loading OpenWA number:', err);
    return NextResponse.json(
      { error: 'Failed to read the number' },
      { status: 500 }
    );
  }
  if (!row) {
    return NextResponse.json({ error: 'Number not found' }, { status: 404 });
  }
  return probeOpenWANumber(db, ctx.accountId, row, {
    fresh: wantsFreshStatus(request.url),
  });
}
