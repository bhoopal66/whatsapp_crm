import { describe, expect, it } from 'vitest';

import { diffManagers, planManagerNumbers } from './manager-numbers';

describe('diffManagers', () => {
  it('finds new and dropped managers, never dropping the creator', () => {
    expect(
      diffManagers({
        before: ['c', 'a', 'b'],
        after: ['b', 'd'],
        creatorId: 'c',
      })
    ).toEqual({ added: ['d'], removed: ['a'] });
  });
});

describe('planManagerNumbers', () => {
  const names = new Map([
    ['k', 'Kabita'],
    ['r', 'Roshani'],
    ['n', 'Nobody'],
    ['o', 'Ours'],
  ]);
  const base = {
    names,
    participants: ['971500000002', '12345@lid'],
    ourNumber: '971509999999',
    block: null,
  };

  it('adds a new manager number and removes a dropped one', () => {
    const plan = planManagerNumbers({
      ...base,
      added: ['k', 'n'],
      removed: ['r'],
      phones: new Map([
        ['k', '+971 50 000 0001'],
        ['r', '971500000002'],
        ['n', null],
      ]),
    });
    expect(plan).toEqual({
      add: [{ userId: 'k', name: 'Kabita', waId: '971500000001' }],
      remove: [{ userId: 'r', name: 'Roshani', waId: '971500000002' }],
      skipped: [],
    });
  });

  it('skips numbers already in (or already out of) the group and our own', () => {
    const plan = planManagerNumbers({
      ...base,
      added: ['r', 'o'],
      removed: ['k'],
      phones: new Map([
        ['r', '971500000002'],
        ['o', '971509999999'],
        ['k', '971500000001'],
      ]),
    });
    expect(plan).toEqual({ add: [], remove: [], skipped: [] });
  });

  it('never matches a LID participant', () => {
    const plan = planManagerNumbers({
      ...base,
      added: ['k'],
      removed: [],
      phones: new Map([['k', '12345']]),
    });
    expect(plan.add.map((c) => c.waId)).toEqual(['12345']);
  });

  it('reports the block instead of planning a change', () => {
    const plan = planManagerNumbers({
      ...base,
      block: 'not_group_admin',
      added: ['k'],
      removed: ['r'],
      phones: new Map([
        ['k', '971500000001'],
        ['r', '971500000002'],
      ]),
    });
    expect(plan).toEqual({
      add: [],
      remove: [],
      skipped: [
        { name: 'Kabita', reason: 'not_group_admin' },
        { name: 'Roshani', reason: 'not_group_admin' },
      ],
    });
  });
});
