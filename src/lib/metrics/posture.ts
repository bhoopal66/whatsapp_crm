/**
 * Which optional integrations this server has switched on, and which of
 * those run on a wire format nobody has tested against the real provider
 * (package 033g's "startup posture"). Shown as gauges on /api/metrics and
 * as one log line at start (src/instrumentation.ts).
 *
 * Unlike the package, a production start with an unverified integration
 * configured is not refused: here each is off until its variables are set
 * on purpose, and its docs say what to confirm first. The log line and the
 * gauge make the choice visible instead.
 *
 * Reads the environment only through each integration's own config reader,
 * so "configured" means exactly what the integration itself would use.
 */
import { rcsSendConfig, rcsWebhookConfig } from '@/lib/hr/automsg/rcs-config';
import { smsSendConfig, smsWebhookConfig } from '@/lib/hr/automsg/sms-config';
import type { Registry } from './registry';

type Env = Record<string, string | undefined>;

export interface Integration {
  name: string;
  configured: boolean;
  /** The wire format was written from documents, never tested live. */
  unverified: boolean;
}

export function startupPosture(env: Env = process.env): Integration[] {
  const set = (k: string) => !!env[k]?.trim();
  return [
    {
      name: 'rcs_sender',
      configured: rcsSendConfig(env) !== null,
      unverified: true,
    },
    {
      name: 'rcs_webhook',
      configured: rcsWebhookConfig(env) !== null,
      unverified: true,
    },
    {
      name: 'sms_sender',
      configured: smsSendConfig(env) !== null,
      unverified: true,
    },
    {
      name: 'sms_webhook',
      configured: smsWebhookConfig(env) !== null,
      unverified: true,
    },
    {
      name: 'typesafe',
      configured: set('TYPESAFE_API_KEY'),
      unverified: false,
    },
    {
      name: 'web_push',
      configured:
        set('VAPID_PUBLIC_KEY') &&
        set('VAPID_PRIVATE_KEY') &&
        set('VAPID_SUBJECT'),
      unverified: false,
    },
    {
      name: 'meetings',
      configured:
        set('CLOUDFLARE_CALLS_APP_ID') && set('CLOUDFLARE_CALLS_APP_SECRET'),
      unverified: false,
    },
    {
      name: 'vault',
      configured:
        set('VAULT_KEYS') && set('VAULT_CURRENT_KEY') && set('VAULT_BLIND_KEY'),
      unverified: false,
    },
  ];
}

/** One line for the service log; never includes a value. */
export function postureLogLine(p: Integration[]): string {
  const on = p.filter((i) => i.configured).map((i) => i.name);
  const risky = p
    .filter((i) => i.configured && i.unverified)
    .map((i) => i.name);
  return (
    `[posture] integrations on: ${on.length ? on.join(', ') : 'none'}` +
    (risky.length
      ? `; UNVERIFIED wire format in use: ${risky.join(', ')} (see docs/hr-workflows.md)`
      : '')
  );
}

export function collectPosture(registry: Registry, p: Integration[]): void {
  const configured = registry.gauge(
    'wacrm_integration_configured',
    '1 when an optional integration is configured on this server, else 0.',
    ['name']
  );
  const unverified = registry.gauge(
    'wacrm_integration_unverified',
    '1 when a configured integration runs on an untested wire format.',
    ['name']
  );
  configured.reset();
  unverified.reset();
  for (const i of p) {
    configured.set({ name: i.name }, i.configured ? 1 : 0);
    unverified.set({ name: i.name }, i.configured && i.unverified ? 1 : 0);
  }
}
