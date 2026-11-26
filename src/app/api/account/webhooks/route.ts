// ============================================================
// GET /api/account/webhooks — the account's webhook endpoints, for
// Settings → API keys (admin+, like the key list).
//
// Endpoints are made and changed through /api/v1/webhooks; this list
// is where an owner or admin sees what receives the workspace's data.
// Host only, never the full URL and never `secret`.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  ACCOUNT_WEBHOOK_COLUMNS,
  toAccountWebhook,
  type WebhookKeyRow,
  type WebhookRow,
} from '@/lib/webhooks/account-list';

function loadFailed(what: string, error: unknown) {
  console.error(`[GET /api/account/webhooks] ${what} error:`, error);
  return NextResponse.json(
    { error: 'Failed to load webhooks' },
    { status: 500 }
  );
}

export async function GET() {
  try {
    const ctx = await requireRole('admin');

    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .select(ACCOUNT_WEBHOOK_COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false });
    if (error || !data) return loadFailed('fetch', error);

    const rows = data as WebhookRow[];
    const keyIds = [...new Set(rows.flatMap((r) => r.api_key_id ?? []))];
    let keys: WebhookKeyRow[] = [];
    if (keyIds.length > 0) {
      const { data: found, error: keysError } = await ctx.supabase
        .from('api_keys')
        .select('id, name, revoked_at, expires_at')
        .eq('account_id', ctx.accountId)
        .in('id', keyIds);
      if (keysError || !found) return loadFailed('keys', keysError);
      keys = found as WebhookKeyRow[];
    }

    return NextResponse.json({
      webhooks: rows.map((row) => toAccountWebhook(row, keys)),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
