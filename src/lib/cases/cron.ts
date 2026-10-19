/**
 * The group-end sweeper (module 018c): retries the submission-group end of
 * final-stage cases whose end never completed (a crash, a failed close,
 * a released claim). Not wired into a cron route yet.
 *
 * The pending list spans every account, and each case's group must be
 * ended through its own account's 115 service, so `storeFor(accountId)`
 * builds one store per account (server.ts's `caseStore`).
 */
import type { CaseSlaStore, SlaChange } from './sla';
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

export interface CaseSlaResult {
  /** Cases evaluated (each in its own case_sla_evaluate transaction). */
  evaluated: number;
  /** The state changes logged, case by case. */
  changes: SlaChange[];
  /** The cases whose evaluation threw; the rest still ran. */
  errors: string[];
  /** True when the deadline cut the job short. */
  stoppedEarly: boolean;
}

/**
 * The SLA job (module 018c, migration 124), case by case: the cases with
 * work at one `now` (case_sla_due_cases), then case_sla_evaluate(now, id)
 * once per case, each its own transaction. One call over every case
 * (p_case NULL) held every running case's lock until the whole sweep
 * committed, so every case write waited behind the job. A case that
 * throws is recorded and skipped; no case is started after the deadline.
 */
export async function evaluateCaseSla(input: {
  store: Pick<CaseSlaStore, 'dueCases' | 'evaluate'>;
  /** Budget from the start of the job; no case is started after it. */
  deadlineMs: number;
  now?: () => Date;
  clock?: () => number;
  limit?: number;
}): Promise<CaseSlaResult> {
  const clock = input.clock ?? Date.now;
  const start = clock();
  const now = (input.now ?? (() => new Date()))();
  const due = await input.store.dueCases(now, input.limit);
  const result: CaseSlaResult = {
    evaluated: 0,
    changes: [],
    errors: [],
    stoppedEarly: false,
  };
  for (const caseId of due) {
    if (clock() - start >= input.deadlineMs) {
      result.stoppedEarly = true;
      break;
    }
    try {
      result.changes.push(...(await input.store.evaluate(now, caseId)));
    } catch {
      result.errors.push(caseId);
    }
    result.evaluated += 1;
  }
  return result;
}
