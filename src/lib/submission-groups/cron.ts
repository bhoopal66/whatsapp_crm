/**
 * Submission Groups housekeeping (module 018a), run from the automations
 * cron: pending 'out' rows older than 10 minutes are settled failed (once,
 * for every account), then per account: pending creates older than 2
 * minutes are finished and the WhatsApp close of ENDED groups is retried.
 * The Whapi adapter is per account, so a service is built per account and
 * acts only on that account's rows. Never throws; returns counts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { SubmissionGroupService } from './service';
import { submissionGroupService, submissionGroupStore } from './server';
import type { SubmissionGroupStore } from './store';

export const PENDING_CREATE_AGE_MS = 120_000;
export const STALE_PENDING_OUT_MS = 600_000;
/** No new account or group is started after this, so the run ends inside after(). */
export const CRON_BUDGET_MS = 45_000;

export interface SubmissionGroupsCronResult {
  stalePendingFailed: number;
  accounts: number;
  created: number;
  createFailed: number;
  closed: number;
  closeFailed: number;
  errors: string[];
}

type CronStore = Pick<
  SubmissionGroupStore,
  'listPendingCreates' | 'listUnclosedEnded' | 'failStalePending'
>;
type CronService = Pick<SubmissionGroupService, 'retryPending' | 'retryClose'>;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runSubmissionGroupsCron(
  admin: SupabaseClient,
  deps: {
    store?: CronStore;
    serviceFor?: (accountId: string) => CronService;
    now?: () => number;
  } = {}
): Promise<SubmissionGroupsCronResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const out: SubmissionGroupsCronResult = {
    stalePendingFailed: 0,
    accounts: 0,
    created: 0,
    createFailed: 0,
    closed: 0,
    closeFailed: 0,
    errors: [],
  };
  try {
    const store = deps.store ?? submissionGroupStore(admin);
    const serviceFor =
      deps.serviceFor ?? ((id: string) => submissionGroupService(id, admin));

    // First, so a sender that died no longer defers a close below.
    try {
      out.stalePendingFailed = (
        await store.failStalePending(STALE_PENDING_OUT_MS)
      ).length;
    } catch (err) {
      out.errors.push(`sweep: ${errText(err)}`);
    }

    const pending = await store.listPendingCreates(
      new Date(started - PENDING_CREATE_AGE_MS),
      { limit: 200 }
    );
    const unclosed = await store.listUnclosedEnded({ limit: 200 });
    const accounts = new Map<string, { pending: boolean; close: string[] }>();
    const slot = (id: string) => {
      let a = accounts.get(id);
      if (!a) accounts.set(id, (a = { pending: false, close: [] }));
      return a;
    };
    for (const g of pending) slot(g.accountId).pending = true;
    for (const g of unclosed) slot(g.accountId).close.push(g.id);

    for (const [accountId, work] of accounts) {
      if (now() - started > CRON_BUDGET_MS) break;
      out.accounts++;
      let svc: CronService;
      try {
        svc = serviceFor(accountId);
      } catch (err) {
        out.errors.push(`${accountId}: ${errText(err)}`);
        continue;
      }
      if (work.pending) {
        try {
          const r = await svc.retryPending({
            accountId,
            olderThanMs: PENDING_CREATE_AGE_MS,
          });
          out.created += r.created.length;
          out.createFailed += r.failed.length;
        } catch (err) {
          out.errors.push(`${accountId}: ${errText(err)}`);
        }
      }
      for (const groupId of work.close) {
        if (now() - started > CRON_BUDGET_MS) break;
        try {
          const r = await svc.retryClose(groupId);
          if (r.closed) out.closed++;
          else if (r.closeError) out.closeFailed++;
        } catch (err) {
          out.closeFailed++;
          out.errors.push(`${groupId}: ${errText(err)}`);
        }
      }
    }
  } catch (err) {
    out.errors.push(errText(err));
  }
  return out;
}
