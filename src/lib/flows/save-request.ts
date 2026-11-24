// ============================================================
// Saving a flow from the editor: the request, what its answer means, and
// what it does to the editor's bookkeeping. Pure apart from the fetch, so
// it is tested without a DOM. Nothing here touches the authored state: a
// refused save leaves the person's edits where they are, still unsaved.
// ============================================================

import type { FlowRow } from './types';
import type { ValidationIssue } from './validate';

/** Somebody saved the flow after this editor loaded it. */
export interface FlowConflict {
  /** The version to name when saving over it. */
  version: string;
  at: string;
  /** Who saved it; null when the name could not be read. */
  by: string | null;
}

export type FlowSaveOutcome =
  | { kind: 'saved'; version: string | null }
  | ({ kind: 'changed' } & FlowConflict)
  | { kind: 'invalid'; issues: ValidationIssue[] }
  | { kind: 'failed'; error: string | null };

export interface FlowSaveMeta {
  dirty: boolean;
  /** The version the editor's state is based on. */
  expected: string;
  conflict: FlowConflict | null;
}

/** The SQL mirror is in `flow_save` (300). */
export function flowVersion(
  flow: Pick<FlowRow, 'edited_at' | 'created_at'>
): string {
  return flow.edited_at ?? flow.created_at;
}

export async function requestFlowSave(
  id: string,
  body: Record<string, unknown>
): Promise<FlowSaveOutcome> {
  try {
    const res = await fetch(`/api/flows/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) return { kind: 'saved', version: json.version ?? null };
    if (res.status === 409 && json.changed)
      return { kind: 'changed', ...(json.changed as FlowConflict) };
    if (res.status === 422 && Array.isArray(json.issues))
      return { kind: 'invalid', issues: json.issues };
    return { kind: 'failed', error: json.error ?? null };
  } catch {
    return { kind: 'failed', error: null };
  }
}

export function afterSave(
  meta: FlowSaveMeta,
  outcome: FlowSaveOutcome,
  editedMeanwhile: boolean
): FlowSaveMeta {
  switch (outcome.kind) {
    case 'saved':
      return {
        dirty: editedMeanwhile,
        expected: outcome.version ?? meta.expected,
        conflict: null,
      };
    case 'changed': {
      const { version, at, by } = outcome;
      return { ...meta, conflict: { version, at, by } };
    }
    case 'invalid':
      // Out of the way of the problem list.
      return { ...meta, conflict: null };
    case 'failed':
      return meta;
  }
}

/**
 * "Keep mine" saves on the second press only, and only over the version
 * the person was shown: a newer save in between has to be pressed again.
 */
export function pressKeepMine(
  armedFor: string | null,
  version: string
): { armedFor: string | null; save: boolean } {
  return armedFor === version
    ? { armedFor: null, save: true }
    : { armedFor: version, save: false };
}
