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
 */
export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string }
  | { type: 'csv_column'; value: string };

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

/**
 * Per-contact resolution of every placeholder, in send order. Static
 * and built-in-field mappings resolve synchronously; custom fields
 * read from a pre-built index and CSV columns from the recipient's
 * own row, so the send loop never goes back to the database.
 */
export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
  csvValues?: Record<string, string>
): string[] {
  return sortedVariableKeys(variables).map(
    (key) =>
      resolveVariable(variables[key], contact, customValues, csvValues) ?? ''
  );
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
