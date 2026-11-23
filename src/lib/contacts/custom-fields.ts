// The custom field catalogue (create / rename / delete), as the panel in
// `components/contacts/custom-fields-manager.tsx` uses it.

import {
  deleteRows,
  updateRow,
  type RowWriter,
} from '@/lib/supabase/changed-rows';
import type { CustomField } from '@/types';

export type FieldList =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; fields: CustomField[] };

/** A failed read is not "no fields". */
export async function loadFieldList(sb: RowWriter): Promise<FieldList> {
  const { data, error } = await sb
    .from('custom_fields')
    .select('*')
    .order('field_name');
  if (error || !Array.isArray(data)) return { status: 'failed' };
  return { status: 'ready', fields: data as CustomField[] };
}

/**
 * Whether another field has this name, whatever its case; `unknown`
 * until the list was read, so nothing is created or renamed unchecked.
 */
export function checkFieldName(
  list: FieldList,
  name: string,
  exceptId?: string
): 'free' | 'taken' | 'unknown' {
  if (list.status !== 'ready') return 'unknown';
  const lower = name.toLowerCase();
  return list.fields.some(
    (f) => f.id !== exceptId && f.field_name.toLowerCase() === lower
  )
    ? 'taken'
    : 'free';
}

/** The error to show (a `Contacts.customFields` key); null: renamed. */
export async function renameField(sb: RowWriter, id: string, name: string) {
  const res = await updateRow(sb, 'custom_fields', id, { field_name: name });
  if (res.kind === 'changed') return null;
  return res.kind === 'none' ? 'toastNotRenamed' : 'toastRenameFailed';
}

/** The error to show (a `Contacts.customFields` key); null: deleted. */
export async function deleteField(sb: RowWriter, id: string) {
  const res = await deleteRows(sb, 'custom_fields', [id]);
  if (res.kind === 'changed') return null;
  return res.kind === 'none' ? 'toastNotDeleted' : 'toastDeleteFailed';
}
