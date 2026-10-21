/**
 * The v1 PATCH's case sync (migration 134): one case_sync_from_submission
 * call on the service role. A refusal the SQL raises (P0001, the code in
 * HINT) becomes CaseSyncRefusedError, which the route answers 422 with
 * the lower-case code; refusals of single items come back in `rejected`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { PatchInput } from './api-input';

export const CASE_SYNC_REFUSALS = [
  'UNKNOWN_STAGE',
  'PRESUB_REENTRY',
  'CASE_CLOSED',
  'FINAL_STAGE',
  'STAGE_NOT_IN_BANK',
  'BANK_INVALID',
  'PRODUCT_INVALID',
  'AMOUNT_INVALID',
  'EXTERNAL_URL_INVALID',
  'CHANGED_AT_INVALID',
] as const;

export class CaseSyncRefusedError extends Error {
  override readonly name = 'CaseSyncRefusedError';
  constructor(readonly code: (typeof CASE_SYNC_REFUSALS)[number]) {
    super(`case sync refused: ${code}`);
  }
  /** The v1 error code (lower snake). */
  get apiCode(): string {
    return this.code.toLowerCase();
  }
}

export interface CaseSyncResult {
  applied: boolean;
  reason?: string;
  stage: string | null;
  /** The case moved to a final stage in this call. */
  final: boolean;
  rejected: { key: string | null; error: string }[];
  changes: string[];
}

/** The `sync` block of the PATCH answer. */
export function syncWire(r: CaseSyncResult) {
  return {
    applied: r.applied,
    ...(r.reason ? { reason: r.reason } : {}),
    rejected: r.rejected,
    changes: r.changes,
  };
}

export async function syncCaseFromSubmission(
  db: SupabaseClient,
  groupId: string,
  sync: NonNullable<PatchInput['sync']>
): Promise<CaseSyncResult> {
  const { data, error } = await db.rpc('case_sync_from_submission', {
    p_group: groupId,
    p_changed_at: sync.changedAt,
    p_patch: sync.patch,
  });
  if (error) {
    const hint = (error as { hint?: unknown }).hint;
    const code = CASE_SYNC_REFUSALS.find((c) => c === hint);
    if (code) throw new CaseSyncRefusedError(code);
    throw new Error(`case_sync_from_submission failed (${error.code ?? '?'})`);
  }
  const r = (data ?? {}) as Record<string, unknown>;
  return {
    applied: r.applied === true,
    ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
    stage: typeof r.stage === 'string' ? r.stage : null,
    final: r.final === true,
    rejected: Array.isArray(r.rejected)
      ? (r.rejected as CaseSyncResult['rejected'])
      : [],
    changes: Array.isArray(r.changes) ? r.changes.map(String) : [],
  };
}
