import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { serverSupabaseUrl } from '@/lib/supabase/urls';

// Shared by the /api/pbx admin routes. Writes to the PBX tables (other
// than pbx_settings / pbx_bank_numbers) and every read of
// pbx_connection_secrets are service role only (migration 089), so the
// routes authorise in TypeScript first, then use this client.

let client: SupabaseClient | null = null;

export function pbxServiceDb(): SupabaseClient {
  client ??= createClient(
    serverSupabaseUrl(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  return client;
}

export interface OwnConnectionRow {
  id: string;
  account_id: string;
  label: string;
  edition: 'cloud' | 'software' | 'appliance';
  base_url: string;
  api_path: string;
  client_id_last4: string | null;
  firmware: string | null;
  status: string;
  last_event_at: string | null;
  /** Migration 104: the path of the latest event, and the latest backfill. */
  last_event_via: 'webhook' | 'gateway' | null;
  last_backfill_at: string | null;
  last_backfill: unknown;
  last_error: string | null;
  webhook_path_token: string;
  updated_at: string;
}

/** The PBX connection a workspace configured (the oldest, if several). */
export async function ownConnection(
  db: SupabaseClient,
  accountId: string
): Promise<OwnConnectionRow | null> {
  const { data, error } = await db
    .from('pbx_connections')
    .select(
      'id, account_id, label, edition, base_url, api_path, client_id_last4, firmware, status, last_event_at, last_event_via, last_backfill_at, last_backfill, last_error, webhook_path_token, updated_at'
    )
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw new Error(`pbx_connections read failed: ${error.message}`);
  return ((data as OwnConnectionRow[] | null) ?? [])[0] ?? null;
}

/** The callback URL to paste into Yeastar's webhook settings. */
export function pbxWebhookUrl(token: string, requestUrl: string): string {
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '') ||
    new URL(requestUrl).origin;
  return `${origin}/api/pbx/yeastar/events/${token}`;
}
