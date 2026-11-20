import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { wantsFreshStatus } from '@/lib/whatsapp/openwa-connect';
import { loadOpenWARow, probeOpenWANumber } from '@/lib/whatsapp/openwa-number';

/**
 * GET /api/whatsapp/config/openwa/[configId]/status[?fresh=1] — what the
 * connect dialog polls (and, with `fresh`, its close-check). Admin+.
 *
 * Answers `{ status, qrCode?, phone? }` in OpenWA's own words; the probe
 * and its first-link / number-follow writes are `probeOpenWANumber`.
 */
export async function GET(
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

  const row = await loadOpenWARow(supabase, { accountId, configId });
  if (!row) {
    return NextResponse.json({ error: 'Number not found' }, { status: 404 });
  }
  return probeOpenWANumber(supabase, accountId, row, {
    fresh: wantsFreshStatus(request.url),
  });
}
