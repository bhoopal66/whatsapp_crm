/**
 * Request validation and summaries for the approved-answers API
 * (`/api/ai/kb/**`) and its Settings tab. Pure, so the routes stay thin
 * and this is tested.
 */

import {
  KB_AUDIENCES,
  KB_CLIENT_AUDIENCES,
  KB_STATUSES,
  type KbAudience,
  type KbEntry,
  type KbStatus,
} from './types';

/** A `KbEntry`'s columns (the generated `search` tsvector left out). */
export const KB_ENTRY_COLUMNS =
  'id, account_id, ref, audience, category, question, answer_en, answer_ar, status, handoff_after, source, reviewer_notes, version, approved_by, approved_at, created_at, updated_at';

/** Largest workbook `POST /api/ai/kb/import` accepts. */
export const MAX_KB_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Longest value accepted per edited field. */
const MAX_LENGTH = {
  question: 1000,
  category: 200,
  answer_en: 4000,
  answer_ar: 4000,
  reviewer_notes: 2000,
} as const;

/** The columns an admin may edit (`PATCH /api/ai/kb/[id]`). */
export interface KbEntryPatch {
  question?: string;
  category?: string;
  answer_en?: string;
  answer_ar?: string | null;
  status?: KbStatus;
  handoff_after?: boolean;
  reviewer_notes?: string | null;
}

/** A PATCH body: the edits plus the `version` the dialog displayed. */
export type KbEntryPatchBody = KbEntryPatch & { version: number };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A `[id]` route segment shaped like a kb_entries id. */
export function isKbEntryId(id: string): boolean {
  return UUID_RE.test(id);
}

/** A workbook the import accepts: `.xlsx` only. */
export function isKbWorkbookName(name: string): boolean {
  return /\.xlsx$/i.test(name.trim());
}

/**
 * Validate a PATCH body. Absent keys are left out (unchanged); strings
 * are trimmed; a blank Arabic answer or note is null; a question cannot
 * be blank. Unknown keys are ignored. Whether an answer may be approved
 * is the database's call (`kb_entries_approved_usable`).
 *
 * `version` is required: the row's version the dialog displayed. The
 * route updates only while the row still has it, so an approval given
 * in a dialog opened before someone else's edit is refused, not
 * applied to text the approver never saw.
 */
export function parseKbEntryPatch(
  body: unknown
):
  | { ok: true; values: KbEntryPatch; version: number }
  | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid request body' };
  }
  const b = body as Record<string, unknown>;
  const version = b.version;
  if (
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    return { ok: false, error: 'version must be a whole number of at least 1' };
  }
  const values: KbEntryPatch = {};

  for (const key of ['question', 'category', 'answer_en'] as const) {
    if (!(key in b)) continue;
    const raw = b[key];
    if (typeof raw !== 'string') {
      return { ok: false, error: `${key} must be a string` };
    }
    const trimmed = raw.trim();
    if (trimmed.length > MAX_LENGTH[key]) {
      return {
        ok: false,
        error: `${key} must be at most ${MAX_LENGTH[key]} characters`,
      };
    }
    if (key === 'question' && !trimmed) {
      return { ok: false, error: 'question cannot be empty' };
    }
    values[key] = trimmed;
  }

  for (const key of ['answer_ar', 'reviewer_notes'] as const) {
    if (!(key in b)) continue;
    const raw = b[key];
    if (raw !== null && typeof raw !== 'string') {
      return { ok: false, error: `${key} must be a string or null` };
    }
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (trimmed.length > MAX_LENGTH[key]) {
      return {
        ok: false,
        error: `${key} must be at most ${MAX_LENGTH[key]} characters`,
      };
    }
    values[key] = trimmed || null;
  }

  if ('status' in b) {
    if (!(KB_STATUSES as readonly unknown[]).includes(b.status)) {
      return {
        ok: false,
        error: `status must be one of ${KB_STATUSES.join(', ')}`,
      };
    }
    values.status = b.status as KbStatus;
  }

  if ('handoff_after' in b) {
    if (typeof b.handoff_after !== 'boolean') {
      return { ok: false, error: 'handoff_after must be true or false' };
    }
    values.handoff_after = b.handoff_after;
  }

  if (Object.keys(values).length === 0) {
    return { ok: false, error: 'Nothing to update' };
  }
  return { ok: true, values, version };
}

/** Is this Postgres error the "approved but unusable" CHECK? */
export function isUnusableApprovalError(
  error: { code?: string; message?: string } | null | undefined
): boolean {
  return (
    error?.code === '23514' &&
    (error.message ?? '').includes('kb_entries_approved_usable')
  );
}

export type KbSummary = Record<KbAudience, Record<KbStatus, number>>;

/** Counts per audience × status, every cell present. */
export function summarizeKb(
  entries: readonly Pick<KbEntry, 'audience' | 'status'>[]
): KbSummary {
  const summary = Object.fromEntries(
    KB_AUDIENCES.map((a) => [
      a,
      Object.fromEntries(KB_STATUSES.map((s) => [s, 0])),
    ])
  ) as KbSummary;
  for (const e of entries) {
    const row = summary[e.audience];
    if (row && e.status in row) row[e.status] += 1;
  }
  return summary;
}

/** Approved / total over the client audiences (what the bot can send).
 *  Rows marked `remove` are on their way out, so they are not counted
 *  as answers still to approve. */
export function clientReadiness(summary: KbSummary): {
  approved: number;
  total: number;
} {
  let approved = 0;
  let total = 0;
  for (const a of KB_CLIENT_AUDIENCES) {
    for (const s of KB_STATUSES) if (s !== 'remove') total += summary[a][s];
    approved += summary[a].approved;
  }
  return { approved, total };
}

export interface KbFilter {
  audience: KbAudience | 'all';
  status: KbStatus | 'all';
  query: string;
}

/** The table's filter: audience, status ('all' = any) and a
 *  case-insensitive search over ref, category, question and answers. */
export function kbEntryMatches(
  entry: Pick<
    KbEntry,
    | 'ref'
    | 'audience'
    | 'status'
    | 'category'
    | 'question'
    | 'answer_en'
    | 'answer_ar'
  >,
  filter: KbFilter
): boolean {
  if (filter.audience !== 'all' && entry.audience !== filter.audience) {
    return false;
  }
  if (filter.status !== 'all' && entry.status !== filter.status) return false;
  const q = filter.query.trim().toLowerCase();
  if (!q) return true;
  return [
    entry.ref,
    entry.category,
    entry.question,
    entry.answer_en,
    entry.answer_ar ?? '',
  ].some((s) => s.toLowerCase().includes(q));
}
