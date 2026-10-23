import { describe, expect, it } from 'vitest';

import { inPostgresRange } from './pg-date';

describe('inPostgresRange', () => {
  it('accepts ordinary dates', () => {
    expect(inPostgresRange(new Date('2026-10-23T10:00:00Z'))).toBe(true);
    expect(inPostgresRange(new Date('0001-01-01T00:00:00Z'))).toBe(true);
    expect(inPostgresRange(new Date('9999-12-31T23:59:59Z'))).toBe(true);
  });

  it('refuses extended years and invalid dates', () => {
    expect(inPostgresRange(new Date('+010000-01-01'))).toBe(false);
    expect(inPostgresRange(new Date('-000001-01-01'))).toBe(false);
    expect(inPostgresRange(new Date('nope'))).toBe(false);
  });
});
