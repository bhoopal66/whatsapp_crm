/**
 * The retention allow-list (migration 223), the TS mirror of
 * privacy_retention_rules(); retention.test.ts compares the two. A key
 * here never names a bank case, case file, case group message, consent
 * or audit table: those cannot be swept by a setting.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

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

/**
 * The daily sweep from the automations cron: every workspace with a
 * policy, one transaction each, dry run unless the workspace applies it.
 * Never throws; logs counts only (no customer data).
 */
export async function runRetentionSweeps(db: SupabaseClient): Promise<void> {
  const { data, error } = await db.rpc('privacy_retention_accounts');
  if (error) {
    console.error(
      `[privacy] retention: account list failed (${error.code ?? '-'})`
    );
    return;
  }
  for (const row of (data as unknown[] | null) ?? []) {
    const account =
      typeof row === 'string' ? row : String(Object.values(row as object)[0]);
    const { data: out, error: e } = await db.rpc('privacy_retention_sweep', {
      p_account: account,
    });
    if (e) {
      console.error(
        `[privacy] retention: ${account} failed (${e.code ?? '-'})`
      );
      continue;
    }
    if (out)
      console.log(
        JSON.stringify({
          msg: 'privacy_retention',
          account,
          ...(out as object),
        })
      );
  }
}
