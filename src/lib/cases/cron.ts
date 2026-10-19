/**
 * The group-end sweeper (module 018c): retries the submission-group end of
 * final-stage cases whose end never completed (a crash, a failed close,
 * a released claim). Not wired into a cron route yet.
 *
 * The pending list spans every account, and each case's group must be
 * ended through its own account's 115 service, so `storeFor(accountId)`
 * builds one store per account (server.ts's `caseStore`).
 */
import type { CaseStore, GroupEndOutcome } from './store';

export interface CaseSweepResult {
  attempted: number;
  results: { caseId: string; reason: GroupEndOutcome['reason'] | 'ERROR' }[];
  /** True when the deadline cut the sweep short. */
  stopped: boolean;
}

export async function sweepCaseGroupEnds(input: {
  store: Pick<CaseStore, 'pendingGroupEnd'>;
  storeFor: (accountId: string) => Pick<CaseStore, 'retryGroupEndSystem'>;
  /** Budget from the start of the sweep; no case is started after it. */
  deadlineMs: number;
  now?: () => number;
  limit?: number;
}): Promise<CaseSweepResult> {
  const now = input.now ?? Date.now;
  const start = now();
  const pending = await input.store.pendingGroupEnd(input.limit);
  const stores = new Map<string, Pick<CaseStore, 'retryGroupEndSystem'>>();
  const results: CaseSweepResult['results'] = [];
  for (const p of pending) {
    if (now() - start >= input.deadlineMs)
      return { attempted: results.length, results, stopped: true };
    let store = stores.get(p.accountId);
    if (!store) {
      store = input.storeFor(p.accountId);
      stores.set(p.accountId, store);
    }
    try {
      const r = await store.retryGroupEndSystem(p.caseId);
      results.push({ caseId: p.caseId, reason: r.reason });
    } catch {
      results.push({ caseId: p.caseId, reason: 'ERROR' });
    }
  }
  return { attempted: results.length, results, stopped: false };
}
