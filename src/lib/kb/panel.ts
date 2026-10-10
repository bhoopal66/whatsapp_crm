/**
 * The Approved answers tab's pure pieces (Settings → AI Agents →
 * Approved answers): the status pill's tone, the edit dialog's patch,
 * and defensive readers for the import endpoint's answer and the
 * import history. Pure, so the component stays thin and this is tested.
 */

import type { KbEntryPatch, KbEntryPatchBody } from './requests';
import {
  KB_STATUSES,
  type KbEntry,
  type KbImportIssue,
  type KbStatus,
} from './types';

export type KbStatusTone = 'success' | 'neutral' | 'warning' | 'muted';

/** Approved is green, draft neutral, to-confirm amber, remove muted. */
export function kbStatusTone(status: KbStatus): KbStatusTone {
  switch (status) {
    case 'approved':
      return 'success';
    case 'to_confirm':
      return 'warning';
    case 'remove':
      return 'muted';
    default:
      return 'neutral';
  }
}

/** The edit dialog's fields, as typed (untrimmed, blanks as ''). */
export interface KbEntryDraft {
  question: string;
  category: string;
  answer_en: string;
  answer_ar: string;
  status: KbStatus;
  handoff_after: boolean;
  reviewer_notes: string;
}

export function kbEntryDraft(entry: KbEntry): KbEntryDraft {
  return {
    question: entry.question,
    category: entry.category,
    answer_en: entry.answer_en,
    answer_ar: entry.answer_ar ?? '',
    status: entry.status,
    handoff_after: entry.handoff_after,
    reviewer_notes: entry.reviewer_notes ?? '',
  };
}

/**
 * Only the fields the dialog changed, normalised the way
 * `parseKbEntryPatch` stores them (trimmed; a blank Arabic answer or
 * note is null), plus the `version` the dialog was opened on, so the
 * server refuses the save if the row changed meanwhile. Null when
 * nothing changed, so Save needs no request and an untouched row's
 * version is never bumped.
 */
export function kbEntryPatch(
  entry: KbEntry,
  draft: KbEntryDraft
): KbEntryPatchBody | null {
  const patch: KbEntryPatch = {};
  for (const key of ['question', 'category', 'answer_en'] as const) {
    const value = draft[key].trim();
    if (value !== entry[key]) patch[key] = value;
  }
  for (const key of ['answer_ar', 'reviewer_notes'] as const) {
    const value = draft[key].trim() || null;
    if (value !== (entry[key] ?? null)) patch[key] = value;
  }
  if (draft.status !== entry.status) patch.status = draft.status;
  if (draft.handoff_after !== entry.handoff_after) {
    patch.handoff_after = draft.handoff_after;
  }
  if (Object.keys(patch).length === 0) return null;
  return { ...patch, version: entry.version };
}

/** `POST /api/ai/kb/import`'s answer. */
export interface KbImportResult {
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  /** Approved rows for the two client audiences: what the bot can send. */
  approved: number;
  /** Approved internal_staff rows (never sent to customers). */
  approved_internal: number;
  sheet: string | null;
  issues: KbImportIssue[];
}

/** One row of the import history (`GET /api/ai/kb` → `imports`). */
export interface KbImportRecord {
  id: string;
  file_name: string | null;
  total: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  approved: number;
  created_at: string;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function parseIssue(value: unknown): KbImportIssue | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const message = text(v.message);
  if (!message) return null;
  return {
    row: typeof v.row === 'number' && Number.isFinite(v.row) ? v.row : null,
    ref: text(v.ref),
    message,
    skipped: v.skipped === true,
  };
}

/** Read the import answer; a missing or malformed field reads as 0 /
 *  null / [] rather than breaking the result panel. */
export function parseKbImportResult(json: unknown): KbImportResult {
  const v = (json && typeof json === 'object' ? json : {}) as Record<
    string,
    unknown
  >;
  return {
    inserted: count(v.inserted),
    updated: count(v.updated),
    unchanged: count(v.unchanged),
    skipped: count(v.skipped),
    approved: count(v.approved),
    approved_internal: count(v.approved_internal),
    sheet: text(v.sheet),
    issues: Array.isArray(v.issues)
      ? v.issues.map(parseIssue).filter((i): i is KbImportIssue => i !== null)
      : [],
  };
}

/** Read the import history; rows without an id or date are dropped. */
export function parseKbImportHistory(json: unknown): KbImportRecord[] {
  if (!Array.isArray(json)) return [];
  const out: KbImportRecord[] = [];
  for (const item of json) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    const id = text(v.id);
    const createdAt = text(v.created_at);
    if (!id || !createdAt) continue;
    out.push({
      id,
      file_name: text(v.file_name),
      total: count(v.total),
      inserted: count(v.inserted),
      updated: count(v.updated),
      unchanged: count(v.unchanged),
      skipped: count(v.skipped),
      approved: count(v.approved),
      created_at: createdAt,
    });
  }
  return out;
}

/** Narrow a select's raw value to a status ('all' kept for filters). */
export function isKbStatus(value: unknown): value is KbStatus {
  return (KB_STATUSES as readonly unknown[]).includes(value);
}
