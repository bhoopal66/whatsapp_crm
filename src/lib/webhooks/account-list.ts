// ============================================================
// The webhook endpoints as Settings → API keys shows them (315).
// Only the host leaves the server: the path, the query or the user
// info of a URL may hold the receiver's token.
// ============================================================

import { apiKeyStatus, type ApiKeyStatus } from '@/lib/api-keys/status';

/** What the list reads. Never `secret`. */
export const ACCOUNT_WEBHOOK_COLUMNS =
  'id, url, events, is_active, last_delivery_at, failure_count, first_failure_at, created_at, api_key_id';

export interface WebhookRow {
  id: string;
  url: string;
  events: string[] | null;
  is_active: boolean;
  last_delivery_at: string | null;
  failure_count: number;
  first_failure_at: string | null;
  created_at: string;
  api_key_id: string | null;
}

export interface WebhookKeyRow {
  id: string;
  name: string;
  revoked_at: string | null;
  expires_at: string | null;
}

export interface AccountWebhook {
  id: string;
  /** null = the stored URL could not be read. */
  host: string | null;
  events: string[];
  is_active: boolean;
  /** The last delivery the receiver accepted. */
  last_delivery_at: string | null;
  failure_count: number;
  /** When the present run of failures began. */
  first_failure_at: string | null;
  created_at: string;
  /** null = made before 315, or the key was deleted. */
  key: { id: string; name: string; status: ApiKeyStatus } | null;
}

function urlHost(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export function toAccountWebhook(
  row: WebhookRow,
  keys: WebhookKeyRow[]
): AccountWebhook {
  const key = keys.find((k) => k.id === row.api_key_id);
  return {
    id: row.id,
    host: urlHost(row.url),
    events: row.events ?? [],
    is_active: row.is_active,
    last_delivery_at: row.last_delivery_at,
    failure_count: row.failure_count,
    first_failure_at: row.first_failure_at,
    created_at: row.created_at,
    key: key ? { id: key.id, name: key.name, status: apiKeyStatus(key) } : null,
  };
}
