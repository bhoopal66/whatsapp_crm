// Pins the TS access mirrors to migration 122 by reading the SQL: the role
// list case_role can produce, the bodies of case_rule_can_read / _write /
// _reassign, view_case's audit rule and the refusal HINTs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AUDITED_VIEWER_ROLES,
  canReadCase,
  canReassignCase,
  canWriteCase,
  isManagedExternally,
} from './access';
import { BANK_DASHBOARD_REFUSALS } from './dashboard';
import { CASE_REFUSALS, CASE_ROLES } from './types';

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/122_cases.sql'),
  'utf8'
);

/** The body of `CREATE OR REPLACE FUNCTION public.<name>(` up to its closing `$$;`. */
function body(name: string): string {
  const start = SQL.indexOf(`FUNCTION public.${name}(`);
  if (start < 0) throw new Error(`${name} not in 122`);
  const open = SQL.indexOf('$$', start);
  const close = SQL.indexOf('$$', open + 2);
  return SQL.slice(open + 2, close);
}

const quoted = (s: string): string[] =>
  [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);

function ruleRoles(name: string): string[] {
  const m = /p_role IN \(([^)]*)\)/.exec(body(name));
  if (!m) throw new Error(`${name}: no role list`);
  return quoted(m[1]!);
}

describe('case access mirrors match migration 122', () => {
  it('CASE_ROLES are exactly the roles case_role can return', () => {
    const roles = [...body('case_role').matchAll(/THEN '([a-z_]+)'/g)].map(
      (m) => m[1]
    );
    expect(new Set(roles)).toEqual(new Set(CASE_ROLES));
  });

  it('canReadCase: case_rule_can_read is "any role"', () => {
    expect(body('case_rule_can_read').trim()).toBe('SELECT p_role IS NOT NULL');
    for (const r of CASE_ROLES) expect(canReadCase(r)).toBe(true);
    expect(canReadCase(null)).toBe(false);
  });

  it.each([
    ['case_rule_can_write', canWriteCase],
    ['case_rule_can_reassign', canReassignCase],
  ] as const)('%s', (name, fn) => {
    const allowed = ruleRoles(name);
    for (const r of CASE_ROLES)
      expect([r, fn(r)]).toEqual([r, allowed.includes(r)]);
    expect(fn(null)).toBe(false);
  });

  it('AUDITED_VIEWER_ROLES: view_case audits every role but agent', () => {
    expect(body('view_case')).toContain("ok.viewer_role <> 'agent'");
    expect(new Set(AUDITED_VIEWER_ROLES)).toEqual(
      new Set(CASE_ROLES.filter((r) => r !== 'agent'))
    );
  });

  it('CASE_REFUSALS are exactly the case HINTs 122-124 and 130 raise', () => {
    const sql = ['122_cases.sql', '123_case_tools.sql', '124_case_sla.sql']
      .map((f) =>
        readFileSync(join(process.cwd(), 'supabase/migrations', f), 'utf8')
      )
      .join('\n');
    const hints = [...sql.matchAll(/HINT = '([A-Z_]+)'/g)].map((m) => m[1]);
    // 130 also replaces 125's inbox (its own refusals) and 127's outcome
    // reason (BANK_DASHBOARD_REFUSALS); every other HINT it raises is a
    // case refusal.
    const sql130 = readFileSync(
      join(process.cwd(), 'supabase/migrations/130_case_leads.sql'),
      'utf8'
    );
    const elsewhere = new Set<string>([
      ...BANK_DASHBOARD_REFUSALS.filter((c) => c !== 'NOT_ALLOWED'),
      'FILTER_INVALID',
      'CURSOR_INVALID',
      'LIMIT_INVALID',
      'NOW_REQUIRED',
    ]);
    const hints130 = [...sql130.matchAll(/HINT = '([A-Z_]+)'/g)]
      .map((m) => m[1])
      .filter((h) => !elsewhere.has(h));
    // 134 adds the Compass lock and its setting's refusal; its other HINTs
    // are case_sync_from_submission's (the v1 API, not a case route).
    const ours134 = ['MANAGED_EXTERNALLY', 'SETTING_INVALID'];
    const sql134 = readFileSync(
      join(process.cwd(), 'supabase/migrations/134_compass_case_sync.sql'),
      'utf8'
    );
    for (const h of ours134) expect(sql134).toContain(`HINT = '${h}'`);
    expect(new Set(CASE_REFUSALS)).toEqual(
      new Set([...hints, ...hints130, ...ours134])
    );
  });
});

describe('isManagedExternally matches migration 134', () => {
  const SQL134 = readFileSync(
    join(process.cwd(), 'supabase/migrations/134_compass_case_sync.sql'),
    'utf8'
  );
  const LOCK =
    'c.group_id IS NOT NULL AND public.case_managed_externally(c.account_id)';

  it('locks exactly case_set_stage, case_set_details, case_outcome_reason_set and case_doc_set_status, on group_id', () => {
    const locked = [
      ...SQL134.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(/g),
    ]
      .filter((m) => {
        const open = SQL134.indexOf('$$', m.index);
        const close = SQL134.indexOf('$$', open + 2);
        return SQL134.slice(open, close).includes(LOCK);
      })
      .map((m) => m[1]);
    expect(locked.sort()).toEqual(
      [
        'case_doc_set_status',
        'case_outcome_reason_set',
        'case_set_details',
        'case_set_stage',
      ].sort()
    );
  });

  it('is on only for a submitted case of an account with the setting on', () => {
    const on = { managedExternally: true };
    const off = { managedExternally: false };
    expect(isManagedExternally(on, { groupId: 'g' })).toBe(true);
    expect(isManagedExternally(on, { groupId: null })).toBe(false);
    expect(isManagedExternally(off, { groupId: 'g' })).toBe(false);
    expect(isManagedExternally(null, { groupId: 'g' })).toBe(false);
  });
});
