import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { smsSendConfig, smsWebhookConfig } from '@/lib/hr/automsg/sms-config';

/**
 * GET /api/hr/automsg/sms  (signed-in staff, viewer and up)
 *
 * Returns: { connected, webhook }
 *
 * Whether SMS sending (the Dinstar gateway) and the SMS receipt webhook
 * are configured on this server (release 032). Only the two flags leave
 * the server, never a value: no URL, username, password, port, secret or
 * workspace id.
 */
export async function GET() {
  try {
    await requireRole('viewer');
    return NextResponse.json({
      connected: smsSendConfig() !== null,
      webhook: smsWebhookConfig() !== null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
