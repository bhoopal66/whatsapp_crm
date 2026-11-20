import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { rcsSendConfig, rcsWebhookConfig } from '@/lib/hr/automsg/rcs-config';

/**
 * GET /api/hr/automsg/rcs  (signed-in staff, viewer and up)
 *
 * Returns: { connected, webhook }
 *
 * Whether RCS sending and the RCS receipt webhook are configured on this
 * server (release 030b). Only the two flags leave the server, never a
 * value: no URL, token, sender id, secret or workspace id.
 */
export async function GET() {
  try {
    await requireRole('viewer');
    return NextResponse.json({
      connected: rcsSendConfig() !== null,
      webhook: rcsWebhookConfig() !== null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
