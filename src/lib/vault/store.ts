/**
 * Ported from wacrm module 019c (vault), reference package 2026-10-18 (src/vault/store.ts, `PgVaultStore`), moved from
 * node-postgres to supabase-js RPC. Store for the sensitive-value vault (migration 121) on the service-role client,
 * which has no table privileges: every call goes through a vault_* function. The database never sees a plaintext or a
 * key. `account` everywhere is the wacrm account id (the reference's workspace).
 *   put(account, kind, value, subject, actor)  normalise (crypto.ts) -> blind index of the normalised value ->
 *       AES-256-GCM of the normalised value under the current key with AAD 'account|kind|blind_index' -> vault_put.
 *       Returns { token, deduped }; a dedupe returns the live item's token and stores nothing. A DENIED put throws
 *       VaultPutDeniedError; a database error (or an answer that is neither OK nor DENIED) throws VaultPutFailedError.
 *       Both carry a fixed message and nothing else: no value, cause, code or database text (PostgREST's message and
 *       details can echo the failing row).
 *   reveal(actor, account, token, reason)  vault_reveal (role, reason, rate limit, audit all in the DB) -> decrypt with
 *       the row's recorded key id and AAD 'account|row kind|row blind_index' (a payload copied from another item fails).
 *       { ok: true, kind, value } or { ok: false, status }: DENIED | NOT_FOUND | RATE_LIMITED from the DB, or
 *       DECRYPT_FAILED (tampered or swapped row, unknown key, malformed bytea). A decrypt failure never throws and
 *       carries no detail; it is reported to vault_reveal_failed best effort (that call's failure is swallowed).
 *   delete / bootstrap / grant / revoke  vault_delete / vault_role_*: the status text, passed through.
 *   rewrap(actor, account, tokens, oldKeyId)  key rotation for the listed tokens over keyset pages of
 *       vault_rewrap_candidates; see the method.
 *   auditList(actor, account, limit?)  vault_audit_list, newest first (zero rows for a caller with no vault role).
 *
 * bytea over PostgREST: sent as Postgres hex input ('\x' + hex) and read back as the same '\x...' text; anything else
 * read back counts as a malformed payload (DECRYPT_FAILED), never an exception out of reveal.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  MIN_BLIND_KEY_BYTES,
  VAULT_KINDS,
  VaultCryptoError,
  blindIndex,
  decrypt,
  encrypt,
  normalise,
  vaultAad,
  type EncryptedPayload,
  type KeyProvider,
  type VaultKind,
} from './crypto';
import type { TokenVault } from './tokenize';
import type { VaultSubject } from './types';

export type RevealResult =
  | { readonly ok: true; readonly kind: VaultKind; readonly value: string }
  | {
      readonly ok: false;
      readonly status:
        'DENIED' | 'NOT_FOUND' | 'RATE_LIMITED' | 'DECRYPT_FAILED';
    };

/** vault_put returned DENIED (audited there). Fixed message: no value, no subject, no database text. */
export class VaultPutDeniedError extends Error {
  override readonly name = 'VaultPutDeniedError';
  constructor() {
    super('vault: put denied');
  }
}

/**
 * vault_put failed in the database (e.g. a CHECK violation). Fixed message, no cause, no code, no detail: the error's
 * message and details can echo the failing row (ciphertext, iv, tag, blind index) and must never reach a log.
 */
export class VaultPutFailedError extends Error {
  override readonly name = 'VaultPutFailedError';
  constructor() {
    super('vault: put failed');
  }
}

/** vault_rewrap_candidates failed in the database. Fixed message, no cause, no code, no detail. */
export class VaultRewrapFailedError extends Error {
  override readonly name = 'VaultRewrapFailedError';
  constructor() {
    super('vault: rewrap failed');
  }
}

/**
 * Any other vault_* call failed (reveal, delete, roles, audit list) or answered in an unexpected shape. The message
 * names only the function; `code` is the Postgres SQLSTATE (null for a shape error), never the database text.
 */
export class VaultStoreError extends Error {
  override readonly name = 'VaultStoreError';
  constructor(
    fn: string,
    readonly code: string | null
  ) {
    super(`vault: ${fn} failed`);
  }
}

export type DeleteStatus = 'OK' | 'DENIED' | 'NOT_FOUND';
export type RoleStatus = 'OK' | 'NOOP' | 'DENIED';
export type VaultRole = 'admin' | 'super_admin';
/** ERROR: the vault_rewrap call for this one item failed in the database; the item is left as it was and the batch
 * continues. Token and status only: no error text, code or cause. */
export type RewrapItemStatus =
  | 'OK'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'DENIED'
  | 'DECRYPT_FAILED'
  | 'NOT_CANDIDATE'
  | 'ERROR';

export interface RewrapResult {
  /** DENIED: the actor is not a super_admin of the account (candidates refused); nothing was rewrapped. */
  readonly status: 'OK' | 'DENIED';
  readonly items: ReadonlyArray<{
    readonly token: string;
    readonly status: RewrapItemStatus;
  }>;
}

/** One vault_audit row (the audit never holds a value, blind index or ciphertext). */
export interface VaultAuditRow {
  /** bigint identity, as text. */
  readonly id: string;
  readonly at: Date;
  readonly action: string;
  readonly outcome: string;
  readonly actor: string;
  readonly accountId: string;
  readonly token: string | null;
  readonly kind: string | null;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly reason: string | null;
  readonly detail: Record<string, unknown>;
}

/** vault_rewrap_candidates p_limit upper bound. */
export const REWRAP_PAGE = 500;

type Row = Record<string, unknown>;

const HEX_BYTEA = /^\\x(?:[0-9a-fA-F]{2})*$/;

/** Postgres hex input format for a bytea argument. */
export function toBytea(buf: Buffer): string {
  return '\\x' + buf.toString('hex');
}

/** A bytea read back through PostgREST ('\x' + hex). Anything else throws a fixed VaultCryptoError. */
export function fromBytea(v: unknown): Buffer {
  if (typeof v !== 'string' || !HEX_BYTEA.test(v))
    throw new VaultCryptoError('vault: malformed payload');
  return Buffer.from(v.slice(2), 'hex');
}

/** A table function's first row (PostgREST answers an array; a single object is accepted too). */
function firstRow(data: unknown): Row | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row !== null && typeof row === 'object' ? (row as Row) : null;
}

function rowKind(v: unknown): VaultKind {
  if (!VAULT_KINDS.includes(v as VaultKind))
    throw new VaultCryptoError('vault: malformed payload');
  return v as VaultKind;
}

function rowText(v: unknown): string {
  if (typeof v !== 'string')
    throw new VaultCryptoError('vault: malformed payload');
  return v;
}

/** Decrypts a vault row (from vault_reveal or vault_rewrap_candidates) with the AAD of its own kind and blind index. */
function decryptRow(
  r: Row,
  account: string,
  keys: KeyProvider
): { kind: VaultKind; aad: Buffer; plain: string } {
  const kind = rowKind(r.kind);
  const aad = vaultAad(account, kind, rowText(r.blind_index));
  const payload: EncryptedPayload = {
    ciphertext: fromBytea(r.ciphertext),
    iv: fromBytea(r.iv),
    tag: fromBytea(r.auth_tag),
    keyId: rowText(r.key_id),
  };
  return { kind, aad, plain: decrypt(payload, keys, aad) };
}

const REVEAL_REFUSALS = ['DENIED', 'NOT_FOUND', 'RATE_LIMITED'] as const;
const DELETE_STATUSES: readonly DeleteStatus[] = ['OK', 'DENIED', 'NOT_FOUND'];
const ROLE_STATUSES: readonly RoleStatus[] = ['OK', 'NOOP', 'DENIED'];
const REWRAP_STATUSES: readonly RewrapItemStatus[] = [
  'OK',
  'DENIED',
  'NOT_FOUND',
  'CONFLICT',
];

const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

export class VaultStore implements TokenVault {
  constructor(
    private readonly db: SupabaseClient,
    private readonly keys: KeyProvider,
    private readonly blindKey: Buffer
  ) {
    if (!Buffer.isBuffer(blindKey) || blindKey.length < MIN_BLIND_KEY_BYTES)
      throw new VaultCryptoError('vault: invalid blind key');
  }

  /** The RPC's data; a database error becomes a VaultStoreError carrying the SQLSTATE only. */
  private async call(fn: string, args: Row): Promise<unknown> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) throw new VaultStoreError(fn, error.code ?? null);
    return data;
  }

  /** A scalar status function's answer, checked against its allowed values. */
  private async status<T extends string>(
    fn: string,
    args: Row,
    allowed: readonly T[]
  ): Promise<T> {
    const data = await this.call(fn, args);
    if (!allowed.includes(data as T)) throw new VaultStoreError(fn, null);
    return data as T;
  }

  async put(
    account: string,
    kind: VaultKind,
    value: string,
    subject: VaultSubject,
    actor: string
  ): Promise<{ token: string; deduped: boolean }> {
    const norm = normalise(kind, value);
    const index = blindIndex(account, kind, norm, this.blindKey);
    const enc = encrypt(norm, this.keys, vaultAad(account, kind, index));
    let row: Row | null;
    try {
      const { data, error } = await this.db.rpc('vault_put', {
        p_actor: actor,
        p_account: account,
        p_kind: kind,
        p_ciphertext: toBytea(enc.ciphertext),
        p_iv: toBytea(enc.iv),
        p_auth_tag: toBytea(enc.tag),
        p_key_id: enc.keyId,
        p_blind_index: index,
        p_subject_type: subject.type,
        p_subject_id: subject.id,
      });
      if (error) throw new VaultPutFailedError();
      row = firstRow(data);
    } catch {
      throw new VaultPutFailedError();
    }
    if (row?.status === 'DENIED') throw new VaultPutDeniedError();
    if (row?.status !== 'OK' || typeof row.token !== 'string')
      throw new VaultPutFailedError();
    return { token: row.token, deduped: row.deduped === true };
  }

  async reveal(
    actor: string,
    account: string,
    token: string,
    reason: string | null
  ): Promise<RevealResult> {
    const row = firstRow(
      await this.call('vault_reveal', {
        p_actor: actor,
        p_account: account,
        p_token: token,
        p_reason: reason,
      })
    );
    if (!row) throw new VaultStoreError('vault_reveal', null);
    const refusal = REVEAL_REFUSALS.find((s) => s === row.status);
    if (refusal) return { ok: false, status: refusal };
    if (row.status !== 'OK') throw new VaultStoreError('vault_reveal', null);
    try {
      const { kind, plain } = decryptRow(row, account, this.keys);
      return { ok: true, kind, value: plain };
    } catch {
      // Best effort: the payload is never passed, only who / where / which token.
      try {
        await this.db.rpc('vault_reveal_failed', {
          p_actor: actor,
          p_account: account,
          p_token: token,
        });
      } catch {
        // the audit of the failure is best effort; the caller still gets DECRYPT_FAILED
      }
      return { ok: false, status: 'DECRYPT_FAILED' };
    }
  }

  delete(
    actor: string,
    account: string,
    token: string,
    reason: string | null
  ): Promise<DeleteStatus> {
    return this.status(
      'vault_delete',
      { p_actor: actor, p_account: account, p_token: token, p_reason: reason },
      DELETE_STATUSES
    );
  }

  /** The first vault super_admin of an account (DENIED once any live role exists there). */
  bootstrap(
    actor: string,
    account: string,
    userId: string
  ): Promise<RoleStatus> {
    return this.status(
      'vault_role_bootstrap',
      { p_actor: actor, p_account: account, p_user: userId },
      ROLE_STATUSES
    );
  }

  grant(
    actor: string,
    account: string,
    userId: string,
    role: VaultRole
  ): Promise<RoleStatus> {
    return this.status(
      'vault_role_grant',
      { p_actor: actor, p_account: account, p_user: userId, p_role: role },
      ROLE_STATUSES
    );
  }

  revoke(
    actor: string,
    account: string,
    userId: string,
    role: VaultRole
  ): Promise<RoleStatus> {
    return this.status(
      'vault_role_revoke',
      { p_actor: actor, p_account: account, p_user: userId, p_role: role },
      ROLE_STATUSES
    );
  }

  /** The account's audit rows, newest first; the database clamps limit to 1..500 (default 100). */
  async auditList(
    actor: string,
    account: string,
    limit?: number
  ): Promise<VaultAuditRow[]> {
    const data = await this.call('vault_audit_list', {
      p_actor: actor,
      p_account: account,
      p_limit: limit ?? 100,
    });
    if (!Array.isArray(data))
      throw new VaultStoreError('vault_audit_list', null);
    return (data as Row[]).map((r) => ({
      id: String(r.id),
      at: new Date(String(r.at)),
      action: String(r.action),
      outcome: String(r.outcome),
      actor: String(r.actor),
      accountId: String(r.account_id),
      token: str(r.token),
      kind: str(r.kind),
      subjectType: str(r.subject_type),
      subjectId: str(r.subject_id),
      reason: str(r.reason),
      detail:
        r.detail !== null && typeof r.detail === 'object'
          ? (r.detail as Record<string, unknown>)
          : {},
    }));
  }

  /**
   * Key rotation for the listed tokens. Keyset pages over the live items still under oldKeyId, in (created_at, id)
   * order: each page starts after the last row of the previous one, so rows that stay (DECRYPT_FAILED, unwanted) are
   * never re-read and rows that rewrap cannot shift the window. Stops once every listed token is seen or a page is
   * short. Each wanted candidate is decrypted with its recorded key, re-encrypted under the current key (same AAD: the
   * blind index is immutable) and swapped by vault_rewrap with the recorded key id as the expected one. CONFLICT (a
   * concurrent rewrap / delete won) is reported, never retried; a listed token never seen is NOT_CANDIDATE.
   */
  async rewrap(
    actor: string,
    account: string,
    tokens: readonly string[],
    oldKeyId: string
  ): Promise<RewrapResult> {
    if (oldKeyId === this.keys.currentKeyId())
      throw new RangeError('vault: oldKeyId is the current key');
    const wanted = new Set(tokens);
    const done = new Map<string, RewrapItemStatus>();
    // The timestamptz cursor travels as PostgREST's text, untouched: a JS Date would drop its microseconds.
    let after: [string | null, string | null] = [null, null];
    for (;;) {
      if (done.size === wanted.size) break;
      let page: Row[];
      try {
        const { data, error } = await this.db.rpc('vault_rewrap_candidates', {
          p_actor: actor,
          p_account: account,
          p_old_key_id: oldKeyId,
          p_limit: REWRAP_PAGE,
          p_after_created_at: after[0],
          p_after_id: after[1],
        });
        if (error || !Array.isArray(data)) throw new VaultRewrapFailedError();
        page = data as Row[];
      } catch {
        throw new VaultRewrapFailedError();
      }
      if (page.length === 1 && page[0]?.status === 'DENIED')
        return { status: 'DENIED', items: [] };
      for (const c of page) {
        const token = c.token;
        if (typeof token !== 'string' || !wanted.has(token) || done.has(token))
          continue;
        done.set(token, await this.rewrapOne(actor, account, token, c));
      }
      if (page.length < REWRAP_PAGE) break;
      const last = page[page.length - 1]!;
      if (typeof last.created_at !== 'string' || typeof last.id !== 'string')
        throw new VaultRewrapFailedError();
      after = [last.created_at, last.id];
    }
    return {
      status: 'OK',
      items: [...wanted].map((token) => ({
        token,
        status: done.get(token) ?? 'NOT_CANDIDATE',
      })),
    };
  }

  private async rewrapOne(
    actor: string,
    account: string,
    token: string,
    c: Row
  ): Promise<RewrapItemStatus> {
    let enc: EncryptedPayload;
    try {
      const { aad, plain } = decryptRow(c, account, this.keys);
      enc = encrypt(plain, this.keys, aad);
    } catch {
      // Best effort: the payload is never passed, only who / where / which token / which key.
      try {
        await this.db.rpc('vault_rewrap_failed', {
          p_actor: actor,
          p_account: account,
          p_token: token,
          p_key_id: str(c.key_id),
        });
      } catch {
        // the audit of the failure is best effort; the caller still gets DECRYPT_FAILED
      }
      return 'DECRYPT_FAILED';
    }
    try {
      const { data, error } = await this.db.rpc('vault_rewrap', {
        p_actor: actor,
        p_account: account,
        p_token: token,
        p_expected_key_id: c.key_id,
        p_ciphertext: toBytea(enc.ciphertext),
        p_iv: toBytea(enc.iv),
        p_auth_tag: toBytea(enc.tag),
        p_new_key_id: enc.keyId,
      });
      if (error) return 'ERROR';
      return REWRAP_STATUSES.includes(data as RewrapItemStatus)
        ? (data as RewrapItemStatus)
        : 'ERROR';
    } catch {
      // One item's failure does not abandon the batch; the error itself is dropped (it can carry row data).
      return 'ERROR';
    }
  }
}
