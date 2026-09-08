import { NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import { secretsMatch } from '@/lib/whatsapp/whapi-webhook-auth';
import {
  isTemplateStatusPayload,
  normalizeMetaWebhook,
  type RawMetaWebhookPayload,
} from '@/lib/whatsapp/meta-webhook';
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
  type TemplateWebhookChange,
} from '@/lib/whatsapp/template-webhook';
import {
  handleStatusUpdate,
  processMessage,
} from '@/lib/whatsapp/inbound-pipeline';
import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import { serverSupabaseUrl } from '@/lib/supabase/urls';

/**
 * Meta Cloud API webhook — the second inbound hub.
 *
 * The Whapi route (`/api/whatsapp/webhook`) is its sibling. They share
 * everything downstream via `lib/whatsapp/inbound-pipeline.ts` and
 * differ only in how a request is authenticated and how the account is
 * resolved, which really are different:
 *
 *   Whapi  a shared secret in the callback URL identifies the account;
 *          the payload's channel_id is only cross-checked afterwards,
 *          because the body is attacker-controlled and the secret is not.
 *
 *   Meta   the callback URL is configured once per APP and carries no
 *          per-account information at all. So the payload's
 *          `metadata.phone_number_id` selects the account, and the
 *          `X-Hub-Signature-256` HMAC over the raw body is what makes
 *          trusting it safe. Parsing before verifying is deliberate and
 *          confined to choosing which key to verify against — nothing
 *          acts on the payload until the signature has passed.
 *
 * Configure this URL in Meta → your App → WhatsApp → Configuration:
 *   https://<your-host>/api/whatsapp/meta/webhook
 * and subscribe at least the `messages` field.
 */

// Matches the Whapi route: inbound processing fans out to per-media
// downloads and mirror uploads, which needs headroom beyond the default.
export const maxDuration = 60;

// Lazy-initialized to avoid a build-time crash when env vars are missing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      serverSupabaseUrl(),
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

/**
 * GET — Meta's subscription handshake.
 *
 * Meta calls this once when the callback URL is saved in the App
 * dashboard, and refuses to enable the subscription unless the
 * `hub.challenge` is echoed back verbatim as plain text.
 *
 * The token to compare against has no phone number attached (the
 * handshake predates any message), so every connected Meta channel's
 * stored `verify_token` is tried, plus `META_VERIFY_TOKEN` for a
 * single-app self-host that would rather set it by environment.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode !== 'subscribe' || !token || !challenge) {
    // Not a handshake — answer as a reachability probe. Reveals nothing.
    return NextResponse.json(
      {
        ok: true,
        provider: 'meta',
        message:
          'wacrm Meta Cloud API webhook endpoint is reachable. Meta calls this with hub.mode=subscribe to verify.',
      },
      { status: 200 }
    );
  }

  if (await verifyTokenMatches(token)) {
    // MUST be the bare challenge as text/plain — a JSON wrapper fails
    // verification with no useful error in the App dashboard.
    return new Response(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  console.warn(
    '[meta-webhook] handshake rejected: unrecognised hub.verify_token'
  );
  return NextResponse.json({ error: 'Verification failed' }, { status: 403 });
}

async function verifyTokenMatches(provided: string): Promise<boolean> {
  const fromEnv = process.env.META_VERIFY_TOKEN;
  if (fromEnv && secretsMatch(provided, fromEnv)) return true;

  const { data: configs } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('verify_token')
    .eq('provider', 'meta');

  for (const config of configs ?? []) {
    if (!config.verify_token) continue;
    try {
      if (secretsMatch(provided, decrypt(config.verify_token))) return true;
    } catch {
      // Row encrypted under a rotated ENCRYPTION_KEY — skip rather than
      // failing the handshake for every other tenant.
      continue;
    }
  }
  return false;
}

/**
 * POST — the actual callback.
 *
 * Meta retries a non-200 with backoff and disables a subscription that
 * fails persistently, so this acknowledges fast and does the work in
 * `after()`, exactly as the Whapi route does. The same rule applies and
 * for the same reason (issue #301): work must be *awaited inside*
 * `after()`, never detached, or the runtime can freeze the function the
 * moment the response is sent and drop the callback mid-flight.
 */
export async function POST(request: Request) {
  // The signature is over the EXACT bytes Meta sent. Re-serialising a
  // parsed object changes key order and whitespace and will never match.
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');

  let payload: RawMetaWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as RawMetaWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Template review results (approved / rejected / quality) are a
  // different concern and carry no phone number to route on — they are
  // WABA-level. Verified against the app secret from the environment or
  // any connected Meta channel.
  if (isTemplateStatusPayload(payload)) {
    return handleTemplatePayload(payload, rawBody, signature);
  }

  const event = normalizeMetaWebhook(payload);

  if (!event.channelId) {
    // No metadata.phone_number_id — nothing we can route. 200 so Meta
    // does not retry a payload we will never be able to place.
    console.warn(
      '[meta-webhook] callback carried no phone_number_id; ignoring'
    );
    return NextResponse.json({ status: 'ignored' }, { status: 200 });
  }

  const config = await findMetaConfigByPhoneNumberId(event.channelId);
  if (!config) {
    console.warn(
      `[meta-webhook] no connected Meta channel for phone_number_id "${event.channelId}"`
    );
    // 200, not 404: this is a payload for a number that is not ours (a
    // shared app, or a number disconnected here). Failing it would make
    // Meta retry forever and eventually disable the subscription.
    return NextResponse.json({ status: 'ignored' }, { status: 200 });
  }

  // Now authenticate. The lookup above only chose which key to use; the
  // signature is what proves the payload. A stored per-account secret
  // wins over the environment so a multi-tenant install works.
  let appSecret: string | null = null;
  if (config.app_secret) {
    try {
      appSecret = decrypt(config.app_secret);
    } catch {
      appSecret = null;
    }
  }

  if (!verifyMetaWebhookSignature(rawBody, signature, appSecret)) {
    // 401 rather than a silent 200 so a misconfigured app secret shows
    // up loudly in Meta's delivery log instead of being eaten.
    console.warn(
      '[meta-webhook] rejected callback with a bad or missing signature'
    );
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  after(async () => {
    try {
      await processMetaEvent(event, config);
    } catch (error) {
      console.error('[meta-webhook] processing failed:', error);
    }
  });

  return NextResponse.json({ status: 'received' }, { status: 200 });
}

/**
 * Template lifecycle callbacks (approval, rejection, quality changes).
 *
 * These arrive on the same URL but carry no phone number, so they are
 * verified against the environment secret or any connected Meta
 * channel's — the update itself is scoped by the template id inside.
 */
async function handleTemplatePayload(
  payload: RawMetaWebhookPayload,
  rawBody: string,
  signature: string | null
): Promise<Response> {
  const { data: configs } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('app_secret')
    .eq('provider', 'meta');

  const candidates: (string | null)[] = [null]; // null = fall back to META_APP_SECRET
  for (const config of configs ?? []) {
    if (!config.app_secret) continue;
    try {
      candidates.push(decrypt(config.app_secret));
    } catch {
      continue;
    }
  }

  const verified = candidates.some((secret) =>
    verifyMetaWebhookSignature(rawBody, signature, secret)
  );
  if (!verified) {
    console.warn(
      '[meta-webhook] template callback failed signature verification'
    );
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  after(async () => {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (!change.field || !isTemplateWebhookField(change.field)) continue;
        try {
          await handleTemplateWebhookChange(
            change as TemplateWebhookChange,
            supabaseAdmin()
          );
        } catch (error) {
          console.error('[meta-webhook] template change failed:', error);
        }
      }
    }
  });

  return NextResponse.json({ status: 'received' }, { status: 200 });
}

/**
 * Resolve the account from the number the message arrived on.
 *
 * `phone_number_id` is UNIQUE across the table (migration 013, kept by
 * 046), so this is an indexed single-row lookup — unlike the Whapi
 * route's secret scan, which has to decrypt every row because it
 * matches on ciphertext.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function findMetaConfigByPhoneNumberId(
  phoneNumberId: string
): Promise<any | null> {
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    .eq('provider', 'meta')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle();

  if (error) {
    console.error('[meta-webhook] config lookup failed:', error);
    return null;
  }
  return data;
}

/**
 * Hand a verified event to the shared pipeline.
 *
 * Everything past this point is identical to the Whapi path — contact
 * dedup, the idempotency boundary, the status ladder, Flows →
 * automations → AI auto-reply → outbound webhooks.
 */
async function processMetaEvent(
  event: ReturnType<typeof normalizeMetaWebhook>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any
) {
  for (const status of event.statuses) {
    await handleStatusUpdate(status);
  }

  if (event.messages.length === 0) return;

  const channel: WhatsAppChannel = {
    id: config.id,
    accountId: config.account_id,
    provider: 'meta',
    label: config.label ?? null,
    phoneNumberId: config.phone_number_id,
    wabaId: config.waba_id ?? null,
    accessToken: decrypt(config.access_token),
    appSecret: null,
    isPrimary: config.is_primary === true,
    // Meta media URLs expire even faster than Whapi's (minutes, not
    // days) once resolved, so mirroring matters more here, not less.
    mirrorInboundMedia: config.mirror_inbound_media !== false,
    status: config.status ?? 'connected',
  };

  for (const message of event.messages) {
    await processMessage(message, config.account_id, config.user_id, channel);
  }
}
