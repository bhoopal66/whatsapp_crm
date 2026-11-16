/**
 * The HR rule sweep (migration 200): `hr_sweep()` files the
 * reply-overdue and no-activity tasks for every account. It is
 * service-role only and runs from the automations cron. Never throws:
 * a failure is logged once and the next run picks the work up (the SQL
 * dedupes on the event, so an overlapping run creates nothing).
 */
import { supabaseAdmin } from '@/lib/automations/admin-client';

export interface HrSweepSummary {
  created: number;
  skipped: number;
}

export async function runHrSweep(
  now: Date = new Date()
): Promise<HrSweepSummary | null> {
  try {
    const { data, error } = await supabaseAdmin().rpc('hr_sweep', {
      p_now: now.toISOString(),
    });
    if (error) throw new Error(error.message);
    const row = (data ?? {}) as Partial<Record<keyof HrSweepSummary, unknown>>;
    return {
      created: Number(row.created) || 0,
      skipped: Number(row.skipped) || 0,
    };
  } catch (err) {
    console.error(
      '[hr-sweep] failed:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
