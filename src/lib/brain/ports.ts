/**
 * Ported from wacrm module 022a (second brain), reference package 2026-11.
 * The ports of an account-scoped, role-filtered searchable knowledge store
 * for staff. Text is redacted (redact.ts) and chunked (chunk.ts) BEFORE it
 * reaches a store; the store keeps only redacted chunks, their embeddings,
 * contact marks and a search audit that holds a query hash, never the query.
 *
 * Identity: `accountId` is the workspace (accounts.id) and `actorId` an auth
 * user id. A system writer has `actorId: null` and a `systemLabel` such as
 * 'system:inbound' (SYSTEM_LABEL_RE).
 */

export type BrainSourceKind =
  | 'message'
  | 'note'
  | 'timeline'
  | 'pinned'
  | 'discussion'
  | 'remember'
  | 'page';
export const BRAIN_SOURCE_KINDS: readonly BrainSourceKind[] = [
  'message',
  'note',
  'timeline',
  'pinned',
  'discussion',
  'remember',
  'page',
];

/** The roles an item may be restricted to (case roles; no 'it'). */
export type BrainRestrictedRole =
  'agent' | 'coordinator' | 'team_lead' | 'admin' | 'super_admin';
export const BRAIN_RESTRICTED_ROLES: readonly BrainRestrictedRole[] = [
  'agent',
  'coordinator',
  'team_lead',
  'admin',
  'super_admin',
];

/** A system writer's label: 'system:inbound', 'system:retention', ... */
export const SYSTEM_LABEL_RE = /^system:[a-z_]+$/;
export const isSystemLabel = (s: string): boolean => SYSTEM_LABEL_RE.test(s);

/** Who writes: a person (`actorId`) or the system (`actorId: null` + label). */
export interface BrainWriter {
  actorId: string | null;
  systemLabel?: string | null;
}

/** One redacted chunk to store. */
export interface BrainItemInput {
  accountId: string;
  sourceKind: BrainSourceKind;
  sourceId: string;
  caseId?: string | null;
  contactId?: string | null;
  bankCode?: string | null;
  /** Already redacted, 1..800 chars. */
  text: string;
  aiGenerated?: boolean;
  restrictedRole?: BrainRestrictedRole | null;
  createdBy?: string | null;
  systemLabel?: string | null;
}

export interface BrainFilters {
  caseId?: string | null;
  contactId?: string | null;
  bankCode?: string | null;
}

/** A role-visible candidate with its cosine similarity to the query vector and its keyword rank (both 0..1). */
export interface BrainCandidate {
  itemId: string;
  sourceKind: BrainSourceKind;
  sourceId: string;
  caseId: string | null;
  contactId: string | null;
  bankCode: string | null;
  text: string;
  aiGenerated: boolean;
  createdAt: Date;
  cosine: number;
  kwRank: number;
}

export interface BrainCitation {
  kind: BrainSourceKind;
  id: string;
}

export interface BrainHit {
  itemId: string;
  snippet: string;
  sourceKind: BrainSourceKind;
  caseId: string | null;
  score: number;
  aiGenerated: boolean;
  citation: BrainCitation;
}

/** Text -> vector. `model` names the vector space; vectors of different models are never compared. */
export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface VectorQuery {
  actorId: string;
  accountId: string;
  queryText: string;
  vector: readonly number[];
  model: string;
  filters?: BrainFilters;
  limit: number;
}

/** Stores vectors per item and returns role-visible candidates ranked by similarity (and keyword rank). */
export interface VectorIndex {
  put(
    accountId: string,
    itemId: string,
    model: string,
    vector: readonly number[]
  ): Promise<void>;
  candidates(q: VectorQuery): Promise<BrainCandidate[]>;
}

export type ForgetScope =
  { itemId: string } | { contactId: string } | { olderThan: Date };

export type ContactMarkKind = 'opt_out' | 'deletion';

export interface BrainStore {
  /** The item id (new or existing), or null when nothing was stored (forgotten chunk, marked contact, brain off). */
  upsert(item: BrainItemInput): Promise<string | null>;
  /** Whether this exact chunk is already stored and live under its source (optional: only Remember asks). */
  isLive?(item: BrainItemInput): Promise<boolean>;
  forget(
    by: BrainWriter,
    accountId: string,
    scope: ForgetScope,
    reason: string
  ): Promise<number>;
  markContact(
    actorId: string | null,
    accountId: string,
    contactId: string,
    kind: ContactMarkKind
  ): Promise<void>;
  audit(
    accountId: string,
    actorId: string,
    querySha256: string,
    resultCount: number
  ): Promise<void>;
}
