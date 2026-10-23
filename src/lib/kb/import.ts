/**
 * Parses the approved-answers review spreadsheet (sheet Knowledge_Base)
 * into `kb_import`'s `p_rows` / `p_issues`. Pure: the caller reads the
 * file (`readXlsxSheets`), picks the sheet (`pickKbSheet`) and hands the
 * result to the RPC, which upserts by ref in one transaction.
 *
 * The RPC re-checks everything below, so the parser's job is to name
 * the sheet row a problem is on, which the RPC cannot see.
 */

import type { KbAudience, KbImportIssue, KbImportRow, KbStatus } from './types';

type Field =
  | 'ref'
  | 'audience'
  | 'category'
  | 'question'
  | 'answer_en'
  | 'answer_ar'
  | 'source'
  | 'status'
  | 'reviewer_notes'
  | 'handoff_after';

/** Lower-cased with everything but letters and digits removed. */
function key(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * `table[k]` only when `k` is the table's own key: a cell reading
 * "constructor" would otherwise find `Object.prototype.constructor`.
 */
function lookup<T>(table: Record<string, T>, k: string): T | undefined {
  return Object.hasOwn(table, k) ? table[k] : undefined;
}

const HEADER_ALIASES: Record<string, Field> = {
  id: 'ref',
  ref: 'ref',
  audience: 'audience',
  category: 'category',
  question: 'question',
  questionasauserwouldask: 'question',
  botanswer: 'answer_en',
  answer: 'answer_en',
  answeren: 'answer_en',
  englishanswer: 'answer_en',
  answerar: 'answer_ar',
  arabicanswer: 'answer_ar',
  botanswerarabic: 'answer_ar',
  source: 'source',
  status: 'status',
  reviewercommentsflags: 'reviewer_notes',
  reviewercomments: 'reviewer_notes',
  notes: 'reviewer_notes',
  handoff: 'handoff_after',
  handoffafter: 'handoff_after',
};

const AUDIENCES: Record<string, KbAudience> = {
  prospectiveclient: 'prospective_client',
  existingclient: 'existing_client',
  internalstaff: 'internal_staff',
};

const STATUSES: Record<string, KbStatus> = {
  approved: 'approved',
  draftverify: 'draft',
  draft: 'draft',
  '': 'draft',
  toconfirm: 'to_confirm',
  remove: 'remove',
};

const YES = new Set(['yes', 'y', 'true', '1']);

/** Mirrors the `kb_entries_approved_usable` CHECK's placeholder test. */
const PLACEHOLDER = /\[\s*to confirm/i;

type Columns = Partial<Record<Field, number>>;

/**
 * The first row with both a question and an answer column, and where
 * each known column sits in it (the first of two same-meaning columns
 * wins).
 */
function findHeader(
  table: string[][]
): { index: number; columns: Columns } | null {
  for (let index = 0; index < table.length; index++) {
    const columns: Columns = {};
    (table[index] ?? []).forEach((cell, col) => {
      const field = lookup(HEADER_ALIASES, key(cell ?? ''));
      if (field && columns[field] === undefined) columns[field] = col;
    });
    if (columns.question !== undefined && columns.answer_en !== undefined) {
      return { index, columns };
    }
  }
  return null;
}

/**
 * The knowledge-base sheet of a workbook: the one named Knowledge_Base
 * (case, `_` and spaces ignored), else the first whose header row has a
 * question and an answer column, else null.
 */
export function pickKbSheet<T extends { name: string; rows: string[][] }>(
  sheets: T[]
): T | null {
  return (
    sheets.find(
      (s) => s.name.toLowerCase().replace(/[_\s]+/g, '') === 'knowledgebase'
    ) ??
    sheets.find((s) => findHeader(s.rows) !== null) ??
    null
  );
}

/**
 * Rows of a sheet as read by `readXlsxSheets` (untrimmed, so `table[i]`
 * is sheet row i + 1) to `kb_import`'s arguments. Every row that cannot
 * be imported is named in `issues` with `skipped: true`; a row imported
 * with a correction (unknown status, unusable approved answer) is named
 * with `skipped: false`.
 */
export function parseKbTable(table: string[][]): {
  rows: KbImportRow[];
  issues: KbImportIssue[];
} {
  const rows: KbImportRow[] = [];
  const issues: KbImportIssue[] = [];

  const header = findHeader(table);
  if (!header) {
    issues.push({
      row: null,
      ref: null,
      message: 'No header row with a Question and an Answer column',
      skipped: false,
    });
    return { rows, issues };
  }
  const { columns } = header;
  const missing = (['ref', 'audience'] as const).filter(
    (f) => columns[f] === undefined
  );
  if (missing.length > 0) {
    issues.push({
      row: header.index + 1,
      ref: null,
      message: `The header row has no ${missing
        .map((f) => (f === 'ref' ? 'ID' : 'Audience'))
        .join(' or ')} column`,
      skipped: false,
    });
    return { rows, issues };
  }

  const seen = new Set<string>();
  for (let i = header.index + 1; i < table.length; i++) {
    const cells = table[i] ?? [];
    if (cells.every((c) => (c ?? '').trim() === '')) continue;
    const row = i + 1;
    const cell = (field: Field): string | undefined => {
      const col = columns[field];
      return col === undefined ? undefined : (cells[col] ?? '').trim();
    };
    const skip = (ref: string | null, message: string) =>
      issues.push({ row, ref, message, skipped: true });

    const ref = cell('ref')!.toUpperCase();
    const question = cell('question')!;
    if (ref === '' || question === '') {
      skip(ref || null, ref === '' ? 'No ID' : 'No question');
      continue;
    }
    const audienceText = cell('audience')!;
    const audience = lookup(AUDIENCES, key(audienceText));
    if (!audience) {
      skip(
        ref,
        audienceText === ''
          ? 'No audience'
          : `Unknown audience "${audienceText}"`
      );
      continue;
    }
    if (seen.has(ref)) {
      skip(ref, `Duplicate ID ${ref}; the first row with it was imported`);
      continue;
    }
    seen.add(ref);

    const out: KbImportRow = {
      ref,
      audience,
      question,
      answer_en: cell('answer_en')!,
      row,
    };
    for (const field of [
      'category',
      'answer_ar',
      'source',
      'reviewer_notes',
    ] as const) {
      const value = cell(field);
      if (value !== undefined) out[field] = value;
    }
    const handoff = cell('handoff_after');
    if (handoff !== undefined)
      out.handoff_after = YES.has(handoff.toLowerCase());

    const statusText = cell('status');
    if (statusText !== undefined) {
      let status = lookup(STATUSES, key(statusText));
      if (!status) {
        status = 'draft';
        issues.push({
          row,
          ref,
          message: `Unknown status "${statusText}"; imported as Draft`,
          skipped: false,
        });
      }
      if (
        status === 'approved' &&
        (out.answer_en === '' ||
          PLACEHOLDER.test(out.answer_en) ||
          PLACEHOLDER.test(out.answer_ar ?? ''))
      ) {
        status = 'to_confirm';
        issues.push({
          row,
          ref,
          message:
            'Marked Approved but the answer is empty or still says [TO CONFIRM]; imported as To confirm',
          skipped: false,
        });
      }
      out.status = status;
    }
    rows.push(out);
  }
  return { rows, issues };
}
