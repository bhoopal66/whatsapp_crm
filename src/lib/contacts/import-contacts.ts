// The contacts import: what a file would do, and doing it.
//
// "Already there" is the unique index on (account_id, phone_normalized)
// (migration 022): only the file's own numbers are asked about, in
// chunks. Reading every contact's number instead stopped at PostgREST's
// 1,000 rows, so the counts were wrong and the rest of the duplicates
// were tried one by one. RLS still hides a colleague's contacts from the
// read; those come back from the insert as already there.

import { chunkIds } from './chat-tag-column';
import { dedupeByPhone, isUniqueViolation, normalizeKey } from './dedupe';
import type { ParsedContactRow } from './parse-contact-csv';
import { storedForms } from './phone-match';
import { partitionRowsByPhone } from './phone-validation';

/** Numbers per `.in()` filter: 200 of them stay well inside a URL. */
export const LOOKUP_CHUNK = 200;
/** Look-up chunks in flight at once. */
const LOOKUP_PARALLEL = 4;
export const INSERT_CHUNK = 50;

type Failure = { message: string; code?: string };

/** A row that gave no contact, and why. */
export interface ImportProblem {
  line: number | null;
  phone: string;
  reason: 'unreadable' | 'no_phone' | 'phone' | 'save';
  /** The phone rule's sentence, or the database's message. */
  detail?: string;
}

/** A number already a customer, stored in another form. */
export interface SavedElsewhere {
  line: number | null;
  phone: string;
  savedAs: string;
}

export interface ImportPlan {
  toInsert: ParsedContactRow[];
  /** Includes `savedElsewhere`. */
  alreadyThere: number;
  /** Numbers found only as a trunk-0 or no-country-code row. */
  savedElsewhere: SavedElsewhere[];
  /** Repeats of a number earlier in the file. */
  repeats: number;
  problems: ImportProblem[];
}

/** Which of `keys` exist. Throws when a read fails: unknown is not new. */
export async function readExistingNumbers(
  keys: readonly string[],
  read: (chunk: string[]) => PromiseLike<{
    data: { phone_normalized: string | null }[] | null;
    error: Failure | null;
  }>
): Promise<Set<string>> {
  const found = new Set<string>();
  const chunks = chunkIds([...new Set(keys)], LOOKUP_CHUNK);
  let next = 0;
  // A small pool: a failed chunk rejects its worker, so the read throws.
  const worker = async () => {
    while (next < chunks.length) {
      const { data, error } = await read(chunks[next++]);
      if (error) throw new Error(error.message);
      for (const row of data ?? [])
        if (row.phone_normalized) found.add(row.phone_normalized);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(LOOKUP_PARALLEL, chunks.length) }, worker)
  );
  return found;
}

/** What importing the file would do. */
export async function planImport(
  file: {
    rows: ParsedContactRow[];
    badLines: readonly number[];
    noPhoneLines: readonly number[];
  },
  read: Parameters<typeof readExistingNumbers>[1]
): Promise<ImportPlan> {
  // Refuse numbers that can't be a WhatsApp address (no country code,
  // too short, scientific notation from a spreadsheet). Stored as typed,
  // every send to them reports 'sent' to nobody. Valid rows come back
  // normalized, so the checks below compare the digits to be stored.
  const { valid, rejected } = partitionRowsByPhone(file.rows);
  const { unique, duplicates } = dedupeByPhone(valid);
  // Inbound matching knows a customer saved with a trunk 0 or without a
  // country code, so the look-up asks for those forms too.
  const existing = await readExistingNumbers(
    unique.flatMap((row) => storedForms(normalizeKey(row.phone))),
    read
  );
  const toInsert: ParsedContactRow[] = [];
  const savedElsewhere: SavedElsewhere[] = [];
  for (const row of unique) {
    const key = normalizeKey(row.phone);
    if (existing.has(key)) continue;
    const savedAs = storedForms(key).find((form) => existing.has(form));
    if (savedAs === undefined) toInsert.push(row);
    else
      savedElsewhere.push({
        line: row.line ?? null,
        phone: row.phone,
        savedAs,
      });
  }
  const problems: ImportProblem[] = [
    ...file.badLines.map((line) => ({
      line,
      phone: '',
      reason: 'unreadable' as const,
    })),
    ...file.noPhoneLines.map((line) => ({
      line,
      phone: '',
      reason: 'no_phone' as const,
    })),
    ...rejected.map(({ row, error }) => ({
      line: row.line ?? null,
      phone: row.phone,
      reason: 'phone' as const,
      detail: error,
    })),
  ].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return {
    toInsert,
    alreadyThere: unique.length - toInsert.length,
    savedElsewhere,
    repeats: duplicates,
    problems,
  };
}

export interface ImportOutcome {
  imported: number;
  /** Refused by the unique index: a race, or a contact RLS hides. */
  alreadyThere: number;
  failed: ImportProblem[];
}

/**
 * Inserts the rows a batch at a time; only a failed batch is retried row
 * by row, so one bad row does not sink the others. `shouldStop` is asked
 * before every batch.
 */
export async function insertContacts(
  rows: readonly ParsedContactRow[],
  insert: (batch: ParsedContactRow[]) => PromiseLike<{ error: Failure | null }>,
  shouldStop: () => boolean = () => false
): Promise<ImportOutcome> {
  const out: ImportOutcome = { imported: 0, alreadyThere: 0, failed: [] };
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    if (shouldStop()) break;
    const batch = rows.slice(i, i + INSERT_CHUNK);
    const { error } = await insert(batch);
    if (!error) {
      out.imported += batch.length;
      continue;
    }
    for (const row of batch) {
      if (shouldStop()) break;
      const single = await insert([row]);
      if (!single.error) out.imported++;
      else if (isUniqueViolation(single.error)) out.alreadyThere++;
      else
        out.failed.push({
          line: row.line ?? null,
          phone: row.phone,
          reason: 'save',
          detail: single.error.message,
        });
    }
  }
  return out;
}
