/**
 * Says each thing once per window, with how often it was held back since.
 * One broken screen open in fifty browsers must not bury the log, and a
 * report is never worth unbounded memory: past `maxKeys` the rest share
 * one key.
 */
export function createRepeatGate({
  windowMs,
  maxKeys,
}: {
  windowMs: number;
  maxKeys: number;
}) {
  const seen = new Map<string, { until: number; held: number }>();
  return {
    /** null: say nothing now. Otherwise how many were held back before. */
    admit(key: string, now = Date.now()): { held: number } | null {
      if (!seen.has(key) && seen.size >= maxKeys) {
        for (const [k, v] of seen) if (v.until <= now) seen.delete(k);
        if (seen.size >= maxKeys) key = '(other)';
      }
      const entry = seen.get(key);
      if (entry && entry.until > now) {
        entry.held += 1;
        return null;
      }
      seen.set(key, { until: now + windowMs, held: 0 });
      return { held: entry?.held ?? 0 };
    },
    size: () => seen.size,
  };
}
