import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HR_TABS, hrLandingPath, visibleHrTabs } from './tabs';
import type { HrRoles } from './types';

const roles = (over: Partial<HrRoles>): HrRoles =>
  ({ admin: false, recruiter: null, dept: null, ...over }) as HrRoles;

describe('HR tabs', () => {
  it('gives owners and admins every tab by role, even with the roles read failed', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(visibleHrTabs(null, role).map((t) => t.href)).toEqual(
        HR_TABS.map((t) => t.href)
      );
      expect(hrLandingPath(null, role)).toBe('/hr/recruiter');
    }
  });

  it('keeps the per-tab HR roles for everyone else', () => {
    expect(visibleHrTabs(null, 'team_leader')).toEqual([]);
    expect(hrLandingPath(null, 'agent')).toBeNull();
    const dept = visibleHrTabs(roles({ dept: 'member' }), 'agent');
    expect(dept.map((t) => t.href)).toContain('/hr/department');
    expect(dept.map((t) => t.href)).not.toContain('/hr/recruiter');
    expect(hrLandingPath(roles({ dept: 'member' }), 'agent')).toBe(
      '/hr/department'
    );
  });

  it('passes the account role from the page and the tab bar', () => {
    for (const file of [
      'app/(dashboard)/hr/page.tsx',
      'components/hr/hr-tabs.tsx',
    ]) {
      const source = readFileSync(join(process.cwd(), 'src', file), 'utf8');
      expect(source, file).toMatch(
        /(hrLandingPath|visibleHrTabs)\(roles, profileLoading \? null : accountRole\)/
      );
    }
  });

  it('offers a retry on /hr instead of waiting for ever', () => {
    const page = readFileSync(
      join(process.cwd(), 'src', 'app', '(dashboard)', 'hr', 'page.tsx'),
      'utf8'
    );
    expect(page).toContain('onRetry={retry}');
  });
});
