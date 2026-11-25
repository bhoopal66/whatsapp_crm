import { describe, expect, it } from 'vitest';

import { parseSkillList } from './skills-view';

describe('parseSkillList', () => {
  it('reads rows, drops broken ones, puts active first', () => {
    const list = parseSkillList([
      {
        id: 'b',
        kind: 'mistake',
        title: 'T2',
        principle: 'P2',
        status: 'retired',
        evidence_count: 2,
      },
      {
        id: 'a',
        kind: 'category',
        category: 'fees',
        title: 'T1',
        principle: 'P1',
        status: 'active',
        when_to_apply: 'always',
        created_at: '2026-11-24',
      },
      { id: 'c', kind: 'policy', title: 'x', principle: 'y' },
      { id: 'd', kind: 'general', title: '', principle: 'y' },
      null,
    ]);
    expect(list.map((s) => s.id)).toEqual(['a', 'b']);
    expect(list[0]).toMatchObject({
      category: 'fees',
      whenToApply: 'always',
      evidenceCount: 1,
    });
    expect(list[1]).toMatchObject({ status: 'retired', evidenceCount: 2 });
    expect(parseSkillList('nope')).toEqual([]);
  });
});
