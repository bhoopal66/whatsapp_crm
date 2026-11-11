import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  disconnectOpenWANumber,
  loadOpenWARow,
} from '@/lib/whatsapp/openwa-number';
import { personalNumbersAdmin } from '@/lib/whatsapp/personal-numbers';

/**
 * DELETE /api/whatsapp/personal/[configId] — disconnect the caller's own
 * WhatsApp number (also the Cancel of a QR never scanned). Only a
 * personal number of the caller's active account that they own; any
 * other id answers 404. Same teardown and answer as the admin route
 * (`{ ok: true, gatewayCleanup }`). It does not need the permission
 * still to be granted: someone may always remove their own number.
 * Admins remove anyone's through `/api/whatsapp/config/openwa/[id]`.
 */
export async function DELETE(
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
  return disconnectOpenWANumber(db, ctx.accountId, row);
}
