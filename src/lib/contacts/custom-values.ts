// The customer page's custom fields: what was read, what the person
// changed, and one write per changed field.
//
// Saving used to delete every value of the contact and insert the draft.
// After a failed read the draft was empty, so it wiped them all; a failed
// insert lost them all; and two people editing different fields erased
// each other.

import { rowWrite, type RowWriter } from '@/lib/supabase/changed-rows';

export interface CustomField {
  id: string;
  field_name: string;
}

/** Field id -> value, as stored. A field with no row has no key. */
export type CustomValues = Record<string, string>;

export type CustomValuesLoad =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; fields: CustomField[]; values: CustomValues };

interface Read {
  data: unknown;
  error: unknown;
}

/** Ready only when both reads succeeded: a failed one is not "no value". */
export function settleCustomValues(
  fields: Read,
  values: Read
): CustomValuesLoad {
  if (fields.error || values.error) return { status: 'failed' };
  if (!Array.isArray(fields.data) || !Array.isArray(values.data))
    return { status: 'failed' };
  return {
    status: 'ready',
    fields: fields.data as CustomField[],
    values: Object.fromEntries(
      (values.data as { custom_field_id: string; value: string | null }[]).map(
        (r) => [r.custom_field_id, r.value ?? '']
      )
    ),
  };
}

/** Whether the Edit button shows: never before both reads succeeded. */
export function canEditCustomValues(
  load: CustomValuesLoad,
  canEdit: boolean
): boolean {
  return canEdit && load.status === 'ready' && load.fields.length > 0;
}

export interface CustomValueChanges {
  set: { fieldId: string; value: string }[];
  clear: string[];
}

/** What the person changed from what was loaded; nothing else is written. */
export function customValueChanges(
  loaded: CustomValues,
  draft: CustomValues
): CustomValueChanges {
  const changes: CustomValueChanges = { set: [], clear: [] };
  for (const [fieldId, typed] of Object.entries(draft)) {
    const before = loaded[fieldId];
    const value = typed.trim();
    if (typed === (before ?? '') || value === (before ?? '')) continue;
    if (value) changes.set.push({ fieldId, value });
    else if (before !== undefined) changes.clear.push(fieldId);
  }
  return changes;
}

export interface CustomValuesSave {
  /** What is stored now, as far as this person can see. */
  values: CustomValues;
  /** Changed by this save. */
  saved: string[];
  /** Refused, or never arrived. */
  failed: string[];
  /** A clear that was accepted but found no value to remove. */
  missing: string[];
}

/**
 * One write per changed field (UNIQUE (contact_id, custom_field_id),
 * migration 001), so one that fails leaves the others alone.
 */
export async function saveCustomValues(
  sb: RowWriter,
  contactId: string,
  loaded: CustomValues,
  draft: CustomValues
): Promise<CustomValuesSave> {
  const { set, clear } = customValueChanges(loaded, draft);
  const out: CustomValuesSave = {
    values: { ...loaded },
    saved: [],
    failed: [],
    missing: [],
  };
  await Promise.all([
    ...set.map(async ({ fieldId, value }) => {
      const res = rowWrite(
        await sb
          .from('contact_custom_values')
          .upsert(
            { contact_id: contactId, custom_field_id: fieldId, value },
            { onConflict: 'contact_id,custom_field_id' }
          )
          .select('id')
      );
      if (res.kind !== 'changed') {
        out.failed.push(fieldId);
        return;
      }
      out.values[fieldId] = value;
      out.saved.push(fieldId);
    }),
    ...clear.map(async (fieldId) => {
      const res = rowWrite(
        await sb
          .from('contact_custom_values')
          .delete()
          .eq('contact_id', contactId)
          .eq('custom_field_id', fieldId)
          .select('id')
      );
      if (res.kind === 'failed') {
        out.failed.push(fieldId);
        return;
      }
      // Removed by a colleague already, or hidden from this person now:
      // either way there is nothing left here for them to see.
      delete out.values[fieldId];
      (res.kind === 'changed' ? out.saved : out.missing).push(fieldId);
    }),
  ]);
  return out;
}

/** The fields' names, in the card's order, for a message. */
export function customFieldNames(
  fields: readonly CustomField[],
  ids: readonly string[]
): string {
  return fields
    .filter((f) => ids.includes(f.id))
    .map((f) => f.field_name)
    .join(', ');
}
