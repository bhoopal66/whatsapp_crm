/**
 * `setInterval` for what only matters on screen (a badge, a list): it
 * skips while the tab is hidden, and runs at once when the tab is shown
 * again if its time has passed meanwhile. People keep tabs open for days,
 * and each hidden one asked every minute for a number nobody saw.
 *
 * The first run is the caller's own. Answers how to stop.
 */
export function visibleInterval(run: () => unknown, ms: number): () => void {
  const doc = typeof document === 'undefined' ? null : document;
  let last = Date.now();
  let timer: ReturnType<typeof setInterval>;

  const tick = () => {
    if (doc?.visibilityState === 'hidden') return;
    last = Date.now();
    void run();
  };
  const start = () => {
    clearInterval(timer);
    timer = setInterval(tick, ms);
  };
  const onVisibility = () => {
    if (doc?.visibilityState === 'hidden' || Date.now() - last < ms) return;
    tick();
    start();
  };

  start();
  doc?.addEventListener('visibilitychange', onVisibility);
  return () => {
    clearInterval(timer);
    doc?.removeEventListener('visibilitychange', onVisibility);
  };
}
