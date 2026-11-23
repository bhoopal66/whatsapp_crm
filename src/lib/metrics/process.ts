/**
 * Process gauges for GET /api/metrics (package 033f): uptime, resident
 * memory, heap in use and the event loop's p99 delay since the previous
 * scrape. The delay histogram starts on the first scrape (nothing runs
 * until something asks) and is reset after each read, so the figure
 * always covers the time between two scrapes.
 *
 * Server-only (node:perf_hooks).
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Registry } from './registry';

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;

const GLOBAL_KEY = '__wacrmEventLoopHistogram';

function loopHistogram(): IntervalHistogram {
  const g = globalThis as unknown as Record<
    string,
    IntervalHistogram | undefined
  >;
  if (!g[GLOBAL_KEY]) {
    const h = monitorEventLoopDelay({ resolution: 20 });
    h.enable();
    g[GLOBAL_KEY] = h;
  }
  return g[GLOBAL_KEY];
}

/** Sets the process gauges on the registry for this scrape. */
export function collectProcess(registry: Registry): void {
  const mem = process.memoryUsage();
  registry
    .gauge(
      'process_uptime_seconds',
      'Seconds since this server process started.'
    )
    .set({}, Math.round(process.uptime()));
  registry
    .gauge(
      'process_resident_memory_bytes',
      'Resident memory of this process, in bytes.'
    )
    .set({}, mem.rss);
  registry
    .gauge('nodejs_heap_used_bytes', 'V8 heap in use, in bytes.')
    .set({}, mem.heapUsed);

  const h = loopHistogram();
  // The histogram reports nanoseconds; NaN before any sample.
  const p99 = h.count > 0 ? h.percentile(99) / 1e9 : 0;
  registry
    .gauge(
      'nodejs_eventloop_lag_p99_seconds',
      'p99 event loop delay since the previous scrape, in seconds.'
    )
    .set({}, Number.isFinite(p99) ? p99 : 0);
  h.reset();
}
