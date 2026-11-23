import { describe, expect, it } from 'vitest';

import { isoDay } from './cover';
import { DeskBadRequest, optionalText, requireText } from './http';

describe('isoDay', () => {
  it('takes real days', () => {
    expect(isoDay('2026-02-28')).toBe('2026-02-28');
    expect(isoDay('2024-02-29')).toBe('2024-02-29');
  });
  it('refuses a day that does not exist or a year 0', () => {
    expect(isoDay('2026-02-30')).toBeNull();
    expect(isoDay('2026-13-01')).toBeNull();
    expect(isoDay('0000-01-01')).toBeNull();
    expect(isoDay('2026-2-3')).toBeNull();
    expect(isoDay(20260101)).toBeNull();
  });
});

describe('desk text fields', () => {
  it('rejects a NUL with the normal bad request', () => {
    expect(() => requireText('AB\u0000C', 50, 'ref')).toThrow(DeskBadRequest);
    expect(() => optionalText('\u0000', 50, 'note')).toThrow(DeskBadRequest);
  });
  it('still trims and bounds ordinary text', () => {
    expect(requireText('  TC-1 ', 50, 'ref')).toBe('TC-1');
    expect(optionalText('   ', 50, 'note')).toBeNull();
  });
});
