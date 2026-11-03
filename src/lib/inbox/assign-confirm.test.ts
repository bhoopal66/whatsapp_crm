import { describe, expect, it } from 'vitest';

import { assignChangeKind } from './assign-confirm';

describe('assignChangeKind', () => {
  it('names a first assignment', () => {
    expect(assignChangeKind(null, 'u1')).toBe('assign');
  });

  it('names a hand-over to someone else', () => {
    expect(assignChangeKind('u1', 'u2')).toBe('reassign');
  });

  it('names an unassign', () => {
    expect(assignChangeKind('u1', null)).toBe('unassign');
  });

  it('is null when nothing would change', () => {
    expect(assignChangeKind('u1', 'u1')).toBeNull();
    expect(assignChangeKind(null, null)).toBeNull();
  });
});
