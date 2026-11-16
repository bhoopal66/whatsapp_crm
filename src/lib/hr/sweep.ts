/**
 * The HR rule sweep (migration 200): `hr_sweep()` files the
 * reply-overdue and no-activity tasks for every account; then (202)
 * `hr_agent_expire()` marks stale pending recruiter-agent drafts
 * expired. Both are service-role only and run from the automations
 * cron. Never throws: a failure of either is logged once, the other
 * still runs, and the next run picks the work up (the SQL dedupes on
 * the event, so an overlapping run creates nothing).
 */
import { supabaseAdmin } from '@/lib/automations/admin-client';

export interface HrSweepSummary {
  created: number;
  skipped: number;
  /** Pending agent drafts marked expired. */
  expired: number;
}

function logFailure(what: string, err: unknown) {
  console.error(
    `[hr-sweep] ${what} failed:`,
    err instanceof Error ? err.message : err
  );
}

/** The summary, with a failed half counted as 0; null when both failed. */
export async function runHrSweep(
  now: Date = new Date()
): Promise<HrSweepSummary | null> {
  const db = supabaseAdmin();
  const pNow = now.toISOString();
  let ok = 0;
  const summary: HrSweepSummary = { created: 0, skipped: 0, expired: 0 };

  try {
    const { data, error } = await db.rpc('hr_sweep', { p_now: pNow });
    if (error) throw new Error(error.message);
    const row = (data ?? {}) as Partial<Record<'created' | 'skipped', unknown>>;
    summary.created = Number(row.created) || 0;
    summary.skipped = Number(row.skipped) || 0;
    ok += 1;
  } catch (err) {
    logFailure('hr_sweep', err);
  }

  try {
    const { data, error } = await db.rpc('hr_agent_expire', { p_now: pNow });
    if (error) throw new Error(error.message);
    summary.expired = Number(data) || 0;
    ok += 1;
  } catch (err) {
    logFailure('hr_agent_expire', err);
  }

  return ok > 0 ? summary : null;
}
