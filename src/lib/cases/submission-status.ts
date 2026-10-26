/**
 * The submission tracker's own status of each submitted case, word for
 * word: `submission_groups.submission_status`, as Compass last sent it on
 * PATCH /api/v1/submission-groups/{id}. Case screens show it in place of
 * the CRM stage (lib/cases/ui.ts `caseStatusView`); the stage itself still
 * drives SLA timers, closing and the stage filter (137's mapping).
 *
 * A lead (no group) or a case the tracker has sent no status for is
 * absent from the map. Service-role client: the caller has already
 * decided which cases the reader may see, and both reads are confined to
 * `accountId`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { CaseStoreError } from './store';

export async function submissionStatuses(
  db: SupabaseClient,
  accountId: string,
  caseIds: readonly string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(caseIds)];
  if (ids.length === 0) return out;

  const cases = await db
    .from('cases')
    .select('id, group_id')
    .eq('account_id', accountId)
    .in('id', ids);
  if (cases.error) throw new CaseStoreError('cases', cases.error.code ?? null);
  const groupOf = new Map<string, string>();
  for (const r of (cases.data ?? []) as Record<string, unknown>[])
    if (typeof r.group_id === 'string') groupOf.set(r.group_id, String(r.id));
  if (groupOf.size === 0) return out;

  const groups = await db
    .from('submission_groups')
    .select('id, submission_status')
    .eq('account_id', accountId)
    .in('id', [...groupOf.keys()]);
  if (groups.error)
    throw new CaseStoreError('submission_groups', groups.error.code ?? null);
  for (const g of (groups.data ?? []) as Record<string, unknown>[]) {
    const caseId = groupOf.get(String(g.id));
    const status = g.submission_status;
    if (caseId && typeof status === 'string' && status.trim() !== '')
      out.set(caseId, status);
  }
  return out;
}
