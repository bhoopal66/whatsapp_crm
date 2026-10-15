// ============================================================
// GET /api/push/config — the VAPID public key a browser subscribes
// with, or null when push is not configured on this install.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { pushConfig } from '@/lib/push/config';

export async function GET() {
  try {
    await getCurrentAccount();
    return NextResponse.json({ publicKey: pushConfig()?.publicKey ?? null });
  } catch (err) {
    return toErrorResponse(err);
  }
}
