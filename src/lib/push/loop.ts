import type { DispatchSummary } from './dispatch';

/**
 * The in-process delivery loop (started by src/instrumentation.ts in a
 * production server). A pass that touched anything comes back after
 * BUSY so a backlog drains quickly; an empty or failed pass waits IDLE,
 * which bounds how stale a push gets while costing one cheap claim
 * query every 10 s. The automations cron is the fallback when no loop
 * runs (docs/push.md).
 */
export const PUSH_BUSY_DELAY_MS = 3_000;
export const PUSH_IDLE_DELAY_MS = 10_000;

/** How long to wait after a pass; `null` is a pass that threw. */
export function nextPushDelayMs(summary: DispatchSummary | null): number {
  if (!summary) return PUSH_IDLE_DELAY_MS;
  const touched =
    summary.sent +
    summary.held +
    summary.skipped +
    summary.failed +
    summary.released;
  return touched > 0 ? PUSH_BUSY_DELAY_MS : PUSH_IDLE_DELAY_MS;
}

/**
 * Run `pass` forever, one at a time (each timer is set only after the
 * previous pass settles, so passes never overlap). A throwing pass is
 * logged and the loop carries on. The timer is unref'd so it never
 * keeps the process alive on shutdown.
 */
export function startPushLoop(pass: () => Promise<DispatchSummary>): void {
  const tick = async () => {
    let summary: DispatchSummary | null = null;
    try {
      summary = await pass();
    } catch (err) {
      console.error(
        '[push] delivery pass failed:',
        err instanceof Error ? err.message : err
      );
    }
    setTimeout(tick, nextPushDelayMs(summary)).unref();
  };
  setTimeout(tick, 0).unref();
}
