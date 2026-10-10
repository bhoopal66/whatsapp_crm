/**
 * Approved answers (migration 081): the bot mode that only sends an
 * admin-approved answer word for word, or hands the chat to a person.
 *
 * Row shapes keep the database's snake_case column names, as the row
 * types in `src/types` do, so a `select('*')` result needs no mapping.
 */

export type KbAudience =
  'prospective_client' | 'existing_client' | 'internal_staff';

export const KB_AUDIENCES: readonly KbAudience[] = [
  'prospective_client',
  'existing_client',
  'internal_staff',
];

/**
 * The audiences whose answers may reach a customer. `kb_shortlist`
 * hard-codes the same two in SQL; change one, change both.
 */
export const KB_CLIENT_AUDIENCES: readonly KbAudience[] = [
  'prospective_client',
  'existing_client',
];

export type KbStatus = 'approved' | 'draft' | 'to_confirm' | 'remove';

export const KB_STATUSES: readonly KbStatus[] = [
  'approved',
  'draft',
  'to_confirm',
  'remove',
];

/**
 * A `kb_entries` row. The generated `search` tsvector is left out: it
 * exists for `kb_shortlist` and is not read by the app.
 */
export interface KbEntry {
  id: string;
  account_id: string;
  /** Upper-cased and trimmed by `kb_import`; unique per account. */
  ref: string;
  audience: KbAudience;
  category: string;
  question: string;
  answer_en: string;
  answer_ar: string | null;
  status: KbStatus;
  /** Send the answer, then hand the chat to a person. */
  handoff_after: boolean;
  source: string | null;
  reviewer_notes: string | null;
  /** Trigger-owned: bumped when the question or an answer changes. */
  version: number;
  /** Trigger-owned: set while `status = 'approved'`, else null. */
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One `kb_shortlist` row: an approved, client-audience answer. */
export interface KbCandidate {
  id: string;
  ref: string;
  question: string;
  answer_en: string;
  answer_ar: string | null;
  handoff_after: boolean;
  /** Lexical rank; 0 for every row when the account's pool is small. */
  rank: number;
}

/**
 * One element of `kb_import`'s `p_rows`. An optional key is present only
 * when its column exists in the sheet: an absent key keeps the stored
 * value, so a sheet with no Arabic column cannot wipe Arabic answers.
 */
export interface KbImportRow {
  ref: string;
  audience: KbAudience;
  question: string;
  answer_en: string;
  category?: string;
  answer_ar?: string;
  status?: KbStatus;
  handoff_after?: boolean;
  source?: string;
  reviewer_notes?: string;
  /** 1-based sheet row. */
  row: number;
}

/** One element of `kb_import`'s `p_issues`. */
export interface KbImportIssue {
  /** 1-based sheet row; null for a problem with the sheet as a whole. */
  row: number | null;
  ref: string | null;
  message: string;
  /** True when the row was left out of `rows`. */
  skipped: boolean;
}
