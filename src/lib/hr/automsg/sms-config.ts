/**
 * SMS gateway settings for HR automated messages (package release 032):
 * a Dinstar GSM gateway (SIM ports) and its delivery push.
 *
 * Server-only, read at call time: changing a variable needs a restart, not
 * a rebuild. With none set (the default) SMS is "not connected": a message
 * whose trigger uses SMS is held `channel_not_connected` and never sent,
 * and never moved to WhatsApp or RCS.
 *
 * UNVERIFIED: written from Dinstar's 'GSM Gateway HTTP API v202011'
 * document (firmware >= 1102, "new version API" enabled), not tested
 * against a live gateway. Confirm the formats in `dinstar.ts` and
 * `sms-webhook.ts` on the real gateway before setting any of these.
 *
 *   DINSTAR_BASE_URL (https), DINSTAR_USERNAME,
 *   DINSTAR_PASSWORD                        all three, or none
 *   DINSTAR_PORTS            optional, SIM ports 0-31, comma separated
 *   DINSTAR_TLS_FINGERPRINT  optional, SHA-256 of the gateway certificate
 *                            (64 hex, colons allowed)
 *   DINSTAR_MAX_PER_MINUTE   optional, 1-120 (default 10)
 *
 *   SMS_WEBHOOK_SECRET (>= 16 characters),
 *   SMS_WORKSPACE_ID (the workspace's account id)     both, or none
 *   SMS_ALLOW_QUERY_TOKEN=1  optional: accept ?token= when the header is absent
 *   SMS_WEBHOOK_ALLOW_IPS    optional: exact source IPs, comma separated
 *
 * A half-set or invalid group is treated as unset and logged once, naming
 * the problem and never a value.
 */

export interface SmsSendConfig {
  /** https base URL of the gateway; the API is {baseUrl}/api/send_sms. */
  baseUrl: string;
  username: string;
  password: string;
  /** SIM ports to send from; absent = the gateway chooses. */
  ports?: number[];
  /** Lower-case hex SHA-256 of the gateway certificate, no colons. */
  tlsFingerprint?: string;
  maxPerMinute: number;
}

export interface SmsWebhookConfig {
  secret: string;
  /** The one workspace SMS reports belong to (`accounts.id`). */
  accountId: string;
  allowQueryToken: boolean;
  /** Exact source IPs; empty = no IP check. */
  allowIps: string[];
}

type Env = Record<string, string | undefined>;

export const SMS_WEBHOOK_SECRET_MIN = 16;
export const DEFAULT_DINSTAR_MAX_PER_MINUTE = 10;
export const MAX_DINSTAR_MAX_PER_MINUTE = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.error(`[sms] ${message}`);
}

function read(env: Env, key: string): string | null {
  const v = env[key]?.trim();
  return v ? v : null;
}

function list(v: string | null): string[] {
  return v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/** The gateway settings for sending, or null when SMS sending is off. */
export function smsSendConfig(env: Env = process.env): SmsSendConfig | null {
  const baseUrl = read(env, 'DINSTAR_BASE_URL');
  const username = read(env, 'DINSTAR_USERNAME');
  const password = read(env, 'DINSTAR_PASSWORD');
  if (!baseUrl && !username && !password) return null;
  if (!baseUrl || !username || !password) {
    const missing = [
      !baseUrl && 'DINSTAR_BASE_URL',
      !username && 'DINSTAR_USERNAME',
      !password && 'DINSTAR_PASSWORD',
    ].filter(Boolean);
    warnOnce(`sending off: ${missing.join(', ')} not set (set all three)`);
    return null;
  }
  let protocol: string;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    warnOnce('sending off: DINSTAR_BASE_URL is not a URL');
    return null;
  }
  if (protocol !== 'https:') {
    warnOnce('sending off: DINSTAR_BASE_URL must be https');
    return null;
  }

  const portText = list(read(env, 'DINSTAR_PORTS'));
  const ports = portText.map((p) => (/^\d{1,2}$/.test(p) ? Number(p) : -1));
  if (ports.some((p) => p < 0 || p > 31)) {
    warnOnce('sending off: DINSTAR_PORTS must be numbers from 0 to 31');
    return null;
  }

  const fpText = read(env, 'DINSTAR_TLS_FINGERPRINT');
  const fp = fpText?.replace(/:/g, '').toLowerCase() ?? null;
  if (fp !== null && !/^[0-9a-f]{64}$/.test(fp)) {
    warnOnce('sending off: DINSTAR_TLS_FINGERPRINT must be a SHA-256 (64 hex)');
    return null;
  }

  const rateText = read(env, 'DINSTAR_MAX_PER_MINUTE');
  const rate =
    rateText === null ? DEFAULT_DINSTAR_MAX_PER_MINUTE : Number(rateText);
  if (
    !Number.isInteger(rate) ||
    rate < 1 ||
    rate > MAX_DINSTAR_MAX_PER_MINUTE
  ) {
    warnOnce(
      `sending off: DINSTAR_MAX_PER_MINUTE must be 1 to ${MAX_DINSTAR_MAX_PER_MINUTE}`
    );
    return null;
  }

  return {
    baseUrl,
    username,
    password,
    ...(ports.length > 0 ? { ports: [...new Set(ports)] } : {}),
    ...(fp !== null ? { tlsFingerprint: fp } : {}),
    maxPerMinute: rate,
  };
}

/** The delivery push settings, or null when the webhook is off. */
export function smsWebhookConfig(
  env: Env = process.env
): SmsWebhookConfig | null {
  const secret = read(env, 'SMS_WEBHOOK_SECRET');
  const accountId = read(env, 'SMS_WORKSPACE_ID');
  if (!secret && !accountId) return null;
  if (!secret || !accountId) {
    warnOnce(
      'webhook off: set SMS_WEBHOOK_SECRET and SMS_WORKSPACE_ID together'
    );
    return null;
  }
  if (secret.length < SMS_WEBHOOK_SECRET_MIN) {
    warnOnce(
      `webhook off: SMS_WEBHOOK_SECRET must be at least ${SMS_WEBHOOK_SECRET_MIN} characters`
    );
    return null;
  }
  if (!UUID.test(accountId)) {
    warnOnce('webhook off: SMS_WORKSPACE_ID must be the workspace id');
    return null;
  }
  return {
    secret,
    accountId,
    allowQueryToken: read(env, 'SMS_ALLOW_QUERY_TOKEN') === '1',
    allowIps: list(read(env, 'SMS_WEBHOOK_ALLOW_IPS')),
  };
}
