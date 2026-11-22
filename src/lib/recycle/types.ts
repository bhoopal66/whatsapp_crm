/**
 * Declined recycling (migration 251): the shapes behind /recycle.
 * Client-safe: no server import.
 */

export const RECYCLE_DEFAULT_DAYS = 90;
export const RECYCLE_MIN_DAYS = 1;
export const RECYCLE_MAX_DAYS = 730;
/** recycle_candidates caps one call; the screen's "select all" uses it. */
export const RECYCLE_MAX_BATCH = 1000;

/** Mirrors recycle_settings_outcomes_check (251). */
export const RECYCLE_CASE_OUTCOMES = ['Declined', 'Withdrawn'] as const;
export type RecycleCaseOutcome = (typeof RECYCLE_CASE_OUTCOMES)[number];

export interface RecycleSettings {
  days: number;
  chatTagIds: string[];
  caseOutcomes: RecycleCaseOutcome[];
}

export type RecycleSource = 'case' | 'chat';

/** One recycle_candidates row, as the screen uses it. */
export interface RecycleRow {
  contactId: string;
  name: string | null;
  phone: string;
  ownerId: string | null;
  ownerName: string | null;
  source: RecycleSource;
  caseId: string | null;
  conversationId: string | null;
  bankCode: string | null;
  outcome: string | null;
  reasonCode: string | null;
  chatTagName: string | null;
  endedAt: string;
  total: number;
}

/** The raw row PostgREST returns for recycle_candidates. */
export interface RecycleRpcRow {
  contact_id: string;
  name: string | null;
  phone: string | null;
  owner_id: string | null;
  owner_name: string | null;
  source: string;
  case_id: string | null;
  conversation_id: string | null;
  bank_code: string | null;
  outcome: string | null;
  reason_code: string | null;
  chat_tag_name: string | null;
  ended_at: string;
  total_count: number | string | null;
}
