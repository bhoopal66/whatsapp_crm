import { describe, expect, it } from 'vitest';

import type { HrRoles } from '@/lib/hr/types';

import { agentSwitchView } from './setup-switches';
import { AGENT_KINDS, type AgentKind } from './types';

const all = (v: boolean) =>
  Object.fromEntries(AGENT_KINDS.map((k) => [k, v])) as Record<
    AgentKind,
    boolean
  >;
const roles = (r: Partial<HrRoles>): HrRoles => ({
  admin: false,
  recruiter: null,
  dept: null,
  ...r,
});

describe('agentSwitchView', () => {
  it('lets an admin and a recruiter lead edit everything while on', () => {
    for (const r of [roles({ admin: true }), roles({ recruiter: 'lead' })]) {
      const v = agentSwitchView(r, all(true));
      expect(v.visible).toBe(true);
      expect(AGENT_KINDS.every((k) => !v.disabled[k])).toBe(true);
    }
  });

  it('shows a recruiter member everything read only', () => {
    const v = agentSwitchView(roles({ recruiter: 'member' }), all(true));
    expect(v.visible).toBe(true);
    expect(AGENT_KINDS.every((k) => v.disabled[k])).toBe(true);
  });

  it('hides the section without a recruiter role', () => {
    expect(agentSwitchView(roles({}), all(true)).visible).toBe(false);
    expect(agentSwitchView(roles({ dept: 'lead' }), all(true)).visible).toBe(
      false
    );
  });

  it('disables the specialists, not the master, while the master is off', () => {
    const v = agentSwitchView(roles({ admin: true }), all(false));
    expect(v.disabled.orchestrator).toBe(false);
    for (const k of AGENT_KINDS.filter((k) => k !== 'orchestrator')) {
      expect(v.disabled[k]).toBe(true);
    }
  });
});
