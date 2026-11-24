'use client';

import { buildReport, type ClientErrorKind } from './client-errors';

/** Per page load: a screen that breaks in a loop says so a few times. */
const MAX_PER_LOAD = 5;
let sent = 0;
const said = new Set<string>();

/** Tell the server a screen broke. Never throws, never waits. */
export function reportClientError(kind: ClientErrorKind, thrown: unknown) {
  try {
    if (sent >= MAX_PER_LOAD) return;
    const report = buildReport(kind, thrown, window.location.pathname);
    if (!report) return;
    const key = `${report.name}|${report.message ?? ''}|${report.frames[0] ?? ''}`;
    if (said.has(key)) return;
    said.add(key);
    sent += 1;
    void fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
      // The page may be on its way out.
      keepalive: true,
    }).catch(() => {});
  } catch {
    // A reporter must not add a second failure.
  }
}
