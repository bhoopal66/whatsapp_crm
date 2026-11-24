// Which member names the customer page still has to ask for.
//
// A name is asked once per contact (`asked`). When that read fails the
// id is taken back out so a later render asks again — but the key is
// computed during render, so a permanent error must not turn into a
// loop: a failed id stays out of the wanted list for RETRY_AFTER_MS.

export const NAMES_RETRY_AFTER_MS = 30_000;

export interface AskedNames {
  asked: Set<string>;
  failedAt: Map<string, number>;
}

export function newAskedNames(): AskedNames {
  return { asked: new Set(), failedAt: new Map() };
}

/** True when the key was not asked, or its last failure is old enough. */
export function stillWanted(s: AskedNames, key: string, now: number): boolean {
  if (s.asked.has(key)) return false;
  const failed = s.failedAt.get(key);
  return failed === undefined || now - failed >= NAMES_RETRY_AFTER_MS;
}

export function markAsked(s: AskedNames, keys: string[]): void {
  for (const k of keys) {
    s.asked.add(k);
    s.failedAt.delete(k);
  }
}

/** The read failed: ask again, but not before the retry delay. */
export function markFailed(s: AskedNames, keys: string[], now: number): void {
  for (const k of keys) {
    s.asked.delete(k);
    s.failedAt.set(k, now);
  }
}
