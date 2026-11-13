import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEPARTMENT_DEFAULTS,
  DEPARTMENTS,
  isRestrictedPath,
  mergeDepartmentSettings,
  isSalesRestricted,
  toDepartment,
} from './departments';

describe('departments', () => {
  it('has a default for every department; only HR is restricted', () => {
    expect(Object.keys(DEPARTMENT_DEFAULTS).sort()).toEqual(
      [...DEPARTMENTS].sort()
    );
    expect(
      DEPARTMENTS.filter((d) => DEPARTMENT_DEFAULTS[d].restricted)
    ).toEqual(['hr']);
  });

  it('reads NULL, missing or unknown as sales', () => {
    expect(toDepartment(null)).toBe('sales');
    expect(toDepartment(undefined)).toBe('sales');
    expect(toDepartment('marketing')).toBe('sales');
    expect(toDepartment('hr')).toBe('hr');
  });
});

describe('isSalesRestricted', () => {
  it.each(['agent', 'team_leader', 'viewer', 'bank_guest'] as const)(
    'restricts a %s in a restricted department',
    (role) => {
      expect(
        isSalesRestricted({ role, department: 'hr', restricted: true })
      ).toBe(true);
    }
  );

  it.each(['owner', 'admin'] as const)('never restricts an %s', (role) => {
    expect(
      isSalesRestricted({ role, department: 'hr', restricted: true })
    ).toBe(false);
  });

  it('follows the account: an unrestricted department is not restricted', () => {
    expect(
      isSalesRestricted({ role: 'agent', department: 'hr', restricted: false })
    ).toBe(false);
  });

  it('restricts nobody before the role is known', () => {
    expect(isSalesRestricted({ role: null, restricted: true })).toBe(false);
  });
});

describe('isRestrictedPath', () => {
  it.each([
    '/pipelines',
    '/cases/abc',
    '/banks',
    '/brain',
    '/digest',
    '/submission-groups/x',
    '/groups',
    '/broadcasts/new',
    '/automations',
    '/flows/1',
    '/journeys',
    '/agents',
    '/compass',
    '/opendesk',
    '/team-contacts',
    '/team-contacts/abc',
  ])('closes %s', (path) => {
    expect(isRestrictedPath(path)).toBe(true);
  });

  it.each([
    '/inbox',
    '/team-inbox',
    '/contacts',
    '/contacts/',
    '/contacts/abc',
    '/chat',
    '/calendar',
    '/meetings',
    '/settings',
    '/calls',
    '/notifications',
    '/dashboard',
    '/groupsx',
  ])('leaves %s open', (path) => {
    expect(isRestrictedPath(path)).toBe(false);
  });
});

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/192_departments.sql'),
  'utf8'
);

describe('DEPARTMENT_DEFAULTS match migration 192', () => {
  // Each function ends its COALESCE with `p_department IS NOT DISTINCT
  // FROM '<dept>'`: the one department that is on without a row.
  function onWithoutRow(fn: string): string[] {
    const body = SQL.split(`FUNCTION public.${fn}(p_account`)[1].split(
      '$$;'
    )[0];
    return [...body.matchAll(/IS NOT DISTINCT FROM '([a-z]+)'/g)].map(
      (m) => m[1]
    );
  }

  it('own_inbox is on for hr only', () => {
    expect(onWithoutRow('department_own_inbox')).toEqual(['hr']);
    expect(DEPARTMENTS.filter((d) => DEPARTMENT_DEFAULTS[d].own_inbox)).toEqual(
      ['hr']
    );
  });

  it('restricted is on for hr only', () => {
    expect(onWithoutRow('department_restricted')).toEqual(['hr']);
    expect(
      DEPARTMENTS.filter((d) => DEPARTMENT_DEFAULTS[d].restricted)
    ).toEqual(['hr']);
  });
});

describe('mergeDepartmentSettings', () => {
  it('is the defaults with no rows', () => {
    expect(mergeDepartmentSettings(null)).toEqual(DEPARTMENT_DEFAULTS);
    expect(mergeDepartmentSettings([])).toEqual(DEPARTMENT_DEFAULTS);
  });

  it('lets a saved row win and ignores malformed ones', () => {
    const merged = mergeDepartmentSettings([
      { department: 'hr', own_inbox: false, restricted: true },
      { department: 'it', own_inbox: true, restricted: true },
      { department: 'marketing', own_inbox: true, restricted: true },
      { department: 'accounts', own_inbox: 'yes', restricted: true },
    ]);
    expect(merged.hr).toEqual({ own_inbox: false, restricted: true });
    expect(merged.it).toEqual({ own_inbox: true, restricted: true });
    expect(merged.accounts).toEqual(DEPARTMENT_DEFAULTS.accounts);
    expect(merged.sales).toEqual(DEPARTMENT_DEFAULTS.sales);
  });
});
