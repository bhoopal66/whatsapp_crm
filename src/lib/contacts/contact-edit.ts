// The contact form's edit. It sends only what the person changed from
// what the form loaded: writing all four fields put back the values
// loaded earlier over whatever a colleague had changed meanwhile.

import {
  updateRow,
  type RowWrite,
  type RowWriter,
} from '@/lib/supabase/changed-rows';

export interface LoadedContact {
  id: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  company?: string | null;
}

/** The form's inputs as typed. */
export interface TypedContact {
  name: string;
  phone: string;
  email: string;
  company: string;
}

export interface ContactPatch {
  name?: string | null;
  phone?: string;
  email?: string | null;
  company?: string | null;
}

/**
 * The fields to write. `phoneToSave` is the typed phone as validated
 * (`validatePhoneToSave`); an input left as loaded is never sent, even
 * where saving would have trimmed it.
 */
export function contactPatch(
  loaded: Omit<LoadedContact, 'id'>,
  typed: TypedContact,
  phoneToSave: string
): ContactPatch {
  const patch: ContactPatch = {};
  for (const key of ['name', 'email', 'company'] as const) {
    if (typed[key] === (loaded[key] ?? '')) continue;
    const next = typed[key].trim() || null;
    if (next !== (loaded[key] ?? null)) patch[key] = next;
  }
  if (typed.phone !== (loaded.phone ?? '') && phoneToSave !== loaded.phone)
    patch.phone = phoneToSave;
  return patch;
}

/** Writes the edit; `unchanged` when there was nothing to write. */
export async function saveContactEdit(
  sb: RowWriter,
  loaded: LoadedContact,
  typed: TypedContact,
  phoneToSave: string
): Promise<RowWrite | { kind: 'unchanged' }> {
  const patch = contactPatch(loaded, typed, phoneToSave);
  if (Object.keys(patch).length === 0) return { kind: 'unchanged' };
  return updateRow(sb, 'contacts', loaded.id, {
    ...patch,
    updated_at: new Date().toISOString(),
  });
}
