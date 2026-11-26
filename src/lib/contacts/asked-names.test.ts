import { describe, expect, it } from 'vitest';

import {
  NAMES_RETRY_AFTER_MS,
  markAsked,
  markFailed,
  newAskedNames,
  stillWanted,
} from './asked-names';

describe('asked names', () => {
  it('asks a new id, and not again once asked', () => {
    const s = newAskedNames();
    expect(stillWanted(s, 'c:a', 0)).toBe(true);
    markAsked(s, ['c:a']);
    expect(stillWanted(s, 'c:a', 1)).toBe(false);
  });

  it('a failed read is asked again, but only after the delay', () => {
    const s = newAskedNames();
    markAsked(s, ['c:a']);
    markFailed(s, ['c:a'], 1000);
    expect(stillWanted(s, 'c:a', 1001)).toBe(false);
    expect(stillWanted(s, 'c:a', 1000 + NAMES_RETRY_AFTER_MS - 1)).toBe(false);
    expect(stillWanted(s, 'c:a', 1000 + NAMES_RETRY_AFTER_MS)).toBe(true);
  });

  it('a permanent error retries at most once per delay', () => {
    const s = newAskedNames();
    let asks = 0;
    for (let t = 0; t <= 120_000; t += 1000) {
      if (stillWanted(s, 'c:a', t)) {
        asks++;
        markAsked(s, ['c:a']);
        markFailed(s, ['c:a'], t);
      }
    }
    expect(asks).toBe(5); // 0, 30, 60, 90, 120 s
  });
});
