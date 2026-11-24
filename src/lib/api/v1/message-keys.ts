// ============================================================
// Idempotency-Key on POST /api/v1/messages and /api/v1/broadcasts
// (migration 305).
//
// The row is claimed before anything is sent and settled after, every
// step a compare-and-set, as in `lib/compass/notify.ts`:
//
//   claimed → sent          the gateway took it; a repeat is answered
//                           with the stored response
//           → failed        certainly not sent; the same key may retry
//           → unconfirmed   it may have reached the customer, or the
//                           claiming process died (STALE_CLAIM_MS):
//                           answered 409, never sent again by itself
//
// No claim, no send: a database that does not answer, or one without
// migration 305, is a 503 and nothing goes out.
//
// A broadcast goes through the same steps; what must happen once is the
// insert of the campaign, so "sent" there means created, and everything
// after it is the delivery lock's and the cron's.
// ============================================================

import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { isUniqueViolation } from '@/lib/contacts/dedupe';
import {
  ApiError,
  badRequest,
  unavailable,
  type ApiErrorCode,
} from '@/lib/api/v1/respond';

const TABLE = 'v1_message_keys';

/** A claim not settled by then belongs to a process that died. */
export const STALE_CLAIM_MS = 2 * 60_000;

/** A campaign first resolves up to 1000 recipients, one by one. */
export const STALE_BROADCAST_CLAIM_MS = 15 * 60_000;

/** A key is remembered this long, then removed by the automations cron. */
export const MESSAGE_KEY_DAYS = 30;

/** What the caller is answered; ids only, never the text. */
export interface SentMessageAnswer {
  message_id: string | null;
  whatsapp_message_id: string | null;
  conversation_id: string;
  contact_id: string;
  contact_created: boolean;
  /** The customer has it, but the CRM could not save it. */
  warning?: 'not_recorded';
}

export interface BroadcastAnswer {
  broadcast_id: string;
  status: 'sending';
  total_recipients: number;
  accepted: number;
  rejected: number;
}

/** What one route's keys say and do differently. */
interface KeyKind {
  staleMs: number;
  inProgress: string;
  unconfirmed: string;
  reused: string;
}

const MESSAGE: KeyKind = {
  staleMs: STALE_CLAIM_MS,
  inProgress:
    'A request with this idempotency key is being sent. Retry later with the same key.',
  unconfirmed:
    'The message may have reached the customer. It is not sent again with this idempotency key.',
  reused:
    'This idempotency key was used for another message. Nothing was sent.',
};

const BROADCAST: KeyKind = {
  staleMs: STALE_BROADCAST_CLAIM_MS,
  inProgress:
    'A request with this idempotency key is creating its broadcast. Retry later with the same key.',
  unconfirmed:
    'The broadcast may have been created. It is not created again with this idempotency key: check the broadcasts in the dashboard.',
  reused:
    'This idempotency key was used for another broadcast. Nothing was sent.',
};

const conflict = (
  code: Extract<
    ApiErrorCode,
    'idempotency_key_reused' | 'in_progress' | 'delivery_unconfirmed'
  >,
  message: string,
  headers?: Record<string, string>
) => new ApiError(code, message, 409, headers);

const inProgress = (kind: KeyKind) =>
  conflict('in_progress', kind.inProgress, { 'Retry-After': '5' });

const unconfirmed = (kind: KeyKind) =>
  conflict('delivery_unconfirmed', kind.unconfirmed);

export const deliveryUnconfirmed = () => unconfirmed(MESSAGE);
export const broadcastUnconfirmed = () => unconfirmed(BROADCAST);

/**
 * The request's key: the `Idempotency-Key` header or the body's
 * `idempotency_key`, or null without one. An unusable key is refused: a
 * caller who meant to be protected is never sent unprotected.
 */
export function readIdempotencyKey(
  header: string | null,
  field: unknown
): string | null {
  const given = [header ?? undefined, field ?? undefined].filter(
    (v) => v !== undefined
  );
  if (given.length === 0) return null;
  const keys = given.map((v) => (typeof v === 'string' ? v.trim() : ''));
  if (keys.some((k) => !/^[\x20-\x7e]{1,200}$/.test(k))) {
    throw badRequest(
      'The idempotency key must be 1 to 200 printable ASCII characters'
    );
  }
  if (keys.some((k) => k !== keys[0])) {
    throw badRequest(
      "The Idempotency-Key header and 'idempotency_key' are different"
    );
  }
  return keys[0];
}

/** The same request whatever the order of its fields; the key is not part of it. */
export function hashRequest(body: Record<string, unknown>): string {
  const rest = { ...body };
  delete rest.idempotency_key;
  const canonical = JSON.stringify(rest, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))
        )
      : value
  );
  return createHash('sha256').update(canonical).digest('hex');
}

/** `Link` ties the row to the customer it is about; a broadcast has none. */
interface KeyClaim<Link, Answer> {
  /** Whose claim it is; asked right before the gateway. Throws when lost. */
  handOver(contactId: Link): Promise<void>;
  settle(
    outcome:
      | { state: 'sent'; contactId: Link; answer: Answer }
      | { state: 'failed' | 'unconfirmed' }
  ): Promise<void>;
}
export type MessageClaim = KeyClaim<string, SentMessageAnswer>;
export type BroadcastClaim = KeyClaim<null, BroadcastAnswer>;

interface KeyRow<Answer> {
  id: string;
  state: 'claimed' | 'sent' | 'failed' | 'unconfirmed';
  request_hash: string;
  claim_token: string;
  claimed_at: string;
  response: Answer | null;
}

function unread(what: string, error: unknown): ApiError {
  console.error(`[api/v1/message-keys] ${what}:`, error);
  return unavailable();
}

/**
 * Claim the key, or answer the request that had it: `replay` when it was
 * sent. Throws 409 (`idempotency_key_reused`, `in_progress`,
 * `delivery_unconfirmed`) or 503; nothing was sent by this request.
 */
export async function claimMessageKey(
  db: SupabaseClient,
  owner: { accountId: string; keyId: string },
  key: string,
  requestHash: string
): Promise<{ claim: MessageClaim } | { replay: SentMessageAnswer }> {
  return claimKey<string, SentMessageAnswer>(
    MESSAGE,
    db,
    owner,
    key,
    requestHash
  );
}

/**
 * {@link claimMessageKey} for a broadcast: `replay` answers the campaign
 * the first request created. Its keys are stored under a prefix no
 * caller's key can hold (`readIdempotencyKey` takes ASCII only), so a key
 * also used for a message is a key of its own; hashed, so the longest one
 * still fits the column.
 */
export async function claimBroadcastKey(
  db: SupabaseClient,
  owner: { accountId: string; keyId: string },
  key: string,
  requestHash: string
): Promise<{ claim: BroadcastClaim } | { replay: BroadcastAnswer }> {
  const hashed = createHash('sha256').update(key).digest('hex');
  return claimKey<null, BroadcastAnswer>(
    BROADCAST,
    db,
    owner,
    `broadcast§${hashed}`,
    requestHash
  );
}

async function claimKey<Link, Answer>(
  kind: KeyKind,
  db: SupabaseClient,
  owner: { accountId: string; keyId: string },
  key: string,
  requestHash: string
): Promise<{ claim: KeyClaim<Link, Answer> } | { replay: Answer }> {
  const token = randomUUID();
  const claimedAt = new Date().toISOString();

  const { data: inserted, error } = await db
    .from(TABLE)
    .insert({
      account_id: owner.accountId,
      api_key_id: owner.keyId,
      key,
      request_hash: requestHash,
      claim_token: token,
      claimed_at: claimedAt,
    })
    .select('id')
    .single();
  if (inserted) return { claim: keyClaim(kind, db, inserted.id, token) };
  if (!isUniqueViolation(error)) throw unread('claim', error);

  const { data, error: readError } = await db
    .from(TABLE)
    .select('id, state, request_hash, claim_token, claimed_at, response')
    .eq('account_id', owner.accountId)
    .eq('api_key_id', owner.keyId)
    .eq('key', key)
    .maybeSingle();
  if (readError || !data) throw unread('read', readError);
  const row = data as KeyRow<Answer>;

  if (row.request_hash !== requestHash) {
    throw conflict('idempotency_key_reused', kind.reused);
  }
  if (row.state === 'sent' && row.response) return { replay: row.response };
  if (row.state === 'unconfirmed') throw unconfirmed(kind);

  // Compare-and-set: of two requests that read the same row, one wins.
  const takeOver = async (fields: Record<string, unknown>) => {
    const { data: taken, error: takeError } = await db
      .from(TABLE)
      .update(fields)
      .eq('id', row.id)
      .eq('state', row.state)
      .eq('claim_token', row.claim_token)
      .eq('claimed_at', row.claimed_at)
      .select('id');
    if (takeError) throw unread('take over', takeError);
    return Boolean(taken && taken.length > 0);
  };

  if (row.state === 'failed') {
    if (
      await takeOver({
        state: 'claimed',
        claim_token: token,
        claimed_at: claimedAt,
      })
    ) {
      return { claim: keyClaim(kind, db, row.id, token) };
    }
    throw inProgress(kind);
  }

  const age = Date.now() - new Date(row.claimed_at).getTime();
  if (age > kind.staleMs && (await takeOver({ state: 'unconfirmed' }))) {
    throw unconfirmed(kind);
  }
  throw inProgress(kind);
}

function keyClaim<Link, Answer>(
  kind: KeyKind,
  db: SupabaseClient,
  id: string,
  token: string
): KeyClaim<Link, Answer> {
  return {
    async handOver(contactId) {
      // The stale time runs from here. A claim already called unconfirmed
      // is not sent after all: its caller may have sent it another way.
      const { data, error } = await db
        .from(TABLE)
        .update({ claimed_at: new Date().toISOString(), contact_id: contactId })
        .eq('id', id)
        .eq('claim_token', token)
        .eq('state', 'claimed')
        .select('id');
      if (error) throw unread('hand over', error);
      if (!data || data.length === 0) throw unconfirmed(kind);
    },

    async settle(outcome) {
      const fields: Record<string, unknown> =
        outcome.state === 'sent'
          ? {
              state: 'sent',
              contact_id: outcome.contactId,
              message_id:
                (outcome.answer as { message_id?: string | null }).message_id ??
                null,
              response: outcome.answer,
            }
          : { state: outcome.state };
      // Retried once: an outcome that is not stored leaves the claim to go
      // stale, and stale is unconfirmed, never sent again.
      for (let attempt = 1; attempt <= 2; attempt++) {
        const { error } = await db
          .from(TABLE)
          .update(fields)
          .eq('id', id)
          .eq('claim_token', token)
          // Called unconfirmed meanwhile: only a delivery knows better. A
          // `failed` would reopen a key its caller was told is spent.
          .in(
            'state',
            outcome.state === 'sent' ? ['claimed', 'unconfirmed'] : ['claimed']
          );
        if (!error) return;
        console.error('[api/v1/message-keys] settle:', error);
      }
    },
  };
}

/** Forget keys older than MESSAGE_KEY_DAYS. Throws on failure; before 305, nothing. */
export async function purgeMessageKeys(db: SupabaseClient): Promise<void> {
  const before = new Date(Date.now() - MESSAGE_KEY_DAYS * 86_400_000);
  const { error } = await db
    .from(TABLE)
    .delete()
    .lt('created_at', before.toISOString());
  if (error && !['PGRST205', '42P01'].includes(error.code ?? '')) {
    throw new Error(`v1_message_keys purge failed: ${error.message}`);
  }
}
