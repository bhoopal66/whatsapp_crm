import { describe, expect, it } from 'vitest';

import { dubaiDay } from './day';

describe('dubaiDay', () => {
  it('turns at midnight in Dubai, 20:00 UTC', () => {
    expect(dubaiDay(new Date('2026-11-10T19:59:59Z'))).toBe('2026-11-10');
    expect(dubaiDay(new Date('2026-11-10T20:00:00Z'))).toBe('2026-11-11');
    expect(dubaiDay(new Date('2026-12-31T22:00:00Z'))).toBe('2027-01-01');
  });
});
