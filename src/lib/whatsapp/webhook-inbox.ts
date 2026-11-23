/**
 * The durable queue of inbound WhatsApp events (migration 264): typed
 * wrappers over its six service-role functions. Every event a webhook
 * accepts is recorded here before the 200, processed by
 * `processInboundEvent` (inbound-events.ts), and settled with its outcome;
 * the cron claims what is left.
 *
 * Errors are logged by code only: a database message can quote the row,
 * which holds the customer's words.
 */

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import type { WhatsAppChannel } from '@/lib/whatsapp/channels';

export type InboundEventKind =
  'message' | 'status' | 'own_send' | 'group_message';

/** One event as the webhook authenticated it. */
export interface InboundEvent {
  accountId: string;
  /** `whatsapp_config.id` of the number it arrived on. */
  channel: string;
  provider: WhatsAppChannel['provider'];
  /** The replay key (lib/edge), which names the number. */
  eventKey: string;
  kind: InboundEventKind;
  /** Built by the `*Payload` helpers in inbound-events.ts. */
  payload: unknown;
}

export type RecordState = 'new' | 'retaken' | 'busy' | 'done';

export interface RecordedEvent<E extends InboundEvent = InboundEvent> {
  event: E;
  id: string;
  attempt: number;
  /** new | retaken: ours to process and settle. busy | done: skip. */
  state: RecordState;
}

export type RecordResult<E extends InboundEvent = InboundEvent> =
  | { status: 'recorded'; events: RecordedEvent<E>[] }
  /** 264 is not applied yet: process as before the queue existed. */
  | { status: 'unavailable' }
  /** Nothing can be relied on: answer 503, so the gateway delivers again. */
  | { status: 'failed'; reason: string };

export interface ClaimedEvent extends InboundEvent {
  id: string;
  attempt: number;
  receivedAt: string;
}

export type InboundOutcome =
  | { outcome: 'done' }
  /** `reason` is stored and logged: never customer text. */
  | { outcome: 'failed'; reason: string }
  | { outcome: 'unmatched' };

type Db = Pick<SupabaseClient, 'rpc'>;

const EVENT_KEY_MAX = 512;

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^\w{1,20}$/.test(code) ? code : 'unknown';
}

let unavailableLogged = false;

/** The function does not exist: the build runs ahead of migration 264. */
function isUnavailable(error: unknown): boolean {
  const code = codeOf(error);
  if (code !== 'PGRST202' && code !== '42883') return false;
  if (!unavailableLogged) {
    unavailableLogged = true;
    console.error(
      '[webhook-inbox] NOT DURABLE: migration 264 is not applied, so an inbound message lost while processing is not retried'
    );
  }
  return true;
}

/** An RPC whose transport failure is an error like any other. */
async function call(
  db: Db,
  fn: string,
  args: Record<string, unknown>
): Promise<{ data: unknown; error: unknown }> {
  try {
    const { data, error } = await db.rpc(fn, args);
    return { data, error };
  } catch (error) {
    return { data: null, error: error ?? {} };
  }
}

/** For the cron: null while 264 is missing, throws on any other error. */
async function callOrThrow(
  db: Db,
  fn: string,
  args: Record<string, unknown> = {}
): Promise<{ data: unknown } | null> {
  const { data, error } = await call(db, fn, args);
  if (!error) return { data };
  if (isUnavailable(error)) return null;
  throw new Error(`${fn} failed (${codeOf(error)})`);
}

function cleanText(text: string): string {
  // With the u flag, \p{Surrogate} matches only an unpaired half.
  return text.replaceAll('\u0000', '').replace(/\p{Surrogate}/gu, '�');
}

/**
 * A copy jsonb accepts. It refuses U+0000 and unpaired surrogates, and one
 * such message would otherwise be refused (503) on every redelivery.
 */
export function sanitizePayload(payload: unknown): unknown {
  const json = JSON.stringify(payload, (_key, value: unknown) => {
    if (typeof value === 'string') return cleanText(value);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [cleanText(k), v])
      );
    }
    return value;
  });
  return json === undefined ? null : JSON.parse(json);
}

/** The key as stored: 264 takes 1 to 512 characters jsonb accepts. */
function storedKey(key: string): string {
  if (key.length <= EVENT_KEY_MAX && cleanText(key) === key) return key;
  return `h:${createHash('sha256').update(key).digest('hex')}`;
}

/**
 * Record a delivery's events, all or none. One answer per distinct event
 * key, in the delivery's order (a key repeated in it is one event). Never
 * throws.
 */
export async function recordInboundEvents<E extends InboundEvent>(
  events: readonly E[],
  db: Db = supabaseAdmin()
): Promise<RecordResult<E>> {
  const byKey = new Map<string, E>();
  for (const event of events) {
    const key = storedKey(event.eventKey);
    if (!byKey.has(key)) byKey.set(key, event);
  }
  if (byKey.size === 0) return { status: 'recorded', events: [] };

  const { data, error } = await call(db, 'webhook_inbox_record', {
    p_events: [...byKey].map(([key, e]) => ({
      account_id: e.accountId,
      channel: e.channel,
      provider: e.provider,
      event_key: key,
      kind: e.kind,
      payload: sanitizePayload(e.payload),
    })),
  });
  if (error) {
    if (isUnavailable(error)) return { status: 'unavailable' };
    const reason = codeOf(error);
    console.error(`[webhook-inbox] record failed (${reason})`);
    return { status: 'failed', reason };
  }

  const answers = new Map(
    (
      (data ?? []) as Array<{
        event_key: string;
        id: string;
        attempt: number;
        state: RecordState;
      }>
    ).map((row) => [row.event_key, row])
  );
  const recorded: RecordedEvent<E>[] = [];
  for (const [key, event] of byKey) {
    const row = answers.get(key);
    if (!row) {
      // Unanswered (purged between the insert and the read) would be lost
      // in silence: have the gateway deliver again.
      console.error('[webhook-inbox] record left an event unanswered');
      return { status: 'failed', reason: 'incomplete' };
    }
    recorded.push({
      event,
      id: row.id,
      attempt: row.attempt,
      state: row.state,
    });
  }
  return { status: 'recorded', events: recorded };
}

/**
 * Settle an event. Never throws: one left unsettled comes back when its
 * lease runs out. Null: nothing changed (or the call failed, logged).
 */
export async function settleInboundEvent(
  id: string,
  attempt: number,
  result: InboundOutcome,
  db?: Db
): Promise<'done' | 'retry' | 'dead' | null> {
  try {
    const { data, error } = await (db ?? supabaseAdmin()).rpc(
      'webhook_inbox_settle',
      {
        p_id: id,
        p_attempt: attempt,
        p_outcome: result.outcome,
        p_error:
          result.outcome === 'failed' ? result.reason.slice(0, 200) : null,
      }
    );
    if (error) throw error;
    return data === 'done' || data === 'retry' || data === 'dead' ? data : null;
  } catch (error) {
    console.error(
      `[webhook-inbox] settle ${result.outcome} failed for ${id} (${codeOf(error)})`
    );
    return null;
  }
}

/** Due events, leased for five minutes. Empty while 264 is missing. */
export async function claimInboundEvents(
  limit = 1,
  db: Db = supabaseAdmin()
): Promise<ClaimedEvent[]> {
  const res = await callOrThrow(db, 'webhook_inbox_claim', { p_limit: limit });
  return (
    (res?.data ?? []) as Array<{
      id: string;
      account_id: string;
      channel: string;
      provider: WhatsAppChannel['provider'];
      event_key: string;
      kind: InboundEventKind;
      payload: unknown;
      received_at: string;
      attempt: number;
    }>
  ).map((r) => ({
    id: r.id,
    accountId: r.account_id,
    channel: r.channel,
    provider: r.provider,
    eventKey: r.event_key,
    kind: r.kind,
    payload: r.payload,
    receivedAt: r.received_at,
    attempt: r.attempt,
  }));
}

/** Rings the bells for newly dead events; one entry per account, to log. */
export async function notifyDeadInboundEvents(
  db: Db = supabaseAdmin()
): Promise<{ accountId: string; events: number }[]> {
  const res = await callOrThrow(db, 'webhook_inbox_notify_dead');
  return (
    (res?.data ?? []) as Array<{ account_id: string; events: number }>
  ).map((r) => ({ accountId: r.account_id, events: r.events }));
}

/** Rows deleted. */
export async function purgeInboundEvents(
  db: Db = supabaseAdmin()
): Promise<number> {
  const res = await callOrThrow(db, 'webhook_inbox_purge');
  return typeof res?.data === 'number' ? res.data : 0;
}

export interface InboundQueueStats {
  pending: number;
  dead: number;
  oldestPendingAgeSeconds: number;
}

/** Null while 264 is missing. */
export async function inboundQueueStats(
  db: Db = supabaseAdmin()
): Promise<InboundQueueStats | null> {
  const res = await callOrThrow(db, 'webhook_inbox_stats');
  if (!res) return null;
  const s = (res.data ?? {}) as Record<string, unknown>;
  return {
    pending: Number(s.pending ?? 0),
    dead: Number(s.dead ?? 0),
    oldestPendingAgeSeconds: Number(s.oldest_pending_age_seconds ?? 0),
  };
}
