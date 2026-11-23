/**
 * Opens the case (module 018c) of a Compass-created submission group: the
 * v1 POST on every group it answers, the v1 PATCH when the group has none
 * yet, and the cron for any still without one. Idempotent per group
 * (cases_one_per_group): an existing case only has its empty details
 * filled, so a call with no details changes nothing.
 */
import {
  CaseRefusedError,
  CaseStoreError,
  type CaseStore,
} from '@/lib/cases/store';
import { BANKS } from '@/lib/typesafe/banks';

export interface CaseDetails {
  bankCode?: string | null;
  product?: string | null;
  amount?: string | null;
}

export function openGroupCase(
  cases: Pick<CaseStore, 'open'>,
  groupId: string,
  details: CaseDetails = {}
): Promise<{ caseId: string; created: boolean }> {
  const bankCode = details.bankCode ?? null;
  return cases.open(
    groupId,
    {
      bankCode,
      bankName: bankCode
        ? (BANKS.find((b) => b.code === bankCode)?.displayName ?? null)
        : null,
      product: details.product ?? null,
      amount: details.amount ?? null,
    },
    null
  );
}

/**
 * Opens the group's case when it has none. False when it can have none: an
 * ENDED group's access list is closed, so no agent is left to give the case
 * to (NO_AGENT), and no repeat would change that. Any other failure throws.
 */
export async function ensureGroupCase(
  cases: Pick<CaseStore, 'open' | 'idForGroup'>,
  groupId: string,
  details: CaseDetails
): Promise<boolean> {
  if (await cases.idForGroup(groupId)) return true;
  try {
    await openGroupCase(cases, groupId, details);
    return true;
  } catch (err) {
    if (err instanceof CaseRefusedError && err.reason === 'NO_AGENT')
      return false;
    throw err;
  }
}

/** For a log line: the function and SQLSTATE, or the refusal; no case data. */
export function caseErrorText(err: unknown): string {
  if (err instanceof CaseStoreError)
    return `${err.message} (${err.code ?? '?'})`;
  return err instanceof Error ? err.message : 'unknown error';
}
