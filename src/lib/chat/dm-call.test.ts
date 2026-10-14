import { describe, expect, it } from 'vitest';
import { dmCallTarget } from './dm-call';

const base = {
  kind: 'dm',
  others: ['U-1'],
  extensionsByUser: new Map([['u-1', '102']]),
  hasPhone: true,
  role: 'agent' as const,
};

describe('dmCallTarget', () => {
  it('returns the peer extension', () => {
    expect(dmCallTarget(base)).toBe('102');
  });
  it('is null when not a dm', () => {
    expect(dmCallTarget({ ...base, kind: 'team' })).toBeNull();
  });
  it('is null for a group dm', () => {
    expect(dmCallTarget({ ...base, others: ['u-1', 'u-2'] })).toBeNull();
    expect(dmCallTarget({ ...base, others: [] })).toBeNull();
  });
  it('is null when the peer has no extension', () => {
    expect(dmCallTarget({ ...base, extensionsByUser: new Map() })).toBeNull();
  });
  it('is null when the caller has no phone', () => {
    expect(dmCallTarget({ ...base, hasPhone: false })).toBeNull();
  });
  it('is null for a bank guest or unknown role', () => {
    expect(dmCallTarget({ ...base, role: 'bank_guest' })).toBeNull();
    expect(dmCallTarget({ ...base, role: null })).toBeNull();
  });
});
