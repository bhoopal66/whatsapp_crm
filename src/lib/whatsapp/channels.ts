// ============================================================
// Channel resolution — which WhatsApp number sends this?
//
// Before migration 046 the answer was always "the one row in
// whatsapp_config". An account can now hold several: any number of
// Whapi channels (real WhatsApp accounts paired to the gateway as
// linked devices — migration 060) and one Meta Cloud API number. They
// are necessarily DIFFERENT phone numbers — registering a number on the
// Cloud API deregisters it from the WhatsApp app, so no number can be
// on both at once.
//
// Since 060 `provider` no longer identifies a number, so every rule
// below that used to match on it prefers an exact channel id first:
// `messages.channel_id` for what the customer wrote to, and
// `conversations.channel_id` for which number a thread is on. A number
// can also be allocated to specific members; their new chats start
// from it (`pickChannelForUser`).
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
  /** Connection order; the tie-breaker between several same-provider numbers. */
  createdAt?: string | null;
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
  created_at?: string | null;
}

const CHANNEL_COLUMNS =
  'id, account_id, provider, label, phone_number_id, waba_id, access_token, app_secret, is_primary, mirror_inbound_media, status, created_at';

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
    createdAt: row.created_at ?? null,
  };
}

/**
 * Every channel connected on this account. Empty when WhatsApp is
 * unconfigured.
 *
 * A row whose token will not decrypt (saved under a since-rotated
 * ENCRYPTION_KEY) is left out rather than failing the whole list: with
 * several numbers on an account, one broken number must not stop every
 * other number from sending. Only when EVERY row is unreadable does
 * this throw, so the operator still gets the actionable
 * `channel_credentials_unreadable` instead of "not configured".
 */
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
    // The database's own wording stays in the log; this message can
    // reach a browser (Settings → routing) and the public API.
    console.error('[channels] could not load WhatsApp channels:', error);
    throw new ChannelError(
      'channel_lookup_failed',
      'Could not load WhatsApp channels.',
      500
    );
  }

  const channels: WhatsAppChannel[] = [];
  let unreadable: ChannelError | null = null;
  for (const row of (data ?? []) as unknown as ChannelRow[]) {
    try {
      channels.push(toChannel(row));
    } catch (err) {
      if (!(err instanceof ChannelError)) throw err;
      unreadable = err;
      console.error(
        `[channels] skipping number ${row.id} (${row.provider}): its token cannot be decrypted`
      );
    }
  }
  if (channels.length === 0 && unreadable) throw unreadable;

  // Within a provider, oldest first, so "the first Whapi number" is a
  // stable answer across calls rather than whatever order the heap
  // returned. `sort` is stable, so the provider order above survives.
  return channels.sort((a, b) =>
    a.provider === b.provider
      ? (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
      : 0
  );
}

/**
 * Every Whapi number on the install, across all accounts, for the
 * channel health monitor — the one caller with no account to scope to.
 * Pass the service-role client; under RLS this would see one account.
 *
 * Only Whapi: its linked-device session can be logged out on the phone
 * while the token stays valid, which is exactly what nothing else
 * notices. An undecryptable row is skipped, never fatal — unlike
 * `loadChannels` there is no "every row unreadable" error to surface,
 * because nobody is waiting on this list to send.
 */
export async function loadWhapiChannelsForHealth(
  admin: SupabaseClient
): Promise<WhatsAppChannel[]> {
  const { data, error } = await admin
    .from('whatsapp_config')
    .select(CHANNEL_COLUMNS)
    .eq('provider', 'whapi')
    .order('created_at', { ascending: true });

  if (error) {
    console.error(
      '[channels] could not load Whapi channels for health:',
      error
    );
    throw new ChannelError(
      'channel_lookup_failed',
      'Could not load WhatsApp channels.',
      500
    );
  }

  const channels: WhatsAppChannel[] = [];
  for (const row of (data ?? []) as unknown as ChannelRow[]) {
    try {
      channels.push(toChannel(row));
    } catch (err) {
      if (!(err instanceof ChannelError)) throw err;
      console.error(
        `[channels] health check skipping number ${row.id}: its token cannot be decrypted`
      );
    }
  }
  return channels;
}

/** The account's fallback channel, or null when nothing is connected. */
export function primaryChannel(
  channels: WhatsAppChannel[]
): WhatsAppChannel | null {
  if (channels.length === 0) return null;
  // The partial unique index guarantees at most one primary, but a row
  // set could arrive with none (an admin deleted the primary), so fall
  // back rather than returning null and reading as "WhatsApp not
  // configured". To a Whapi number first: the list is sorted by
  // provider, so a bare `channels[0]` is the Meta number, where every
  // free-form fallback send would be refused outside the 24h window.
  return (
    channels.find((c) => c.isPrimary) ??
    channels.find((c) => c.provider === 'whapi') ??
    channels[0]
  );
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
  return (await routeWithSource(db, accountId, surface, channels)).channel;
}

/**
 * The surface's route over an already-loaded channel list, and whether
 * it came from an explicit `whatsapp_routes` row (vs. the primary).
 */
async function routeWithSource(
  db: SupabaseClient,
  accountId: string,
  surface: RoutingSurface,
  channels: WhatsAppChannel[]
): Promise<{ channel: WhatsAppChannel; explicit: boolean }> {
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
    if (routed) return { channel: routed, explicit: true };
  }

  const primary = primaryChannel(channels);
  if (!primary) throw NOT_CONFIGURED;
  return { channel: primary, explicit: false };
}

/**
 * Channel ids `userId` is allocated to (migration 060). Empty when the
 * user is on no number — the common case, and the one where nothing
 * about channel choice changes.
 */
export async function loadUserChannelIds(
  db: SupabaseClient,
  accountId: string,
  userId: string
): Promise<string[]> {
  const { data } = await db
    .from('whatsapp_channel_members')
    .select('config_id')
    .eq('account_id', accountId)
    .eq('user_id', userId);
  return ((data ?? []) as Array<{ config_id: string }>).map((r) => r.config_id);
}

/**
 * The two numbers a conversation carries: the one it is on
 * (`channel_id`, migration 060) and the one a person pinned it to send
 * from (`send_channel_id`, migration 061), either possibly null.
 * Callers that already hold the conversation row pass these in instead
 * of paying for a second read.
 */
export interface ConversationNumbers {
  channelId: string | null;
  sendChannelId: string | null;
}

async function conversationNumbers(
  db: SupabaseClient,
  conversationId: string
): Promise<ConversationNumbers> {
  const { data } = await db
    .from('conversations')
    .select('channel_id, send_channel_id')
    .eq('id', conversationId)
    .maybeSingle();
  return {
    channelId: (data?.channel_id as string | null | undefined) ?? null,
    sendChannelId: (data?.send_channel_id as string | null | undefined) ?? null,
  };
}

/**
 * The number a person pinned this chat to (migration 061), if it is
 * still connected. A pin to a since-disconnected number is cleared by
 * the FK, but a stale read is harmless: it simply is not found here.
 */
function pinnedChannel(
  channels: WhatsAppChannel[],
  sendChannelId: string | null
): WhatsAppChannel | null {
  return sendChannelId
    ? (channels.find((c) => c.id === sendChannelId) ?? null)
    : null;
}

/**
 * Which number does a member's NEW chat start from?
 *
 * Pure, so the rule is testable without a database. A member allocated
 * to one or more numbers starts from one of them — the routed number if
 * it is theirs, else their primary, else the oldest. A member on no
 * number gets the route, exactly as before migration 060 — unless
 * `sharedIds` says the routed number belongs to other people, in which
 * case a shared number (nobody allocated) is used instead, preferring
 * the routed number's provider. Starting a chat from someone else's
 * number would hand it to their team and is refused by the database
 * (`conversations_channel_guard`, 062) anyway.
 *
 * Admins may use every number; callers pass no `sharedIds` for them.
 */
export function pickChannelForUser(
  channels: WhatsAppChannel[],
  allocatedIds: readonly string[],
  routed: WhatsAppChannel,
  sharedIds?: ReadonlySet<string>
): WhatsAppChannel {
  const mine = channels.filter((c) => allocatedIds.includes(c.id));
  if (mine.length > 0) {
    if (mine.some((c) => c.id === routed.id)) return routed;
    return mine.find((c) => c.isPrimary) ?? mine[0];
  }
  if (!sharedIds || sharedIds.has(routed.id)) return routed;
  const shared = channels.filter((c) => sharedIds.has(c.id));
  return (
    shared.find((c) => c.provider === routed.provider && c.isPrimary) ??
    shared.find((c) => c.provider === routed.provider) ??
    shared[0] ??
    // Nothing this member may use: fall back to the route rather than
    // failing the send; the database decides whether it may be stamped.
    routed
  );
}

/**
 * The channel on `provider` to use, now that a provider can have more
 * than one number (migration 060). Tries `preferIds` in order — the
 * caller's best guesses, e.g. the thread's own number, then the
 * sender's allocations — then the primary, then the oldest. Null when
 * that provider is not connected at all.
 */
export function pickByProvider(
  channels: WhatsAppChannel[],
  provider: WhatsAppProvider,
  preferIds: ReadonlyArray<string | null | undefined> = []
): WhatsAppChannel | null {
  const candidates = channels.filter((c) => c.provider === provider);
  if (candidates.length === 0) return null;
  for (const id of preferIds) {
    const hit = id ? candidates.find((c) => c.id === id) : undefined;
    if (hit) return hit;
  }
  return candidates.find((c) => c.isPrimary) ?? candidates[0];
}

/**
 * The number a person's NEW chat starts from, over loaded channels:
 * the surface route, adjusted for who is sending (`pickChannelForUser`).
 * One read of the allocation table answers both "which numbers are
 * mine" and "which are shared"; one read of the profile says whether
 * the sender is an admin (who may use any number).
 */
async function startFor(
  db: SupabaseClient,
  accountId: string,
  surface: RoutingSurface,
  senderUserId: string | null | undefined,
  channels: WhatsAppChannel[]
): Promise<WhatsAppChannel> {
  const { channel: routed } = await routeWithSource(
    db,
    accountId,
    surface,
    channels
  );
  if (!senderUserId) return routed;

  const { data } = await db
    .from('whatsapp_channel_members')
    .select('config_id, user_id')
    .eq('account_id', accountId);
  const rows = (data ?? []) as Array<{ config_id: string; user_id: string }>;
  if (rows.length === 0) return routed; // nobody allocated anywhere

  const mine = rows
    .filter((r) => r.user_id === senderUserId)
    .map((r) => r.config_id);
  if (mine.length > 0) return pickChannelForUser(channels, mine, routed);

  const restricted = new Set(rows.map((r) => r.config_id));
  if (!restricted.has(routed.id)) return routed;

  const { data: profile } = await db
    .from('profiles')
    .select('account_role')
    .eq('user_id', senderUserId)
    .eq('account_id', accountId)
    .maybeSingle();
  const role = profile?.account_role as string | undefined;
  if (role === 'admin' || role === 'owner') return routed;

  const shared = new Set(
    channels.filter((c) => !restricted.has(c.id)).map((c) => c.id)
  );
  return pickChannelForUser(channels, [], routed, shared);
}

/**
 * Reply-to-the-customer resolution over loaded channels and the
 * conversation's numbers. See `resolveReplyChannel`.
 */
async function replyFrom(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  fallbackSurface: RoutingSurface,
  senderUserId: string | null | undefined,
  channels: WhatsAppChannel[],
  numbers: ConversationNumbers
): Promise<WhatsAppChannel> {
  const { data: lastInbound } = await db
    .from('messages')
    .select('provider, channel_id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const exactId = (lastInbound?.channel_id as string | null | undefined) ?? null;
  const exact = exactId ? channels.find((c) => c.id === exactId) : undefined;
  if (exact) return exact;

  const provider = lastInbound?.provider as WhatsAppProvider | undefined;
  if (provider) {
    const match = pickByProvider(channels, provider, [numbers.channelId]);
    if (match) return match;
    // The channel that carried the conversation has since been
    // disconnected. Fall through rather than fail: the customer still
    // deserves a reply, even from the other number.
  } else if (numbers.channelId) {
    const started = channels.find((c) => c.id === numbers.channelId);
    if (started) return started;
  }

  return startFor(db, accountId, fallbackSurface, senderUserId, channels);
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
 * That message names its exact number (`channel_id`, migration 060).
 * Older rows carry only a `provider`, which stopped being unique once
 * an account could hold two Whapi numbers — for those, the thread's
 * own number breaks the tie.
 *
 * With no inbound history — an agent-initiated thread — the thread
 * keeps the number it was started from, and failing that it starts
 * from the sender's allocated number or the `inbox` route.
 *
 * This ignores a person's pin (061) on purpose — it answers "where is
 * the customer", which `resolveSendChannel` then weighs against the pin.
 */
export async function resolveReplyChannel(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  fallbackSurface: RoutingSurface = 'inbox',
  senderUserId?: string | null
): Promise<WhatsAppChannel> {
  const channels = await loadChannels(db, accountId);
  if (channels.length === 0) throw NOT_CONFIGURED;
  return replyFrom(
    db,
    accountId,
    conversationId,
    fallbackSurface,
    senderUserId,
    channels,
    await conversationNumbers(db, conversationId)
  );
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
 *     (Within a provider, see `resolveBotChannel`.)
 *
 * A person's pin on the chat (migration 061) sits above both.
 *
 * `preferredProvider` sits above the two rules too (but below the pin):
 * the caller has already decided which *kind* of number this send
 * belongs on. The Contact detail view is the one place that needs it —
 * it initiates rather than replies, so there is no customer to follow,
 * and the two actions it offers map onto the two providers by nature. A
 * free-form "Send message" belongs on the Whapi number (no service
 * window, no template registry), and "Send template" belongs on the
 * Meta number (approved templates are exactly what opens a
 * business-initiated conversation there). A pin of the other kind
 * yields to it — unless that kind is not connected at all, when the
 * pin is the best answer there is. With several numbers on the pinned
 * provider, the thread's own number wins, then one the sender is
 * allocated to.
 *
 * `senderUserId` is the signed-in human, when there is one. It only
 * matters for a chat with no number yet, which starts from one they may
 * use (migration 060/062).
 *
 * `preloaded` lets a caller that already read the conversation row (the
 * send core does) skip reading it again on this hot path.
 */
export async function resolveSendChannel(
  db: SupabaseClient,
  accountId: string,
  surface: RoutingSurface,
  conversationId?: string | null,
  preferredProvider?: WhatsAppProvider | null,
  senderUserId?: string | null,
  preloaded?: ConversationNumbers
): Promise<WhatsAppChannel> {
  const channels = await loadChannels(db, accountId);
  if (channels.length === 0) throw NOT_CONFIGURED;

  const numbers: ConversationNumbers | null = conversationId
    ? (preloaded ?? (await conversationNumbers(db, conversationId)))
    : null;

  // A person pinned this chat to a number (migration 061): everything
  // in it goes out there until someone changes it back.
  const pinned = pinnedChannel(channels, numbers?.sendChannelId ?? null);
  if (
    pinned &&
    (!preferredProvider ||
      pinned.provider === preferredProvider ||
      !channels.some((c) => c.provider === preferredProvider))
  ) {
    return pinned;
  }

  if (preferredProvider) {
    const allocated = senderUserId
      ? await loadUserChannelIds(db, accountId, senderUserId)
      : [];
    const byProvider = pickByProvider(channels, preferredProvider, [
      numbers?.channelId,
      ...allocated,
    ]);
    if (byProvider) return byProvider;
  }

  const followsTheCustomer = surface === 'inbox' || surface === 'api';
  if (followsTheCustomer && conversationId && numbers) {
    return replyFrom(
      db,
      accountId,
      conversationId,
      surface,
      senderUserId,
      channels,
      numbers
    );
  }

  return startFor(db, accountId, surface, senderUserId, channels);
}

/**
 * Which number a BOT answer in an existing thread goes out on.
 *
 * The admin's route picks the *kind* of number — that is what routing
 * automations to Meta relies on, and it still wins across providers.
 * But two Whapi numbers are interchangeable in capability and not in
 * who the customer thinks they are talking to: a customer who wrote to
 * Support must not get the flow's next question from Sales. So when the
 * thread is on a number of the routed provider, the bot stays on it.
 * A person's pin (061) wins over both.
 *
 * Without a conversation (a scheduled automation step, a broadcast)
 * this is exactly `resolveChannelForSurface`.
 */
export async function resolveBotChannel(
  db: SupabaseClient,
  accountId: string,
  surface: RoutingSurface,
  conversationId?: string | null
): Promise<WhatsAppChannel> {
  const channels = await loadChannels(db, accountId);
  const { channel: routed } = await routeWithSource(
    db,
    accountId,
    surface,
    channels
  );
  if (!conversationId) return routed;

  const { channelId: threadChannelId, sendChannelId } =
    await conversationNumbers(db, conversationId);

  // The bot answering in a pinned chat follows the pin too — the
  // customer is now talking to that number, and a flow's next question
  // arriving from the old one would undo the agent's switch.
  const pinned = pinnedChannel(channels, sendChannelId);
  if (pinned) return pinned;

  const onThread = threadChannelId
    ? channels.find((c) => c.id === threadChannelId)
    : undefined;
  return onThread && onThread.provider === routed.provider ? onThread : routed;
}

/**
 * The number the AI agent would answer this chat from — the question
 * its gate asks before spending a token.
 *
 * Same as `resolveBotChannel` (which is what the reply is then sent
 * with), except that an EXPLICIT `ai_reply` route is taken literally:
 * routing the bot to "Sales" means it answers on Sales only, and a
 * "Support" number of the same provider stays human. Without that, the
 * same-provider rule would put the bot on every Whapi number.
 */
export async function resolveAiReplyChannel(
  db: SupabaseClient,
  accountId: string,
  conversationId: string
): Promise<WhatsAppChannel> {
  const channels = await loadChannels(db, accountId);
  const { channel: routed, explicit } = await routeWithSource(
    db,
    accountId,
    'ai_reply',
    channels
  );
  const { channelId: threadChannelId, sendChannelId } =
    await conversationNumbers(db, conversationId);

  const pinned = pinnedChannel(channels, sendChannelId);
  if (pinned) return pinned;
  if (explicit) return routed;

  const onThread = threadChannelId
    ? channels.find((c) => c.id === threadChannelId)
    : undefined;
  return onThread && onThread.provider === routed.provider ? onThread : routed;
}

/**
 * The account's channel on `provider`, or null when that provider is
 * not connected. Never throws for "not connected" — callers use the
 * null to fall back, and the typed "not configured" error belongs to
 * the surface resolvers, which know whether *anything* is connected.
 * With several numbers on that provider, the primary, then the oldest.
 */
export async function resolveChannelByProvider(
  db: SupabaseClient,
  accountId: string,
  provider: WhatsAppProvider
): Promise<WhatsAppChannel | null> {
  const channels = await loadChannels(db, accountId);
  return pickByProvider(channels, provider);
}

export function isWhatsAppProvider(value: unknown): value is WhatsAppProvider {
  return value === 'whapi' || value === 'meta';
}

/** Human-readable name for logs, errors, and the routing selector. */
export function describeChannel(channel: WhatsAppChannel): string {
  const name = channel.label || channel.wabaId || channel.phoneNumberId;
  return `${name} (${channel.provider === 'meta' ? 'Cloud API' : 'Whapi'})`;
}
