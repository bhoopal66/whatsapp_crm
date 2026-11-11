import { describe, expect, it } from 'vitest';

import {
  DEPARTMENT_DEFAULTS,
  DEPARTMENTS,
  isRestrictedPath,
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
    '/submission-groups/x',
    '/groups',
    '/broadcasts/new',
    '/automations',
    '/flows/1',
    '/journeys',
    '/agents',
    '/compass',
    '/opendesk',
    '/team-inbox',
    '/team-contacts',
    '/contacts',
    '/contacts/',
  ])('closes %s', (path) => {
    expect(isRestrictedPath(path)).toBe(true);
  });

  it.each([
    '/inbox',
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
