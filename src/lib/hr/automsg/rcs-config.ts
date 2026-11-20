/**
 * RCS provider settings for HR automated messages (package release 030b).
 *
 * Server-only, read at call time: changing a variable needs a restart, not
 * a rebuild. With none set (the default) RCS is "not connected": a message
 * whose trigger uses RCS is held `channel_not_connected` and never sent,
 * and never moved to WhatsApp or SMS.
 *
 * UNVERIFIED: no RCS provider has been chosen. The request and webhook
 * shapes in `rcs.ts` / `rcs-webhook.ts` are the package's neutral
 * placeholders and must be mapped to the chosen provider before any of
 * these variables is set.
 *
 *   RCS_BASE_URL, RCS_TOKEN, RCS_SENDER_ID      all three, or none
 *   RCS_WEBHOOK_SECRET (>= 16 characters),
 *   RCS_WORKSPACE_ID (the workspace's account id) both, or none
 *
 * A half-set group is treated as unset and logged once, naming the problem
 * and never a value.
 */

export interface RcsSendConfig {
  /** https base URL of the provider API. */
  baseUrl: string;
  token: string;
  senderId: string;
}

export interface RcsWebhookConfig {
  secret: string;
  /** The one workspace RCS receipts belong to (`accounts.id`). */
  accountId: string;
}

type Env = Record<string, string | undefined>;

export const RCS_WEBHOOK_SECRET_MIN = 16;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.error(`[rcs] ${message}`);
}

function read(env: Env, key: string): string | null {
  const v = env[key]?.trim();
  return v ? v : null;
}

/** The provider settings for sending, or null when RCS sending is off. */
export function rcsSendConfig(env: Env = process.env): RcsSendConfig | null {
  const baseUrl = read(env, 'RCS_BASE_URL');
  const token = read(env, 'RCS_TOKEN');
  const senderId = read(env, 'RCS_SENDER_ID');
  if (!baseUrl && !token && !senderId) return null;
  if (!baseUrl || !token || !senderId) {
    const missing = [
      !baseUrl && 'RCS_BASE_URL',
      !token && 'RCS_TOKEN',
      !senderId && 'RCS_SENDER_ID',
    ].filter(Boolean);
    warnOnce(`sending off: ${missing.join(', ')} not set (set all three)`);
    return null;
  }
  let protocol: string;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    warnOnce('sending off: RCS_BASE_URL is not a URL');
    return null;
  }
  if (protocol !== 'https:') {
    warnOnce('sending off: RCS_BASE_URL must be https');
    return null;
  }
  return { baseUrl, token, senderId };
}

/** The receipt webhook settings, or null when the webhook is off. */
export function rcsWebhookConfig(
  env: Env = process.env
): RcsWebhookConfig | null {
  const secret = read(env, 'RCS_WEBHOOK_SECRET');
  const accountId = read(env, 'RCS_WORKSPACE_ID');
  if (!secret && !accountId) return null;
  if (!secret || !accountId) {
    warnOnce(
      'webhook off: set RCS_WEBHOOK_SECRET and RCS_WORKSPACE_ID together'
    );
    return null;
  }
  if (secret.length < RCS_WEBHOOK_SECRET_MIN) {
    warnOnce(
      `webhook off: RCS_WEBHOOK_SECRET must be at least ${RCS_WEBHOOK_SECRET_MIN} characters`
    );
    return null;
  }
  if (!UUID.test(accountId)) {
    warnOnce('webhook off: RCS_WORKSPACE_ID must be the workspace id');
    return null;
  }
  return { secret, accountId };
}
