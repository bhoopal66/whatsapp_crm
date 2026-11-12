/**
 * Ported from wacrm module 022a (second brain): the BrainStore and
 * VectorIndex adapters over supabase-js. Every call is one SECURITY DEFINER
 * `brain_*` Postgres function on the service role (callers pass
 * `supabaseAdmin()`); the parameter names (`p_account`, ...) are the SQL
 * contract. Absent optionals travel as null.
 *
 * Errors follow lib/cases/store.ts (`fail`): a Postgres error whose `hint`
 * names a known refusal (TEXT_UNREDACTED, NOT_ALLOWED, ...) throws a
 * BrainError carrying it as `reason`; any other error throws a BrainError
 * with `reason: null` and only the SQLSTATE, never the database's text.
 *
 * SupabaseCosineIndex is the VectorIndex without pgvector: vectors are stored
 * as real[] (brain_embedding_put) and brain_search_candidates computes cosine
 * similarity in SQL over the role-visible candidate set, next to the keyword
 * rank.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BRAIN_SOURCE_KINDS,
  type BrainCandidate,
  type BrainItemInput,
  type BrainSourceKind,
  type BrainStore,
  type BrainWriter,
  type ContactMarkKind,
  type ForgetScope,
  type VectorIndex,
  type VectorQuery,
} from './ports';

export type BrainRefusal =
  | 'CASE_NOT_FOUND'
  | 'ITEM_NOT_FOUND'
  | 'TEXT_INVALID'
  | 'TEXT_UNREDACTED'
  | 'KIND_INVALID'
  | 'VEC_INVALID'
  | 'NOT_ALLOWED'
  | 'SCOPE_INVALID'
  | 'HASH_INVALID'
  | 'CONFLICT'
  | 'PAGE_NOT_FOUND';
export const BRAIN_REFUSALS: readonly BrainRefusal[] = [
  'CASE_NOT_FOUND',
  'ITEM_NOT_FOUND',
  'TEXT_INVALID',
  'TEXT_UNREDACTED',
  'KIND_INVALID',
  'VEC_INVALID',
  'NOT_ALLOWED',
  'SCOPE_INVALID',
  'HASH_INVALID',
  'CONFLICT',
  'PAGE_NOT_FOUND',
];
const REFUSALS: ReadonlySet<string> = new Set(BRAIN_REFUSALS);

/** A failed brain RPC: `reason` is the SQL refusal hint, or null for any other error. */
export class BrainError extends Error {
  override readonly name = 'BrainError';
  constructor(
    readonly fn: string,
    readonly reason: BrainRefusal | null,
    readonly code: string | null
  ) {
    super(reason ? `brain refused: ${reason}` : `brain: ${fn} failed`);
  }
}

type DbError = { message?: string; code?: string; hint?: string | null };

export function brainFail(fn: string, error: DbError): never {
  const reason =
    typeof error.hint === 'string' && REFUSALS.has(error.hint)
      ? (error.hint as BrainRefusal)
      : null;
  throw new BrainError(fn, reason, error.code ?? null);
}

async function call(
  db: SupabaseClient,
  fn: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const { data, error } = await db.rpc(fn, args);
  if (error) brainFail(fn, error);
  return data as unknown;
}

type Row = Record<string, unknown>;

/** A scalar result arrives bare, or as a one-key object / one-row array. */
function scalar(data: unknown): unknown {
  const v = Array.isArray(data) ? data[0] : data;
  return v !== null && typeof v === 'object' ? Object.values(v)[0] : v;
}
const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const KINDS: ReadonlySet<string> = new Set(BRAIN_SOURCE_KINDS);

/** One candidate row, or null when it lacks an id, a known kind or a valid date. */
export function parseCandidate(r: Row): BrainCandidate | null {
  const itemId = str(r.item_id);
  const sourceKind = str(r.source_kind);
  const createdAt = new Date(String(r.created_at));
  if (!itemId || !sourceKind || !KINDS.has(sourceKind)) return null;
  if (Number.isNaN(createdAt.getTime())) return null;
  return {
    itemId,
    sourceKind: sourceKind as BrainSourceKind,
    sourceId: str(r.source_id) ?? '',
    caseId: str(r.case_id),
    contactId: str(r.contact_id),
    bankCode: str(r.bank_code),
    text: str(r.text) ?? '',
    aiGenerated: r.ai_generated === true || r.ai_generated === 'true',
    createdAt,
    cosine: num(r.cosine),
    kwRank: num(r.kw_rank),
  };
}

export class SupabaseBrainStore implements BrainStore {
  constructor(private readonly db: SupabaseClient) {}

  async upsert(i: BrainItemInput): Promise<string | null> {
    const data = await call(this.db, 'brain_item_upsert', {
      p_account: i.accountId,
      p_source_kind: i.sourceKind,
      p_source_id: i.sourceId,
      p_case: i.caseId ?? null,
      p_contact: i.contactId ?? null,
      p_bank_code: i.bankCode ?? null,
      p_text: i.text,
      p_ai_generated: i.aiGenerated ?? false,
      p_restricted_role: i.restrictedRole ?? null,
      p_created_by: i.createdBy ?? null,
      p_system_label: i.systemLabel ?? null,
    });
    return str(scalar(data));
  }

  async isLive(i: BrainItemInput): Promise<boolean> {
    const data = await call(this.db, 'brain_item_live', {
      p_account: i.accountId,
      p_source_kind: i.sourceKind,
      p_source_id: i.sourceId,
      p_text: i.text,
    });
    return scalar(data) === true;
  }

  async forget(
    by: BrainWriter,
    accountId: string,
    scope: ForgetScope,
    reason: string
  ): Promise<number> {
    const data = await call(this.db, 'brain_item_forget', {
      p_actor: by.actorId,
      p_system_label: by.systemLabel ?? null,
      p_account: accountId,
      p_item: 'itemId' in scope ? scope.itemId : null,
      p_contact: 'contactId' in scope ? scope.contactId : null,
      p_older_than: 'olderThan' in scope ? scope.olderThan.toISOString() : null,
      p_reason: reason,
    });
    return num(scalar(data));
  }

  async markContact(
    actorId: string | null,
    accountId: string,
    contactId: string,
    kind: ContactMarkKind
  ): Promise<void> {
    await call(this.db, 'brain_contact_mark', {
      p_actor: actorId,
      p_account: accountId,
      p_contact: contactId,
      p_kind: kind,
    });
  }

  async audit(
    accountId: string,
    actorId: string,
    querySha256: string,
    resultCount: number
  ): Promise<void> {
    await call(this.db, 'brain_audit_record', {
      p_account: accountId,
      p_actor: actorId,
      p_query_sha256: querySha256,
      p_result_count: resultCount,
    });
  }
}

export class SupabaseCosineIndex implements VectorIndex {
  constructor(private readonly db: SupabaseClient) {}

  async put(
    accountId: string,
    itemId: string,
    model: string,
    vector: readonly number[]
  ): Promise<void> {
    await call(this.db, 'brain_embedding_put', {
      p_account: accountId,
      p_item: itemId,
      p_model: model,
      p_vec: [...vector],
    });
  }

  async candidates(q: VectorQuery): Promise<BrainCandidate[]> {
    const f = q.filters ?? {};
    const data = await call(this.db, 'brain_search_candidates', {
      p_actor: q.actorId,
      p_account: q.accountId,
      p_query: q.queryText,
      p_qvec: [...q.vector],
      p_model: q.model,
      p_case: f.caseId ?? null,
      p_contact: f.contactId ?? null,
      p_bank_code: f.bankCode ?? null,
      p_limit: q.limit,
    });
    const rows: Row[] = Array.isArray(data) ? (data as Row[]) : [];
    return rows
      .map(parseCandidate)
      .filter((c): c is BrainCandidate => c !== null);
  }
}

/** For the 022c/022d adapters (pages.ts, digest-store.ts). */
export { call as brainRpc, scalar as brainScalar };
