import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { loadOpenWARow, probeOpenWANumber } from '@/lib/whatsapp/openwa-number';
import { personalNumbersAdmin } from '@/lib/whatsapp/personal-numbers';

/**
 * GET /api/whatsapp/personal/[configId]/status — what the caller's own
 * connect dialog polls: `{ status, qrCode?, phone? }`, as the admin
 * status route. Only the caller's own personal number in their active
 * account; any other id answers 404.
 */
export async function GET(
  _request: Request,
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
  const row = await loadOpenWARow(db, {
    accountId: ctx.accountId,
    configId,
    ownerId: ctx.userId,
  });
  if (!row) {
    return NextResponse.json({ error: 'Number not found' }, { status: 404 });
  }
  return probeOpenWANumber(db, ctx.accountId, row);
}
