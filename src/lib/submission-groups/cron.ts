/**
 * Submission Groups housekeeping (module 018a), run from the automations
 * cron: pending 'out' rows older than 10 minutes are settled failed (once,
 * for every account), then per account: pending creates older than 2
 * minutes are finished, the WhatsApp close of ENDED groups is retried, and
 * groups due a membership check are read (174).
 * The Whapi adapter is per account, so a service is built per account and
 * acts only on that account's rows. Never throws; returns counts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { customerMembershipFrom } from './membership';
import type { SubmissionGroupService } from './service';
import { submissionGroupService, submissionGroupStore } from './server';
import type { SubmissionGroupStore } from './store';
import { createWhapiGroupsApi, type ParticipantsApi } from './whapi-groups-api';

export const PENDING_CREATE_AGE_MS = 120_000;
export const STALE_PENDING_OUT_MS = 600_000;
/** No new account or group is started after this, so the run ends inside after(). */
export const CRON_BUDGET_MS = 45_000;
/** Membership reads per account per run. The cron runs every 2 minutes per process. */
export const MEMBERSHIP_CHECKS_PER_RUN = 10;

export interface SubmissionGroupsCronResult {
  stalePendingFailed: number;
  accounts: number;
  created: number;
  createFailed: number;
  closed: number;
  closeFailed: number;
  membershipChecked: number;
  errors: string[];
}

type CronStore = Pick<
  SubmissionGroupStore,
  | 'listPendingCreates'
  | 'listUnclosedEnded'
  | 'failStalePending'
  | 'membershipAccounts'
  | 'membershipDue'
  | 'get'
  | 'contactConsent'
  | 'noteCustomerMembership'
>;
type CronService = Pick<
  SubmissionGroupService,
  'retryPending' | 'retryClose' | 'sendWelcomeIfDue'
>;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * One account's due groups. A throw (gateway or database) ends the pass; the
 * group stays due. A group with nothing to read (number, contact or WhatsApp
 * group gone) is stamped 'unknown', or it would stay first in line and block
 * the account's other groups on every run.
 */
async function checkMembership(
  store: CronStore,
  api: ParticipantsApi,
  accountId: string,
  overBudget: () => boolean,
  checked: () => void
): Promise<void> {
  const due = await store.membershipDue(accountId, MEMBERSHIP_CHECKS_PER_RUN);
  for (const groupId of due) {
    if (overBudget()) return;
    const group = await store.get(groupId);
    if (!group) continue;
    const phone = group.contactId
      ? (await store.contactConsent(group.contactId)).phone
      : null;
    const ids =
      phone && group.channelId && group.waGroupId
        ? await api.getParticipants(group.channelId, group.waGroupId)
        : null;
    await store.noteCustomerMembership(
      groupId,
      ids ? customerMembershipFrom(ids, [phone]) : 'unknown'
    );
    checked();
  }
}

export async function runSubmissionGroupsCron(
  admin: SupabaseClient,
  deps: {
    store?: CronStore;
    serviceFor?: (accountId: string) => CronService;
    participantsFor?: (accountId: string) => ParticipantsApi;
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
    membershipChecked: 0,
    errors: [],
  };
  try {
    const store = deps.store ?? submissionGroupStore(admin);
    const serviceFor =
      deps.serviceFor ?? ((id: string) => submissionGroupService(id, admin));
    const participantsFor =
      deps.participantsFor ?? ((id: string) => createWhapiGroupsApi(admin, id));
    const overBudget = () => now() - started > CRON_BUDGET_MS;

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
    try {
      for (const id of await store.membershipAccounts()) slot(id);
    } catch (err) {
      out.errors.push(`membership: ${errText(err)}`);
    }

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
          // Never throws; the case row exists by now (opened with the submission).
          for (const id of r.created) await svc.sendWelcomeIfDue(id);
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
      try {
        await checkMembership(
          store,
          participantsFor(accountId),
          accountId,
          overBudget,
          () => out.membershipChecked++
        );
      } catch (err) {
        out.errors.push(`${accountId}: membership: ${errText(err)}`);
      }
    }
  } catch (err) {
    out.errors.push(errText(err));
  }
  return out;
}
