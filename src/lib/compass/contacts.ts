// ============================================================
// Taamul Compass — customer-record sync (migration 056).
//
// Compass (the ERP) pushes its customer master into `compass_contacts`
// through `/api/v1/compass/contacts`: one big backfill, then a call per
// new or changed customer. Everything here is keyed by Compass's own id,
// so a record sent twice is an update, not a duplicate — which is what
// lets Compass retry a batch blindly.
//
// Parsing is pure and per-record: one bad row in a batch of 500 is
// reported back by index and the other 499 are still stored. Refusing
// the whole batch would stall the backfill on the first typo in the
// ERP, with no way for Compass to tell which record was at fault.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { validateContactPhone } from '@/lib/contacts/phone-validation';

/** Records accepted per sync call. 120 calls/min × 500 = 60k/min. */
export const MAX_SYNC_BATCH = 500;

const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 500;
/** Serialized size cap for `attributes` — metadata, not a document store. */
const MAX_ATTRIBUTES_BYTES = 16_384;

/** A record as stored (minus account/timestamps/link). */
export interface CompassContactRow {
  compass_id: string;
  name: string | null;
  /** Digits only, e.g. "971501234567", or null when Compass has none. */
  phone: string | null;
  email: string | null;
  company: string | null;
  attributes: Record<string, unknown>;
}

export type ParseResult =
  | { ok: true; row: CompassContactRow }
  | { ok: false; compassId: string | null; error: string };

/**
 * Compass ids may be numeric in the ERP; accept both and store text so
 * `42` and `"42"` are the same customer.
 */
export function parseCompassId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return null;
  return trimmed;
}

/**
 * Normalize a phone to digits-only international form, or report why
 * not. A local number ("050 123 4567") is rejected rather than guessed
 * at: we do not know which country Compass meant, and a wrong guess
 * sends a bank-account update to a stranger. The rule is the CRM-wide
 * one (`validateContactPhone`): a 9-digit or malformed +971 number
 * passed a bare E.164 check, was stored, and every notification to it
 * was 'sent' to nobody.
 */
export function normalizeCompassPhone(
  value: unknown
): { ok: true; phone: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, phone: null };
  if (typeof value !== 'string' && typeof value !== 'number') {
    return { ok: false, error: "'phone' must be a string" };
  }
  const raw = String(value).trim();
  if (!raw) return { ok: true, phone: null };
  const checked = validateContactPhone(raw, "'phone'");
  if (!checked.ok) return { ok: false, error: checked.error };
  return { ok: true, phone: checked.normalized };
}

function optionalText(
  record: Record<string, unknown>,
  field: string
): { ok: true; value: string | null } | { ok: false; error: string } {
  const value = record[field];
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string') {
    return { ok: false, error: `'${field}' must be a string` };
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_TEXT_LENGTH) {
    return {
      ok: false,
      error: `'${field}' exceeds ${MAX_TEXT_LENGTH} characters`,
    };
  }
  return { ok: true, value: trimmed || null };
}

/** Validate one incoming record. Never throws. */
export function parseCompassContact(input: unknown): ParseResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, compassId: null, error: 'Record must be an object' };
  }
  const record = input as Record<string, unknown>;

  const compassId = parseCompassId(record.compass_id);
  if (!compassId) {
    return {
      ok: false,
      compassId: null,
      error: `'compass_id' is required (string or number, at most ${MAX_ID_LENGTH} characters)`,
    };
  }
  const fail = (error: string): ParseResult => ({
    ok: false,
    compassId,
    error,
  });

  const phone = normalizeCompassPhone(record.phone);
  if (!phone.ok) return fail(phone.error);

  const fields: Record<'name' | 'email' | 'company', string | null> = {
    name: null,
    email: null,
    company: null,
  };
  for (const field of ['name', 'email', 'company'] as const) {
    const parsed = optionalText(record, field);
    if (!parsed.ok) return fail(parsed.error);
    fields[field] = parsed.value;
  }

  let attributes: Record<string, unknown> = {};
  if (record.attributes !== undefined && record.attributes !== null) {
    if (
      typeof record.attributes !== 'object' ||
      Array.isArray(record.attributes)
    ) {
      return fail("'attributes' must be a JSON object");
    }
    attributes = record.attributes as Record<string, unknown>;
    if (JSON.stringify(attributes).length > MAX_ATTRIBUTES_BYTES) {
      return fail(`'attributes' exceeds ${MAX_ATTRIBUTES_BYTES} bytes`);
    }
  }

  return {
    ok: true,
    row: {
      compass_id: compassId,
      name: fields.name,
      phone: phone.phone,
      email: fields.email,
      company: fields.company,
      attributes,
    },
  };
}

export interface RejectedRecord {
  index: number;
  compass_id: string | null;
  error: string;
}

export interface ParsedBatch {
  rows: CompassContactRow[];
  rejected: RejectedRecord[];
}

/**
 * Validate a batch. A `compass_id` repeated within one batch keeps its
 * LAST occurrence — the batch is read as a change log in order — and
 * must be collapsed here regardless, because Postgres refuses an
 * ON CONFLICT upsert that touches the same row twice in one statement.
 */
export function parseCompassContactBatch(records: unknown[]): ParsedBatch {
  const byId = new Map<string, CompassContactRow>();
  const rejected: RejectedRecord[] = [];

  records.forEach((record, index) => {
    const parsed = parseCompassContact(record);
    if (parsed.ok) {
      // Delete-then-set moves a repeated id to the end, so the stored
      // order follows the last occurrence too.
      byId.delete(parsed.row.compass_id);
      byId.set(parsed.row.compass_id, parsed.row);
    } else {
      rejected.push({
        index,
        compass_id: parsed.compassId,
        error: parsed.error,
      });
    }
  });

  return { rows: [...byId.values()], rejected };
}

/** Public shape of a stored record. */
export interface ApiCompassContact {
  compass_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  company: string | null;
  attributes: Record<string, unknown>;
  /** The CRM contact this customer became, once messaged. */
  contact_id: string | null;
  created_at: string;
  updated_at: string;
}

export const COMPASS_CONTACT_COLUMNS =
  'id, compass_id, name, phone, email, company, attributes, contact_id, created_at, updated_at';

export function serializeCompassContact(
  row: Record<string, unknown>
): ApiCompassContact {
  return {
    compass_id: row.compass_id as string,
    name: (row.name as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    company: (row.company as string | null) ?? null,
    attributes: (row.attributes as Record<string, unknown> | null) ?? {},
    contact_id: (row.contact_id as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * Upsert parsed rows. Every column in the row is replaced — a sync
 * record is the whole record, so a field Compass cleared is cleared
 * here too. `contact_id` is not in the row, so the link to a CRM
 * contact survives every re-sync.
 */
export async function upsertCompassContacts(
  db: SupabaseClient,
  accountId: string,
  rows: CompassContactRow[]
): Promise<number> {
  if (rows.length === 0) return 0;
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('compass_contacts')
    .upsert(
      rows.map((row) => ({ ...row, account_id: accountId, updated_at: now })),
      { onConflict: 'account_id,compass_id' }
    )
    .select('id');

  if (error) {
    throw new Error(`compass_contacts upsert failed: ${error.message}`);
  }
  return data?.length ?? rows.length;
}
