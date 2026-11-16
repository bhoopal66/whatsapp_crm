/**
 * Which "Recruiter AI drafts" switches the HR setup screen offers.
 * Mirrors `hr_agent_settings_set` (admin or recruiter lead may write;
 * the SQL re-checks). A specialist is disabled while the master switch
 * (orchestrator) is off, since nothing runs at all then.
 */
import { canEditRule } from '@/lib/hr/access';
import type { HrRoles } from '@/lib/hr/types';

import { AGENT_KINDS, type AgentKind } from './types';

export interface AgentSwitchView {
  /** Admins and anyone on the recruiter team see the section. */
  visible: boolean;
  /** Per kind: shown but not togglable. */
  disabled: Record<AgentKind, boolean>;
}

export function agentSwitchView(
  roles: HrRoles,
  settings: Record<AgentKind, boolean>
): AgentSwitchView {
  const visible = roles.admin || roles.recruiter !== null;
  const editable = canEditRule(roles, 'recruiter');
  const masterOn = settings.orchestrator === true;
  const disabled = Object.fromEntries(
    AGENT_KINDS.map((k) => [
      k,
      !editable || (k !== 'orchestrator' && !masterOn),
    ])
  ) as Record<AgentKind, boolean>;
  return { visible, disabled };
}
