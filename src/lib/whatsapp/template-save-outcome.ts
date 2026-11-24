// What became of a template saved in Settings, from the submit and edit
// routes' answer. The screen used to say "Submitted to Meta" whatever
// had happened.

/** `meta` in the answer of POST templates/submit and PATCH templates/[id]. */
export interface TemplateMetaAnswer {
  submitted: boolean;
  status?: string;
  error?: string;
  reason?: 'no_meta_number' | 'meta_unavailable' | 'edit';
}

export type TemplateSaveOutcome =
  | { kind: 'submitted' }
  /** Meta said no; the row is kept for linked numbers. */
  | { kind: 'refused'; reason: string }
  /** No Meta number is connected. */
  | { kind: 'no_meta_number' }
  /** There may be a Meta number, but it could not be used. */
  | { kind: 'meta_unavailable' }
  /** An edit is never sent to Meta. */
  | { kind: 'edited' };

export function templateSaveOutcome(
  meta: TemplateMetaAnswer | null | undefined
): TemplateSaveOutcome {
  if (meta?.submitted) {
    // Meta can take a template and reject it in the same answer.
    return meta.status === 'REJECTED'
      ? { kind: 'refused', reason: meta.status }
      : { kind: 'submitted' };
  }
  if (meta?.error) return { kind: 'refused', reason: meta.error };
  if (meta?.reason === 'edit') return { kind: 'edited' };
  if (meta?.reason === 'no_meta_number') return { kind: 'no_meta_number' };
  return { kind: 'meta_unavailable' };
}
