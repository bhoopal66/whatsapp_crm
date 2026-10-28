import { describe, expect, it } from 'vitest';

import type { AccountRole } from '@/lib/auth/roles';
import { homeWidgets, type HomeContext } from './widgets';

const ALL: HomeContext = { pbx: true, phoneNumbers: true };
const NONE: HomeContext = { pbx: false, phoneNumbers: false };

const sorted = (role: AccountRole | null, ctx: HomeContext) =>
  [...homeWidgets(role, ctx)].sort();

describe('homeWidgets', () => {
  it('gives nothing while the role loads, or to a bank guest', () => {
    expect(sorted(null, ALL)).toEqual([]);
    expect(sorted('bank_guest', ALL)).toEqual([]);
  });

  it('gives a viewer the read-only widgets', () => {
    expect(sorted('viewer', ALL)).toEqual([
      'agenda',
      'attention',
      'calls',
      'pipeline',
      'trends',
    ]);
  });

  it('gives an agent their own work, but no team or admin panels', () => {
    expect(sorted('agent', ALL)).toEqual([
      'agenda',
      'attention',
      'calls',
      'cases',
      'outreach',
      'pipeline',
      'tasks',
      'trends',
    ]);
  });

  it('adds team activity for a team leader', () => {
    const widgets = homeWidgets('team_leader', ALL);
    expect(widgets.has('team')).toBe(true);
    expect(widgets.has('numbers')).toBe(false);
    expect(widgets.has('campaigns')).toBe(false);
  });

  it('gives admins and owners everything', () => {
    for (const role of ['admin', 'owner'] as const) {
      expect(homeWidgets(role, ALL).size).toBe(11);
    }
  });

  it('leaves out calls without a phone system and outreach without a phone number', () => {
    const widgets = homeWidgets('owner', NONE);
    expect(widgets.has('calls')).toBe(false);
    expect(widgets.has('outreach')).toBe(false);
    expect(widgets.has('tasks')).toBe(true);
  });
});
