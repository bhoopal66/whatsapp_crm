// ============================================================
// Channel resolution — which WhatsApp number sends this?
//
// Before migration 046 the answer was always "the one row in
// whatsapp_config". An account can now hold two: a Whapi channel (a
// real WhatsApp account paired to the gateway as a linked device) and
// a Meta Cloud API number. They are necessarily DIFFERENT phone
// numbers — registering a number on the Cloud API deregisters it from
// the WhatsApp app, so no number can be on both at once.
//
// Everything that sends asks this module which channel to use, and
// gets back decrypted, ready-to-use credentials. Callers should never
// read `whatsapp_config` or call `decrypt` themselves; that is how the
// old single-channel assumption spread to a dozen files in the first
// place.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';

export type WhatsAppProvider = 'whapi' | 'meta';

/**
 * The surfaces an admin can route independently. Mirrors the CHECK
 * constraint on `whatsapp_routes.surface` (migration 046) — change one,
 * change both.
 */
export const ROUTING_SURFACES = [
  'inbox',
  'broadcast',
  'automation',
  'flow',
  'ai_reply',
  'api',
] as const;

export type RoutingSurface = (typeof ROUTING_SURFACES)[number];

export function isRoutingSurface(value: string): value is RoutingSurface {
  return (ROUTING_SURFACES as readonly string[]).includes(value);
}

/**
 * A connected number with its credentials already decrypted.
 *
 * `accessToken` and `appSecret` are plaintext secrets — never log this
 * object, and never return it from an API route.
 */
export interface WhatsAppChannel {
  id: string;
  accountId: string;
  provider: WhatsAppProvider;
  /** Operator-facing name. Falls back to the number when unset. */
  label: string | null;
  /** Whapi: channel id. Meta: phone number id. */
  phoneNumberId: string;
  /** Whapi: the connected phone number. Meta: the WABA id. */
  wabaId: string | null;
  /** DECRYPTED. Whapi channel token, or Meta permanent access token. */
  accessToken: string;
  /** DECRYPTED. Meta app secret for webhook HMAC; null for Whapi. */
  appSecret: string | null;
  isPrimary: boolean;
  mirrorInboundMedia: boolean;
  status: string;
}

/** Thrown when no usable channel exists. Carries an HTTP status callers can map. */
export class ChannelError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ChannelError';
    this.code = code;
    this.status = status;
  }
}

/** Row shape as stored. Credentials here are still ciphertext. */
interface ChannelRow {
  id: string;
  account_id: string;
  provider: string;
  label: string | null;
  phone_number_id: string;
  waba_id: string | null;
  access_token: string;
  app_secret: string | null;
  is_primary: boolean;
  mirror_inbound_media: boolean | null;
  status: string;
}

const CHANNEL_COLUMNS =
  'id, account_id, provider, label, phone_number_id, waba_id, access_token, app_secret, is_primary, mirror_inbound_media, status';

/**
 * Decrypt a row into a usable channel.
 *
 * A row whose credentials will not decrypt — written under a rotated
 * `ENCRYPTION_KEY` — is a hard failure rather than a skip. Unlike the
 * inbound webhook's secret scan (where skipping lets other tenants keep
 * working), a caller asking for *this* channel to send has no
 * alternative, and returning nothing would surface as the much more
 * confusing "WhatsApp not configured".
 */
function toChannel(row: ChannelRow): WhatsAppChannel {
  let accessToken: string;
  try {
    accessToken = decrypt(row.access_token);
  } catch {
    throw new ChannelError(
      'channel_credentials_unreadable',
      `The stored token for the ${row.provider} channel could not be decrypted. ` +
        'This usually means ENCRYPTION_KEY changed since it was saved — reconnect the number in Settings → WhatsApp.',
      500
    );
  }

  let appSecret: string | null = null;
  if (row.app_secret) {
    // Best-effort: a Meta install can supply the app secret by
    // environment instead, so an unreadable one is not fatal here —
    // the webhook's fail-closed check is the real gate.
    try {
      appSecret = decrypt(row.app_secret);
    } catch {
      appSecret = null;
    }
  }

  return {
    id: row.id,
    accountId: row.account_id,
    provider: row.provider as WhatsAppProvider,
    label: row.label,
    phoneNumberId: row.phone_number_id,
    wabaId: row.waba_id,
    accessToken,
    appSecret,
    isPrimary: row.is_primary,
    // NULL predates migration 039's default; mirroring is opt-out.
    mirrorInboundMedia: row.mirror_inbound_media !== false,
    status: row.status,
  };
}

/** Every channel connected on this account. Empty when WhatsApp is unconfigured. */
export async function loadChannels(
  db: SupabaseClient,
  accountId: string
): Promise<WhatsAppChannel[]> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select(CHANNEL_COLUMNS)
    .eq('account_id', accountId)
    .order('provider', { ascending: true });

  if (error) {
    throw new ChannelError(
      'channel_lookup_failed',
      `Could not load WhatsApp channels: ${error.message}`,
      500
    );
  }
  return (data ?? []).map((row) => toChannel(row as unknown as ChannelRow));
}

/** The account's fallback channel, or null when nothing is connected. */
export function primaryChannel(
  channels: WhatsAppChannel[]
): WhatsAppChannel | null {
  if (channels.length === 0) return null;
  // The partial unique index guarantees at most one primary, but a row
  // set could arrive with none (an admin deleted the primary), so fall
  // back to the first rather than returning null and reading as
  // "WhatsApp not configured".
  return channels.find((c) => c.isPrimary) ?? channels[0];
}

const NOT_CONFIGURED = new ChannelError(
  'whatsapp_not_configured',
  'WhatsApp not configured. Please set up your WhatsApp integration first.',
  400
);

/**
 * Which channel should `surface` send through?
 *
 * Resolution order:
 *   1. an explicit `whatsapp_routes` row for the surface — the admin
 *      selector in Settings → WhatsApp;
 *   2. the account's primary channel;
 *   3. failing both, a typed "not configured" error.
 *
 * An install that never opens the selector therefore behaves exactly as
 * it did when only one channel could exist.
 */
export async function resolveChannelForSurface(
  db: SupabaseClient,
  accountId: string,
  surface: RoutingSurface
): Promise<WhatsAppChannel> {
  const channels = await loadChannels(db, accountId);
  if (channels.length === 0) throw NOT_CONFIGURED;

  // One round trip, and a missing row is the common case (no explicit
  // route = use the primary), so `maybeSingle` rather than an error.
  const { data: route } = await db
    .from('whatsapp_routes')
    .select('config_id')
    .eq('account_id', accountId)
    .eq('surface', surface)
    .maybeSingle();

  if (route?.config_id) {
    const routed = channels.find((c) => c.id === route.config_id);
    // A dangling route cannot normally survive — the FK cascades on
    // delete — but falling through to the primary is strictly better
    // than failing a customer-visible send over stale config.
    if (routed) return routed;
  }

  const primary = primaryChannel(channels);
  if (!primary) throw NOT_CONFIGURED;
  return primary;
}

/**
 * Which channel should a reply to `conversationId` go out on?
 *
 * Conversations are one-per-contact and channel-agnostic (migration
 * 046 deliberately did not split them), so the thread itself cannot
 * answer this. The customer's own last inbound message can: replying on
 * the number they wrote to is the only behaviour that isn't surprising,
 * and on Meta it is also the only one that stays inside the 24-hour
 * service window they opened.
 *
 * Falls back to the `inbox` route when the thread has no inbound
 * history — an agent-initiated first contact.
 */
export async function resolveReplyChannel(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  fallbackSurface: RoutingSurface = 'inbox'
): Promise<WhatsAppChannel> {
  const { data: lastInbound } = await db
    .from('messages')
    .select('provider')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const provider = lastInbound?.provider as WhatsAppProvider | undefined;
  if (provider) {
    const channels = await loadChannels(db, accountId);
    const match = channels.find((c) => c.provider === provider);
    if (match) return match;
    // The channel that carried the conversation has since been
    // disconnected. Fall through rather than fail: the customer still
    // deserves a reply, even from the other number.
  }

  return resolveChannelForSurface(db, accountId, fallbackSurface);
}

/**
 * The single entry point every send site uses.
 *
 * Two rules, and which applies depends on who is talking:
 *
 *   * A HUMAN replying in a thread (`inbox`, and the public API's
 *     equivalent) follows the customer: the reply goes out on the
 *     number they last wrote to. Anything else is surprising — the
 *     customer sees an answer arrive from a number they never
 *     contacted — and on Meta it also lands outside the 24-hour window
 *     they just opened, where a free-form reply is refused outright.
 *
 *   * A BOT or campaign (`broadcast`, `automation`, `flow`, `ai_reply`)
 *     obeys the admin's route instead. This is the whole point of the
 *     selector: routing automations to the marketing number has to hold
 *     even when the trigger was an inbound message on the other one.
 */
export async function resolveSendChannel(
  db: SupabaseClient,
  accountId: string,
  surface: RoutingSurface,
  conversationId?: string | null
): Promise<WhatsAppChannel> {
  const followsTheCustomer = surface === 'inbox' || surface === 'api';
  if (followsTheCustomer && conversationId) {
    return resolveReplyChannel(db, accountId, conversationId, surface);
  }
  return resolveChannelForSurface(db, accountId, surface);
}

/** Human-readable name for logs, errors, and the routing selector. */
export function describeChannel(channel: WhatsAppChannel): string {
  const name = channel.label || channel.wabaId || channel.phoneNumberId;
  return `${name} (${channel.provider === 'meta' ? 'Cloud API' : 'Whapi'})`;
}
