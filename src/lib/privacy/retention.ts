/**
 * The retention allow-list (migration 223), the TS mirror of
 * privacy_retention_rules(); retention.test.ts compares the two. A key
 * here never names a bank case, case file, case group message, consent
 * or audit table: those cannot be swept by a setting.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { retryErasedObjects } from './erase-objects';

export type RetentionAction = 'delete' | 'anonymise';

export const RETENTION_RULES: Readonly<
  Record<string, { table: string; actions: readonly RetentionAction[] }>
> = {
  deal_room_messages: {
    table: 'group_messages',
    actions: ['delete', 'anonymise'],
  },
  whatsapp_group_messages: {
    table: 'whatsapp_group_messages',
    actions: ['delete', 'anonymise'],
  },
  hr_outbox_bodies: { table: 'hr_automsg_outbox', actions: ['anonymise'] },
  hr_agent_drafts: { table: 'hr_agent_drafts', actions: ['delete'] },
  call_records: { table: 'calls', actions: ['anonymise'] },
};

export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 36500;

export interface RetentionPolicy {
  tables: Record<string, { days: number; action: RetentionAction }>;
}

/** null when the policy is valid, else what is wrong (the SQL's rules). */
export function retentionProblem(policy: unknown): string | null {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy))
    return 'the policy must be an object';
  const keys = Object.keys(policy);
  const tables = (policy as { tables?: unknown }).tables;
  if (
    keys.some((k) => k !== 'tables') ||
    !tables ||
    typeof tables !== 'object' ||
    Array.isArray(tables)
  )
    return 'the policy must be { tables: {…} }';
  for (const [k, v] of Object.entries(tables as Record<string, unknown>)) {
    const rule = RETENTION_RULES[k];
    if (!rule) return `${k} is not a retention key`;
    if (
      !v ||
      typeof v !== 'object' ||
      Object.keys(v).some((x) => x !== 'days' && x !== 'action')
    )
      return `${k}: only days and action`;
    const { days, action } = v as { days?: unknown; action?: unknown };
    if (
      typeof days !== 'number' ||
      !Number.isInteger(days) ||
      days < MIN_RETENTION_DAYS ||
      days > MAX_RETENTION_DAYS
    )
      return `${k}: days must be a whole number from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}`;
    if (!rule.actions.includes(action as RetentionAction))
      return `${k}: action must be one of ${rule.actions.join(', ')}`;
  }
  return null;
}

const DAY = 24 * 60 * 60_000;
/** After a failure: soon, but not on every minute's tick. */
export const RETENTION_RETRY_MS = 15 * 60_000;
/** Rows of each kind per transaction; a fifth of it after a timeout. */
export const RETENTION_SLICE = 500;
const MIN_SLICE = 20;
const SWEEP_BUDGET_MS = 40_000;
const FILES_BUDGET_MS = 20_000;

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code ?? '';

/**
 * The daily sweep from the automations cron: every workspace with a
 * policy, in slices (282), a dry run unless the workspace applies it, then
 * the files the sweeps listed. One per process. Work left when the budget
 * ends goes on at the next tick; a failure is recorded, rings the owners
 * (privacy_retention_failed, once a day) and is tried again after
 * RETENTION_RETRY_MS, so it never spends the day's run. Logs counts only
 * (no customer data).
 */
export function retentionRunner(now: () => number = Date.now) {
  let nextAt = -Infinity;
  let running = false;
  /** When each workspace is next due: a done one is not swept again. */
  const until = new Map<string, number>();

  async function sweep(
    db: SupabaseClient,
    account: string,
    deadline: number
  ): Promise<'done' | 'more' | 'failed'> {
    let slice = RETENTION_SLICE;
    for (;;) {
      const { data: out, error } = await db.rpc('privacy_retention_sweep', {
        p_account: account,
        p_limit: slice,
      });
      if (error) {
        // Statement timeout: a smaller slice may fit.
        if (codeOf(error) === '57014' && slice > MIN_SLICE) {
          slice = Math.max(MIN_SLICE, Math.floor(slice / 5));
          continue;
        }
        console.error(
          `[privacy] retention: ${account} failed (${codeOf(error) || '-'})`
        );
        const { error: e } = await db.rpc('privacy_retention_failed', {
          p_account: account,
          p_code: codeOf(error),
        });
        if (e)
          console.error(
            `[privacy] retention: ${account} failure not recorded (${codeOf(e) || '-'})`
          );
        return 'failed';
      }
      if (out)
        console.log(
          JSON.stringify({
            msg: 'privacy_retention',
            account,
            ...(out as object),
          })
        );
      if ((out as { more?: unknown } | null)?.more !== true) return 'done';
      if (now() >= deadline) return 'more';
    }
  }

  async function run(db: SupabaseClient): Promise<void> {
    if (running) return;
    running = true;
    let more = false;
    let retryAt = now() + DAY;
    try {
      const deadline = now() + SWEEP_BUDGET_MS;
      const { data, error } = await db.rpc('privacy_retention_accounts');
      if (error) {
        console.error(
          `[privacy] retention: account list failed (${codeOf(error) || '-'})`
        );
        retryAt = now() + RETENTION_RETRY_MS;
      }
      for (const row of (data as unknown[] | null) ?? []) {
        const account =
          typeof row === 'string'
            ? row
            : String(Object.values(row as object)[0]);
        if ((until.get(account) ?? -Infinity) <= now()) {
          if (now() >= deadline) {
            more = true;
            break;
          }
          const out = await sweep(db, account, deadline);
          if (out === 'more') more = true;
          else
            until.set(
              account,
              now() + (out === 'done' ? DAY : RETENTION_RETRY_MS)
            );
        }
        retryAt = Math.min(retryAt, until.get(account) ?? Infinity);
      }
      if (await retryErasedObjects(db, now() + FILES_BUDGET_MS, now))
        more = true;
    } catch (err) {
      retryAt = now() + RETENTION_RETRY_MS;
      throw err;
    } finally {
      nextAt = more ? now() : retryAt;
      running = false;
    }
  }

  return { due: () => !running && now() >= nextAt, run };
}
