// ============================================================
// Idempotency-Key on POST /api/v1/messages (migration 305).
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

const conflict = (
  code: Extract<
    ApiErrorCode,
    'idempotency_key_reused' | 'in_progress' | 'delivery_unconfirmed'
  >,
  message: string,
  headers?: Record<string, string>
) => new ApiError(code, message, 409, headers);

const inProgress = () =>
  conflict(
    'in_progress',
    'A request with this idempotency key is being sent. Retry later with the same key.',
    { 'Retry-After': '5' }
  );

export const deliveryUnconfirmed = () =>
  conflict(
    'delivery_unconfirmed',
    'The message may have reached the customer. It is not sent again with this idempotency key.'
  );

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

export interface MessageClaim {
  /** Whose claim it is; asked right before the gateway. Throws when lost. */
  handOver(contactId: string): Promise<void>;
  settle(
    outcome:
      | { state: 'sent'; contactId: string; answer: SentMessageAnswer }
      | { state: 'failed' | 'unconfirmed' }
  ): Promise<void>;
}

interface KeyRow {
  id: string;
  state: 'claimed' | 'sent' | 'failed' | 'unconfirmed';
  request_hash: string;
  claim_token: string;
  claimed_at: string;
  response: SentMessageAnswer | null;
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
  if (inserted) return { claim: messageClaim(db, inserted.id, token) };
  if (!isUniqueViolation(error)) throw unread('claim', error);

  const { data, error: readError } = await db
    .from(TABLE)
    .select('id, state, request_hash, claim_token, claimed_at, response')
    .eq('account_id', owner.accountId)
    .eq('api_key_id', owner.keyId)
    .eq('key', key)
    .maybeSingle();
  if (readError || !data) throw unread('read', readError);
  const row = data as KeyRow;

  if (row.request_hash !== requestHash) {
    throw conflict(
      'idempotency_key_reused',
      'This idempotency key was used for another message. Nothing was sent.'
    );
  }
  if (row.state === 'sent' && row.response) return { replay: row.response };
  if (row.state === 'unconfirmed') throw deliveryUnconfirmed();

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
      return { claim: messageClaim(db, row.id, token) };
    }
    throw inProgress();
  }

  const age = Date.now() - new Date(row.claimed_at).getTime();
  if (age > STALE_CLAIM_MS && (await takeOver({ state: 'unconfirmed' }))) {
    throw deliveryUnconfirmed();
  }
  throw inProgress();
}

function messageClaim(
  db: SupabaseClient,
  id: string,
  token: string
): MessageClaim {
  return {
    async handOver(contactId) {
      // The two minutes run from here. A claim already called unconfirmed
      // is not sent after all: its caller may have sent it another way.
      const { data, error } = await db
        .from(TABLE)
        .update({ claimed_at: new Date().toISOString(), contact_id: contactId })
        .eq('id', id)
        .eq('claim_token', token)
        .eq('state', 'claimed')
        .select('id');
      if (error || !data || data.length === 0) {
        throw unread('hand over', error ?? 'the claim was lost');
      }
    },

    async settle(outcome) {
      const fields: Record<string, unknown> =
        outcome.state === 'sent'
          ? {
              state: 'sent',
              contact_id: outcome.contactId,
              message_id: outcome.answer.message_id,
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
          // Called unconfirmed meanwhile: this request knows better.
          .in('state', ['claimed', 'unconfirmed']);
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
