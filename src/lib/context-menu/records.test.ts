import { describe, expect, it } from 'vitest';

import { moveTargets } from './records';

const stages = [
  { id: 'c', name: 'Won', position: 2 },
  { id: 'a', name: 'New', position: 0 },
  { id: 'b', name: 'Contacted', position: 1 },
];

describe('moveTargets', () => {
  it('offers every other stage in board order', () => {
    expect(moveTargets(stages, 'b', false).map((s) => s.id)).toEqual([
      'a',
      'c',
    ]);
  });

  it('offers nothing on a read-only board', () => {
    expect(moveTargets(stages, 'b', true)).toEqual([]);
  });

  it('offers every stage when the deal is in none of them', () => {
    expect(moveTargets(stages, 'gone', false).map((s) => s.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('does not reorder the caller’s array', () => {
    const input = [...stages];
    moveTargets(input, 'a', false);
    expect(input).toEqual(stages);
  });
});
