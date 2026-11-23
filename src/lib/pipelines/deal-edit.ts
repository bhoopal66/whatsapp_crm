// The deal form's edit, like the contact form's (contacts/contact-edit):
// it sends only what the person changed from what the form was filled
// with. Writing every field put the values loaded earlier back over
// whatever a colleague had changed meanwhile.

import {
  updateRow,
  type RowWrite,
  type RowWriter,
} from '@/lib/supabase/changed-rows';

/** The form's inputs, as filled or as typed. */
export interface DealInputs {
  title: string;
  value: string;
  currency: string;
  contactId: string;
  stageId: string;
  assignedTo: string;
  expectedCloseDate: string;
  notes: string;
}

export interface DealRow {
  title: string;
  value: number;
  currency: string;
  contact_id: string;
  pipeline_id: string;
  stage_id: string;
  assigned_to: string | null;
  notes: string | null;
  expected_close_date: string | null;
}

/** The inputs as a row. */
export function dealRow(inputs: DealInputs, pipelineId: string): DealRow {
  return {
    title: inputs.title.trim(),
    value: parseFloat(inputs.value) || 0,
    currency: inputs.currency,
    contact_id: inputs.contactId,
    pipeline_id: pipelineId,
    stage_id: inputs.stageId,
    assigned_to: inputs.assignedTo || null,
    notes: inputs.notes.trim() || null,
    expected_close_date: inputs.expectedCloseDate || null,
  };
}

/** Whether the person has typed anything since the form was filled. */
export function dealFormDirty(filled: DealInputs, typed: DealInputs): boolean {
  return (Object.keys(filled) as (keyof DealInputs)[]).some(
    (key) => filled[key] !== typed[key]
  );
}

/**
 * The fields to write. An input left as it was filled is never sent,
 * even where saving would have tidied it. A stage carries its pipeline:
 * the stage picked here belongs to the pipeline on screen.
 */
export function dealPatch(
  filled: DealInputs,
  typed: DealInputs,
  pipelineId: string
): Partial<DealRow> {
  const before = dealRow(filled, pipelineId);
  const after = dealRow(typed, pipelineId);
  const patch: Partial<Record<keyof DealRow, unknown>> = {};
  for (const key of Object.keys(after) as (keyof DealRow)[])
    if (after[key] !== before[key]) patch[key] = after[key];
  if (patch.stage_id !== undefined) patch.pipeline_id = pipelineId;
  return patch as Partial<DealRow>;
}

/** Writes the edit; `unchanged` when there was nothing to write. */
export async function saveDealEdit(
  sb: RowWriter,
  dealId: string,
  filled: DealInputs,
  typed: DealInputs,
  pipelineId: string
): Promise<RowWrite | { kind: 'unchanged' }> {
  const patch = dealPatch(filled, typed, pipelineId);
  if (Object.keys(patch).length === 0) return { kind: 'unchanged' };
  return updateRow(sb, 'deals', dealId, patch);
}

/**
 * Whether the open form takes its props again. `filledFor` is what it
 * shows (a deal's id, 'new', or null while closed): another deal always
 * fills it, the same one only while nothing has been typed.
 */
export function shouldFillDealForm(
  filledFor: string | null,
  showing: string,
  dirty: boolean
): boolean {
  return filledFor !== showing || !dirty;
}
