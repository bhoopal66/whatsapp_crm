/**
 * Ported from wacrm module 019b (CRM memory), reference package 2026-10-18 (src/memory/store.ts, `PgMemoryStore`),
 * moved from node-postgres to supabase-js RPC. Store for CRM memory (migration 129) on the service-role client, which
 * has no table privileges: every write goes through memory_put, every read through the ACL-joined memory_* functions.
 * `accountId` everywhere is the wacrm account id (the reference's workspace); scope ids are uuids.
 *   put(accountId, scope, content, opts)  redact FIRST (redact.ts): a refusal stores nothing. Redacted text that is
 *       blank or over 4000 code points is refused (refused 'EMPTY' / 'TOO_LONG') before any DB call; raw content over
 *       MAX_RAW_CHARS code points is refused 'TOO_LONG' before redaction (redaction cost grows with length). The stored
 *       content and the dedupe hash are of the redacted text only (hash = sha256 of NFKC -> Arabic-Indic digits folded
 *       -> lowercase -> whitespace collapsed). trust 'verified' needs a HumanOrigin minted here by
 *       humanOriginFromChannel for the same account; anything else is stored 'untrusted' with importance capped at 2.
 *       An embedding is computed only when the store was built with embedExternal: true and an embedder, only from the
 *       redacted text, under a timeout; any failure stores no embedding and the put still succeeds. memory_put's
 *       SCOPE_INVALID / SUPERSEDE_VERIFIED refusals (error hint) come back as typed refusals.
 *   recall(userId, accountId, query, limit)  memory_recall_candidates with the search TEXT (the SQL folds digits and
 *       parses it with websearch_to_tsquery; blank -> no text filter): rows of the scopes the user may read, in SQL
 *       order. Read-only: nothing is bumped or audited.
 *   recallForPrompt(userId, accountId, query, opts)  recall (pool of 100) -> rankRecall -> memory_mark_recalled with
 *       ONLY the selected ids (called with an empty list too, so every prompt recall is audited) -> renderMemories.
 *   list / canRead  memory_list / memory_can_read for one scope.
 *   forget(actor, accountId, scope, reason) / expireDue(actor)  memory_forget / memory_expire_due, audited in the DB.
 *       The forget reason is redacted before the call (refused / blank -> "[REDACTED]"); a missing, blank or
 *       over-MAX_FORGET_REASON_CHARS reason is rejected (RangeError) before redaction.
 * Any other database error throws MemoryStoreError, whose message names only the function (PostgREST's message and
 * details can echo the failing row, i.e. memory content).
 * Not ported yet: compactScope (memory_compact_candidates / memory_compact_apply).
 */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { rankRecall } from './rank';
import { foldDigits, redact, type RedactResult } from './redact';
import { renderMemories } from './render';

export type ScopeType = 'case' | 'contact' | 'workspace';
export type MemoryKind =
  'fact' | 'preference' | 'decision' | 'document' | 'summary';
export type MemoryTrust = 'untrusted' | 'verified';

export interface MemoryScope {
  readonly type: ScopeType;
  /** A uuid: the case, the contact, or (type 'workspace') the account itself. */
  readonly id: string;
}

/** Highest importance an untrusted item may carry (check memory_items_untrusted_importance). */
export const UNTRUSTED_MAX_IMPORTANCE = 2;
export const DEFAULT_MAX_ITEMS = 500;
export const DEFAULT_EMBED_TIMEOUT_MS = 2000;
/** Audit reason used by forget when the redacted reason is refused or blank. */
export const FORGET_REASON_PLACEHOLDER = '[REDACTED]';
/** Longest stored content in code points (check memory_items.content: char_length(btrim(content)) between 1 and 4000). */
export const MAX_CONTENT_CHARS = 4000;
/** Longest raw put content in code points accepted for redaction; longer is refused TOO_LONG before redact runs. */
export const MAX_RAW_CHARS = 16000;
/** Longest forget reason in code points; longer is rejected (RangeError) before redact runs. */
export const MAX_FORGET_REASON_CHARS = 1000;
/** Candidates fetched before ranking (memory_recall_candidates returns at most 100). */
export const RECALL_POOL = 100;

// ---- human origin (local to memory; an origin minted elsewhere is not accepted) ----------------------------------
declare const MEMORY_HUMAN: unique symbol;
/** Proof that a write comes from an authenticated human channel. Only humanOriginFromChannel creates one. */
export interface HumanOrigin {
  readonly origin: 'human';
  readonly userId: string;
  /** The wacrm account id. */
  readonly workspaceId: string;
  readonly channel: string;
  readonly [MEMORY_HUMAN]: true;
}
const minted = new WeakSet<object>();

/** Called by the application layer from its authenticated channel handler, never from the assistant's tool-call path. */
export function humanOriginFromChannel(session: {
  userId: string;
  workspaceId: string;
  channel: string;
}): HumanOrigin {
  if (!session.userId || !session.workspaceId)
    throw new TypeError(
      'humanOriginFromChannel: an authenticated user and workspace are required'
    );
  const o = Object.freeze({
    origin: 'human' as const,
    userId: session.userId,
    workspaceId: session.workspaceId,
    channel: session.channel,
  });
  minted.add(o);
  return o as unknown as HumanOrigin;
}
const isMintedFor = (o: unknown, accountId: string): o is HumanOrigin =>
  typeof o === 'object' &&
  o !== null &&
  minted.has(o) &&
  (o as { origin?: unknown }).origin === 'human' &&
  (o as { workspaceId?: unknown }).workspaceId === accountId;

// ---- embedding ---------------------------------------------------------------------------------------------------
/** Injected embedding provider. The store holds no network code; the provider is only ever given redacted text. */
export interface Embedder {
  readonly model: string;
  embed(text: string, signal: AbortSignal): Promise<readonly number[]>;
}

export interface MemoryStoreOptions {
  /** Per-scope item cap passed to memory_put (1..10000). */
  maxItems?: number;
  /** External embedding is off unless this is true AND an embedder is given. */
  embedExternal?: boolean;
  embedder?: Embedder;
  embedTimeoutMs?: number;
}

export interface PutOptions {
  importance: number;
  trust: MemoryTrust;
  origin?: HumanOrigin;
  kind?: MemoryKind;
  sourceType: string;
  sourceId?: string | null;
  /** The profile / auth user id that wrote it; null for a system write. */
  createdBy: string | null;
  /** A live item of the same scope this one corrects. */
  supersedes?: string | null;
}

export type PutResult =
  | {
      readonly ok: true;
      readonly id: string;
      readonly deduped: boolean;
      readonly evicted: number;
      readonly trust: MemoryTrust;
      readonly importance: number;
    }
  /** Redaction refused the content. */
  | { readonly ok: false; readonly refused: true; readonly reason: string }
  /** Checked on the redacted text before any DB call: over MAX_CONTENT_CHARS, or blank. */
  | {
      readonly ok: false;
      readonly refused: 'TOO_LONG' | 'EMPTY';
      readonly reason: string;
    }
  /** memory_put refused: an untrusted write named (or deduped onto) a verified item / the scope does not belong to the account. */
  | {
      readonly ok: false;
      readonly refused: 'SUPERSEDE_VERIFIED' | 'SCOPE_INVALID';
      readonly reason: string;
    };

export interface RecalledItem {
  id: string;
  scopeType: ScopeType;
  scopeId: string;
  kind: MemoryKind;
  content: string;
  importance: number;
  trust: MemoryTrust;
  sourceType: string;
  createdAt: Date;
  lastRecalledAt: Date | null;
  embedding: number[] | null;
  rank: number;
}

export interface ListedItem {
  id: string;
  kind: MemoryKind;
  content: string;
  importance: number;
  trust: MemoryTrust;
  sourceType: string;
  sourceId: string | null;
  createdBy: string | null;
  createdAt: Date;
  expiresAt: Date;
  recallCount: number;
  lastRecalledAt: Date | null;
}

export interface ListOptions {
  /** Default 50 (memory_list's own default). */
  limit?: number;
  /** Keyset page: items created before this instant. */
  before?: Date | null;
}

export interface RecallForPromptOptions {
  /** Most items to put in the prompt. */
  limit: number;
  /** Token budget for the items' content (ceil(chars / 4) each); the block's header, notice and markers are not counted. */
  tokenBudget: number;
  /** Embedding of the query, for the cosine component of the ranking. */
  queryEmbedding?: readonly number[] | null;
  now?: Date;
}

export interface PromptRecall {
  /** renderMemories output: the delimited untrusted-data block, "" when no item is selected. */
  readonly text: string;
  /** The selected items, best first (the only ones marked recalled). */
  readonly items: RecalledItem[];
}

/**
 * A memory_* call failed in the database or answered in an unexpected shape. The message names only the function;
 * `code` is the Postgres SQLSTATE (null for a shape error), never the database text, which can echo content.
 */
export class MemoryStoreError extends Error {
  override readonly name = 'MemoryStoreError';
  constructor(
    readonly fn: string,
    readonly code: string | null
  ) {
    super(`memory: ${fn} failed`);
  }
}

/** Dedupe key: sha256 of the normalised REDACTED text. */
export function contentHash(redactedText: string): string {
  const norm = foldDigits(redactedText.normalize('NFKC'))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(norm, 'utf8').digest('hex');
}

type Row = Record<string, unknown>;
type DbError = { code?: string | null; hint?: string | null };

const date = (v: unknown): Date | null =>
  v === null || v === undefined ? null : new Date(String(v));
const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

function toRecalled(x: Row): RecalledItem {
  return {
    id: String(x.id),
    scopeType: x.scope_type as ScopeType,
    scopeId: String(x.scope_id),
    kind: x.kind as MemoryKind,
    content: String(x.content),
    importance: Number(x.importance),
    trust: x.trust as MemoryTrust,
    sourceType: String(x.source_type),
    createdAt: date(x.created_at)!,
    lastRecalledAt: date(x.last_recalled_at),
    embedding: Array.isArray(x.embedding) ? x.embedding.map(Number) : null,
    rank: Number(x.rank ?? 0),
  };
}

function toListed(x: Row): ListedItem {
  return {
    id: String(x.id),
    kind: x.kind as MemoryKind,
    content: String(x.content),
    importance: Number(x.importance),
    trust: x.trust as MemoryTrust,
    sourceType: String(x.source_type),
    sourceId: str(x.source_id),
    createdBy: str(x.created_by),
    createdAt: date(x.created_at)!,
    expiresAt: date(x.expires_at)!,
    recallCount: Number(x.recall_count ?? 0),
    lastRecalledAt: date(x.last_recalled_at),
  };
}

export class MemoryStore {
  constructor(
    private readonly db: SupabaseClient,
    private readonly opts: MemoryStoreOptions = {}
  ) {}

  /** One RPC; the database error comes back as data so a caller can read its hint, never its text. */
  private async call(
    fn: string,
    args: Record<string, unknown>
  ): Promise<{ data: unknown; error: DbError | null }> {
    const { data, error } = await this.db.rpc(fn, args);
    return {
      data,
      error: error ? { code: error.code, hint: error.hint } : null,
    };
  }

  private async rpc(
    fn: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const { data, error } = await this.call(fn, args);
    if (error) throw new MemoryStoreError(fn, error.code ?? null);
    return data;
  }

  private async rows(
    fn: string,
    args: Record<string, unknown>
  ): Promise<Row[]> {
    const data = await this.rpc(fn, args);
    if (!Array.isArray(data)) throw new MemoryStoreError(fn, null);
    return data as Row[];
  }

  private async count(
    fn: string,
    args: Record<string, unknown>
  ): Promise<number> {
    const n = Number(await this.rpc(fn, args));
    if (!Number.isInteger(n)) throw new MemoryStoreError(fn, null);
    return n;
  }

  async put(
    accountId: string,
    scope: MemoryScope,
    content: string,
    opts: PutOptions
  ): Promise<PutResult> {
    if (
      !Number.isInteger(opts.importance) ||
      opts.importance < 1 ||
      opts.importance > 5
    ) {
      throw new RangeError(
        'MemoryStore.put: importance must be an integer 1..5'
      );
    }
    // .length (UTF-16 units) >= code points, so the Array.from count runs only when the cheap check already fails.
    // Redaction cost grows superlinearly with length, so a huge input is refused before redact runs.
    if (typeof content === 'string' && content.length > MAX_RAW_CHARS) {
      const raw = Array.from(content).length;
      if (raw > MAX_RAW_CHARS)
        return {
          ok: false,
          refused: 'TOO_LONG',
          reason: `content is ${raw} chars before redaction (max ${MAX_RAW_CHARS})`,
        };
    }
    const r: RedactResult = redact(content);
    if (!r.ok) return { ok: false, refused: true, reason: r.reason };
    const text = r.text;
    if (text.trim() === '')
      return {
        ok: false,
        refused: 'EMPTY',
        reason: 'content is blank after redaction',
      };
    const chars = Array.from(text.replace(/^ +| +$/g, '')).length;
    if (chars > MAX_CONTENT_CHARS)
      return {
        ok: false,
        refused: 'TOO_LONG',
        reason: `content is ${chars} chars after redaction (max ${MAX_CONTENT_CHARS})`,
      };

    const verified =
      opts.trust === 'verified' && isMintedFor(opts.origin, accountId);
    const trust: MemoryTrust = verified ? 'verified' : 'untrusted';
    const importance = verified
      ? opts.importance
      : Math.min(opts.importance, UNTRUSTED_MAX_IMPORTANCE);

    const embedding = await this.embed(text);
    const { data, error } = await this.call('memory_put', {
      p_account_id: accountId,
      p_scope_type: scope.type,
      p_scope_id: scope.id,
      p_kind: opts.kind ?? 'fact',
      p_content: text,
      p_content_hash: contentHash(text),
      p_importance: importance,
      p_trust: trust,
      p_source_type: opts.sourceType,
      p_source_id: opts.sourceId ?? null,
      p_created_by: opts.createdBy ?? null,
      p_embedding: embedding,
      p_embedding_model: embedding ? this.opts.embedder!.model : null,
      p_supersedes: opts.supersedes ?? null,
      p_max_items: this.opts.maxItems ?? DEFAULT_MAX_ITEMS,
      p_redactions: r.redactions,
    });
    if (error) {
      if (error.hint === 'SUPERSEDE_VERIFIED')
        return {
          ok: false,
          refused: 'SUPERSEDE_VERIFIED',
          reason: 'only a verified write may supersede a verified item',
        };
      if (error.hint === 'SCOPE_INVALID')
        return {
          ok: false,
          refused: 'SCOPE_INVALID',
          reason: 'the scope does not belong to the account',
        };
      throw new MemoryStoreError('memory_put', error.code ?? null);
    }
    const row = (Array.isArray(data) ? data[0] : null) as Row | null;
    if (!row || row.item_id == null)
      throw new MemoryStoreError('memory_put', null);
    // The STORED row's trust and importance: a dedupe keeps the existing row's, whatever this write requested.
    return {
      ok: true,
      id: String(row.item_id),
      deduped: row.deduped === true,
      evicted: Number(row.evicted ?? 0),
      trust: row.item_trust as MemoryTrust,
      importance: Number(row.item_importance),
    };
  }

  /** null unless enabled; null on any failure, timeout or malformed vector (the put goes ahead without one). */
  private async embed(redactedText: string): Promise<number[] | null> {
    const embedder = this.opts.embedder;
    if (this.opts.embedExternal !== true || !embedder) return null;
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          ac.abort();
          resolve(null);
        }, this.opts.embedTimeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS);
      });
      const v = await Promise.race([
        embedder.embed(redactedText, ac.signal),
        timeout,
      ]);
      if (
        !Array.isArray(v) ||
        v.length === 0 ||
        !v.every((x) => typeof x === 'number' && Number.isFinite(x))
      )
        return null;
      return [...v];
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read-only: rows of the scopes the user may read now, in SQL order (rank, importance, recency). */
  async recall(
    userId: string,
    accountId: string,
    query: string | null,
    limit = 20
  ): Promise<RecalledItem[]> {
    const q = query === null || query.trim() === '' ? null : query;
    const rows = await this.rows('memory_recall_candidates', {
      p_user_id: userId,
      p_account_id: accountId,
      p_scope_types: null,
      p_scope_ids: null,
      p_query: q,
      p_limit: limit,
    });
    return rows.map(toRecalled);
  }

  /** Memory for a model prompt. Only the selected items are marked recalled; the mark is audited even when none is. */
  async recallForPrompt(
    userId: string,
    accountId: string,
    query: string | null,
    opts: RecallForPromptOptions
  ): Promise<PromptRecall> {
    const candidates = await this.recall(userId, accountId, query, RECALL_POOL);
    const ranked = rankRecall(candidates, {
      now: opts.now ?? new Date(),
      limit: opts.limit,
      tokenBudget: opts.tokenBudget,
      queryEmbedding: opts.queryEmbedding ?? null,
    });
    const items = ranked.map((r) => r.item);
    await this.count('memory_mark_recalled', {
      p_user_id: userId,
      p_account_id: accountId,
      p_ids: items.map((x) => x.id),
    });
    return { text: renderMemories(items), items };
  }

  /** The live items of one scope, newest first, if the user may read it (zero rows otherwise). */
  async list(
    userId: string,
    accountId: string,
    scope: MemoryScope,
    opts: ListOptions = {}
  ): Promise<ListedItem[]> {
    const rows = await this.rows('memory_list', {
      p_user: userId,
      p_account: accountId,
      p_scope_type: scope.type,
      p_scope_id: scope.id,
      p_limit: opts.limit ?? 50,
      p_before: opts.before ? opts.before.toISOString() : null,
    });
    return rows.map(toListed);
  }

  /** memory_can_read: may this user read this scope of the account right now. */
  async canRead(
    userId: string,
    accountId: string,
    scope: MemoryScope
  ): Promise<boolean> {
    const v = await this.rpc('memory_can_read', {
      p_user: userId,
      p_account: accountId,
      p_scope_type: scope.type,
      p_scope_id: scope.id,
    });
    if (typeof v !== 'boolean')
      throw new MemoryStoreError('memory_can_read', null);
    return v;
  }

  /** Erases every item of one scope (privacy request). Returns the count removed. A missing, blank or whitespace-only
   *  reason, or one over MAX_FORGET_REASON_CHARS code points, is rejected (RangeError) before redaction and erases
   *  nothing. The reason lands in memory_audit, so it is redacted first; a non-blank reason that redaction refuses or
   *  blanks is stored as FORGET_REASON_PLACEHOLDER. */
  async forget(
    actor: string,
    accountId: string,
    scope: MemoryScope,
    reason: string
  ): Promise<number> {
    if (
      reason == null ||
      (typeof reason === 'string' && reason.trim() === '')
    ) {
      throw new RangeError('MemoryStore.forget: reason must not be blank');
    }
    if (
      typeof reason === 'string' &&
      reason.length > MAX_FORGET_REASON_CHARS &&
      Array.from(reason).length > MAX_FORGET_REASON_CHARS
    ) {
      throw new RangeError(
        `MemoryStore.forget: reason must be at most ${MAX_FORGET_REASON_CHARS} chars`
      );
    }
    const r = redact(reason);
    const safeReason =
      r.ok && r.text.trim() !== '' ? r.text : FORGET_REASON_PLACEHOLDER;
    return this.count('memory_forget', {
      p_actor: actor,
      p_account_id: accountId,
      p_scope_type: scope.type,
      p_scope_id: scope.id,
      p_reason: safeReason,
    });
  }

  /** TTL sweep. Returns the count removed. `actor` null = the system. */
  async expireDue(actor: string | null = null): Promise<number> {
    return this.count('memory_expire_due', { p_actor: actor });
  }
}
