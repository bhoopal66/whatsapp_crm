import type { Contact } from '@/types';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';

/**
 * One row of an uploaded broadcast CSV. `phone`/`name`/`company` are
 * what the send path upserts into `contacts`; `values` is every cell
 * keyed by its lower-cased header, and is what a `csv_column` variable
 * mapping reads.
 */
export interface CsvContactRow {
  phone: string;
  name?: string;
  company?: string;
  values?: Record<string, string>;
}

/**
 * Variable mapping — each template placeholder (by key, usually "1",
 * "2", …) is resolved at send time. `field` maps to a built-in contact
 * field (name/phone/email/company); `custom_field` maps to a
 * contact_custom_values.value row keyed by the custom_fields.id stored
 * in `value`; `csv_column` maps to a column of the uploaded CSV, keyed
 * by its lower-cased header, and only means something for a CSV
 * audience.
 *
 * `fallback` is what a recipient gets when the mapping resolves blank
 * for them (no such column, an empty cell, a contact without an
 * email). It exists because Meta refuses a blank text parameter with
 * #131008 — a Compass field most customers lacked failed a whole
 * campaign that way — and Whapi, which renders locally, sends "Hi ,".
 * It is stored with the mapping in `template_variables`, and applied
 * when `template_params` are resolved at creation, so resume and cron
 * send the same value.
 */
export type VariableMapping =
  | { type: 'static'; value: string; fallback?: string }
  | { type: 'field'; value: string; fallback?: string }
  | { type: 'custom_field'; value: string; fallback?: string }
  | { type: 'csv_column'; value: string; fallback?: string };

export type VariableType = VariableMapping['type'];

/** Built-in contact fields a `field` mapping may name. */
export function contactFieldValue(
  contact: Pick<Contact, 'name' | 'phone' | 'email' | 'company'>,
  field: string
): string | undefined {
  const fieldMap: Record<string, string | null | undefined> = {
    name: contact.name,
    phone: contact.phone,
    email: contact.email,
    company: contact.company,
  };
  return fieldMap[field] ?? undefined;
}

/** Placeholder keys in send order: numeric-aware so {{1}} precedes {{10}}. */
export function sortedVariableKeys(
  variables: Record<string, VariableMapping>
): string[] {
  return Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });
}

/**
 * Resolve one mapping for one recipient. Returns `undefined` when the
 * mapping names something this recipient doesn't have (no such custom
 * value, no such CSV column); callers decide whether that becomes an
 * empty string (send) or the untouched placeholder (preview).
 */
export function resolveVariable(
  mapping: VariableMapping,
  contact: Pick<Contact, 'name' | 'phone' | 'email' | 'company'>,
  customValues?: Map<string, string>,
  csvValues?: Record<string, string>
): string | undefined {
  switch (mapping.type) {
    case 'static':
      return mapping.value;
    case 'field':
      return contactFieldValue(contact, mapping.value);
    case 'custom_field':
      return customValues?.get(mapping.value);
    case 'csv_column':
      return csvValues?.[mapping.value];
  }
}

function isBlank(value: string | undefined): boolean {
  return !value || !value.trim();
}

/** The mapping's fallback, trimmed, or `undefined` when it has none. */
function fallbackOf(mapping: VariableMapping): string | undefined {
  const fallback = mapping.fallback?.trim();
  return fallback || undefined;
}

/**
 * `resolveVariable`, with the mapping's fallback standing in for a
 * missing or whitespace-only value. Still `undefined` when neither
 * exists, so the preview can leave the placeholder showing.
 */
export function resolveVariableWithFallback(
  mapping: VariableMapping,
  contact: Pick<Contact, 'name' | 'phone' | 'email' | 'company'>,
  customValues?: Map<string, string>,
  csvValues?: Record<string, string>
): string | undefined {
  const value = resolveVariable(mapping, contact, customValues, csvValues);
  if (!isBlank(value)) return value;
  return fallbackOf(mapping) ?? value;
}

/**
 * Per-contact resolution of every placeholder, in send order. Static
 * and built-in-field mappings resolve synchronously; custom fields
 * read from a pre-built index and CSV columns from the recipient's
 * own row, so the send loop never goes back to the database. A blank
 * value takes the mapping's fallback; with none it stays blank, and a
 * Meta send refuses it before calling the gateway
 * (`template-send-builder`).
 */
export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
  csvValues?: Record<string, string>
): string[] {
  return sortedVariableKeys(variables).map(
    (key) =>
      resolveVariableWithFallback(
        variables[key],
        contact,
        customValues,
        csvValues
      ) ?? ''
  );
}

/**
 * The contact fields a CSV / Compass row stands for before it becomes a
 * `contacts` row — what the personalize preview and the blank count
 * resolve `field` mappings against.
 */
export function csvRowContact(
  row: CsvContactRow
): Pick<Contact, 'name' | 'phone' | 'email' | 'company'> {
  return {
    name: row.name ?? row.values?.name ?? '',
    phone: row.phone,
    email: row.values?.email ?? '',
    company: row.company ?? row.values?.company ?? '',
  };
}

export interface BlankVariableCount {
  /** Variable key, e.g. "1" for {{1}}. */
  key: string;
  /** Rows the mapping resolves blank for. */
  blank: number;
  /** Rows checked. */
  total: number;
}

/**
 * For each mapping without a fallback, how many of these rows would
 * receive a blank — the step-3 warning, so the admin sets a fallback
 * before Meta refuses those recipients (#131008). Only the sources a
 * row can answer are counted: `field` and `csv_column`. A custom
 * field lives on the CRM contact, which a row does not have yet, and a
 * static value is the same for everyone. Unmapped keys (empty `value`)
 * are skipped; step 3 already blocks those. Only keys with at least
 * one blank row are returned, in send order.
 */
export function countBlankVariables(
  variables: Record<string, VariableMapping>,
  rows: CsvContactRow[]
): BlankVariableCount[] {
  if (rows.length === 0) return [];
  const out: BlankVariableCount[] = [];
  for (const key of sortedVariableKeys(variables)) {
    const mapping = variables[key];
    if (mapping.type !== 'field' && mapping.type !== 'csv_column') continue;
    if (!mapping.value?.trim() || fallbackOf(mapping)) continue;
    let blank = 0;
    for (const row of rows) {
      const value = resolveVariable(
        mapping,
        csvRowContact(row),
        undefined,
        row.values ?? {}
      );
      if (isBlank(value)) blank++;
    }
    if (blank > 0) out.push({ key, blank, total: rows.length });
  }
  return out;
}

/**
 * Index CSV rows by normalized phone so a resolved `contacts` row can
 * find the CSV row it came from. The upsert de-duplicates on the same
 * key (migration 022's `phone_normalized`), so the first row for a
 * phone wins here exactly as it does there.
 */
export function indexCsvRowsByPhone(
  rows: CsvContactRow[]
): Map<string, Record<string, string>> {
  const index = new Map<string, Record<string, string>>();
  for (const row of rows) {
    const key = normalizePhone(row.phone);
    if (key && !index.has(key)) index.set(key, row.values ?? {});
  }
  return index;
}

/** The CSV row for a contact, or `undefined` when it didn't come from the CSV. */
export function csvValuesForContact(
  index: Map<string, Record<string, string>>,
  contact: Pick<Contact, 'phone'>
): Record<string, string> | undefined {
  const key = normalizePhone(contact.phone ?? '');
  return key ? index.get(key) : undefined;
}
