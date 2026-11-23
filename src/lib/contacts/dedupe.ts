import type { SupabaseClient } from '@supabase/supabase-js';
import { isLocalPhone, phonesMatch } from '@/lib/contacts/phone-match';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';

/**
 * Contact de-duplication helpers, shared by the WhatsApp webhook, the
 * manual contact form, and CSV import so all paths agree on what
 * "same number" means (issue #212).
 *
 * The canonical key is `normalizePhone` (digits-only) — the same form
 * the DB stores in the generated `contacts.phone_normalized` column
 * and enforces unique per account. `phonesMatch` adds trunk-prefix
 * tolerance, and a last-8-digit match for a row stored without its
 * country code.
 */

/** Canonical de-dup key for a phone string (digits only). */
export function normalizeKey(phone: string): string {
  return normalizePhone(phone);
}

/** Minimal shape we need back from a contacts lookup. */
export interface ExistingContact {
  id: string;
  phone: string;
  name?: string | null;
  [key: string]: unknown;
}

/** The contacts could not be read, so whether one exists is unknown. */
export class ContactLookupError extends Error {
  constructor(cause: unknown) {
    super('Contact lookup failed', { cause });
    this.name = 'ContactLookupError';
  }
}

/**
 * Find an existing contact in `accountId` whose phone matches `phone`,
 * or null. Pre-filters in SQL by the last-8-digit suffix (so we don't
 * pull every contact), then applies the strict `phonesMatch` in JS on
 * the small candidate set — the exact approach the webhook has used.
 * Throws `ContactLookupError` when the read fails: taken for "no such
 * contact", it made callers create a second contact and chat.
 *
 * The suffix filter runs against the generated `phone_normalized`
 * column (digits only, migration 022), NOT the raw `phone`. A contact
 * typed into the form as `971 50 123 0043` has spaces inside the last
 * eight digits, so `LIKE '%01230043'` on `phone` misses it; the insert
 * then trips the unique index, the race re-lookup misses the same way,
 * and the inbound message is dropped on the floor.
 *
 * An exact digits match always beats a trunk-0 variant, which beats the
 * last-8 match of a row stored without its country code. Ties go to the
 * oldest row, except for last-8 matches: two of them are two guesses, so
 * none is taken. When a local-format twin ("50 123 0043") and the
 * full number ("971 50 123 0043") both exist, heap order used to pick
 * between them per query: one burst of inbound documents split across
 * the two contacts, and every reply on the local twin went to a JID
 * that does not exist while Whapi still reported it 'sent'.
 */
export async function findExistingContact(
  db: SupabaseClient,
  accountId: string,
  phone: string
): Promise<ExistingContact | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const suffix = normalized.length >= 8 ? normalized.slice(-8) : normalized;

  const { data, error } = await db
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .like('phone_normalized', `%${suffix}`);

  if (error) throw new ContactLookupError(error);

  const candidates = (data ?? []) as ExistingContact[];
  const exact = candidates.find((c) => normalizePhone(c.phone) === normalized);
  if (exact) return exact;

  const matches = candidates.filter((c) => phonesMatch(c.phone, phone));
  const local = matches.filter((c) => isLocalPhone(c.phone));
  // `phonesMatch` also accepts a local `phone` against a full stored
  // number, which would pick the country for the caller: not here.
  if (!isLocalPhone(phone)) {
    const variant = matches.find((c) => !isLocalPhone(c.phone));
    if (variant) return variant;
  }
  return local.length === 1 ? local[0] : null;
}

/**
 * Every contact in `accountId` that may be `phone`'s owner: the read
 * `findExistingContact` picks one row from, filtered by `phonesMatch`
 * and nothing more, so the twins and the double local matches it passes
 * over are here too. For a question that any of them can answer, such
 * as an opt-out. Throws `ContactLookupError` when the read fails.
 */
export async function findMatchingContacts(
  db: SupabaseClient,
  accountId: string,
  phone: string
): Promise<ExistingContact[]> {
  const normalized = normalizePhone(phone);
  if (!normalized) return [];

  const suffix = normalized.length >= 8 ? normalized.slice(-8) : normalized;

  const { data, error } = await db
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .like('phone_normalized', `%${suffix}`);

  if (error) throw new ContactLookupError(error);

  return ((data ?? []) as ExistingContact[]).filter((c) =>
    phonesMatch(c.phone, phone)
  );
}

/**
 * True when an existing contact is an *exact* normalized match for
 * `phone` (vs only a fuzzy trunk-variant match). The form hard-blocks
 * exact matches but only warns on fuzzy ones.
 */
export function isExactMatch(
  existing: ExistingContact,
  phone: string
): boolean {
  return normalizeKey(existing.phone) === normalizeKey(phone);
}

/**
 * True for a Postgres unique-constraint violation (SQLSTATE 23505).
 * Used as the backstop when the DB unique index rejects a racing or
 * format-equal insert that slipped past the in-app check.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { code?: string }).code === '23505';
}

/**
 * De-duplicate parsed CSV rows by normalized phone, keeping the first
 * occurrence of each. Rows with an empty normalized phone are dropped
 * (they can't be a valid contact). Returns the unique rows plus the
 * count removed as in-file duplicates.
 */
export function dedupeByPhone<T extends { phone: string }>(
  rows: T[]
): { unique: T[]; duplicates: number } {
  const seen = new Set<string>();
  const unique: T[] = [];
  let duplicates = 0;

  for (const row of rows) {
    const key = normalizeKey(row.phone);
    if (!key) {
      duplicates++;
      continue;
    }
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    unique.push(row);
  }

  return { unique, duplicates };
}
