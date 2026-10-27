import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  canonicalPair,
  DM_CLASSES,
  DM_PAIRS,
  DM_SCOPES,
  openMatrix,
  pairKey,
  RECOMMENDED_DM_RULES,
  rowsToSave,
  rulesFromRows,
  sameRules,
  scopeOf,
  withScope,
} from '../dm-rules';

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/143_chat_dm_rules.sql'),
  'utf8'
);

/** The values of `<column> text NOT NULL CHECK (<column> IN (...))`. */
function checkList(column: string): string[] {
  const m = SQL.match(
    new RegExp(
      `${column}\\s+text\\s+NOT NULL CHECK \\(${column} IN \\(([^)]*)\\)`
    )
  );
  if (!m) throw new Error(`no CHECK for ${column}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('dm rules mirror migration 143', () => {
  it('has the CHECK constraint lists for classes and scopes', () => {
    expect([...DM_CLASSES].sort()).toEqual(checkList('class_a').sort());
    expect([...DM_CLASSES].sort()).toEqual(checkList('class_b').sort());
    expect([...DM_SCOPES].sort()).toEqual(checkList('scope').sort());
  });

  it('orders a pair as the canonical CHECK does (class_a <= class_b)', () => {
    for (const [a, b] of DM_PAIRS) {
      const [x, y] = canonicalPair(b, a);
      expect(x <= y).toBe(true);
    }
    expect(canonicalPair('team_leader', 'agent')).toEqual([
      'agent',
      'team_leader',
    ]);
  });
});

describe('dm rules matrix', () => {
  it('has one key per unordered pair', () => {
    expect(DM_PAIRS).toHaveLength(15);
    expect(pairKey('agent', 'admin')).toBe(pairKey('admin', 'agent'));
    expect(new Set(DM_PAIRS.map(([a, b]) => pairKey(a, b))).size).toBe(15);
  });

  it('reads absent pairs as all and ignores bad rows', () => {
    const m = rulesFromRows([
      { class_a: 'agent', class_b: 'agent', scope: 'none' },
      { class_a: 'agent', class_b: 'team_leader', scope: 'team' },
      { class_a: 'owner', class_b: 'agent', scope: 'none' },
      { class_a: 'admin', class_b: 'agent', scope: 'sometimes' },
    ]);
    expect(scopeOf(m, 'agent', 'agent')).toBe('none');
    expect(scopeOf(m, 'team_leader', 'agent')).toBe('team');
    expect(scopeOf(m, 'agent', 'admin')).toBe('all');
    expect(sameRules(rulesFromRows(null), openMatrix())).toBe(true);
  });

  it('changes both directions of a pair at once', () => {
    const m = withScope(openMatrix(), 'agent', 'team_leader', 'none');
    expect(scopeOf(m, 'team_leader', 'agent')).toBe('none');
    expect(scopeOf(m, 'agent', 'team_leader')).toBe('none');
  });

  it('saves only restricting pairs, in canonical order, and round-trips', () => {
    expect(rowsToSave(openMatrix())).toEqual([]);
    const m = withScope(
      withScope(openMatrix(), 'viewer', 'agent', 'none'),
      'team_leader',
      'agent',
      'team'
    );
    const rows = rowsToSave(m);
    expect(rows).toEqual([
      { class_a: 'agent', class_b: 'team_leader', scope: 'team' },
      { class_a: 'agent', class_b: 'viewer', scope: 'none' },
    ]);
    expect(sameRules(rulesFromRows(rows), m)).toBe(true);
  });

  it('recommends: agents reach their team leader, admins and coordinators', () => {
    const r = RECOMMENDED_DM_RULES;
    expect(scopeOf(r, 'agent', 'agent')).toBe('none');
    expect(scopeOf(r, 'viewer', 'viewer')).toBe('none');
    expect(scopeOf(r, 'agent', 'viewer')).toBe('none');
    expect(scopeOf(r, 'agent', 'team_leader')).toBe('team');
    expect(scopeOf(r, 'viewer', 'team_leader')).toBe('team');
    expect(scopeOf(r, 'agent', 'admin')).toBe('all');
    expect(scopeOf(r, 'agent', 'coordinator')).toBe('all');
    expect(scopeOf(r, 'team_leader', 'team_leader')).toBe('all');
    expect(rowsToSave(r)).toHaveLength(5);
  });
});
