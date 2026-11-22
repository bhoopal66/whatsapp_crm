'use client';

/**
 * My worklist (package 029c): what needs action next, ranked in the
 * browser from reads other screens already make (`loadWorklistInputs`,
 * which never throws). There is no worklist API and nothing here
 * writes; each row opens its existing screen.
 */
import { useEffect, useMemo, useState } from 'react';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import {
  WORKLIST_MY_TEAM,
  WorklistView,
} from '@/components/worklist/worklist-view';
import { useAuth } from '@/hooks/use-auth';
import { useLedTeam } from '@/hooks/use-led-team';
import { createClient } from '@/lib/supabase/client';
import { loadWorklistInputs } from '@/lib/worklist/load';
import {
  rankWorklist,
  worklistMode,
  type WorklistInputs,
} from '@/lib/worklist/rank';

export default function WorklistPage() {
  const { user, accountId, accountRole, salesRestricted } = useAuth();
  const { members, nameOf } = useWorkspaceMembers();
  const team = useLedTeam();
  // Both are tagged with the workspace they belong to, so a workspace
  // switch shows loading and Anyone again without resetting state in an
  // effect. Ranked against the moment the reads were made.
  const [loaded, setLoaded] = useState<{
    accountId: string;
    inputs: WorklistInputs;
    now: number;
  } | null>(null);
  const [filter, setFilter] = useState({ accountId, userId: '' });
  const assignedTo = filter.accountId === accountId ? filter.userId : '';
  const teamView = assignedTo === WORKLIST_MY_TEAM && team.canLead;
  // null while the profile loads: not the same as a guest's empty list.
  const mode = accountRole === null ? null : worklistMode(accountRole);

  useEffect(() => {
    if (!accountId) return;
    let live = true;
    const now = Date.now();
    void loadWorklistInputs(createClient(), fetch, now, {
      cases: !salesRestricted,
    }).then((inputs) => {
      if (live) setLoaded({ accountId, inputs, now });
    });
    return () => {
      live = false;
    };
  }, [accountId, salesRestricted]);

  const items = useMemo(
    () =>
      loaded === null ||
      loaded.accountId !== accountId ||
      !user ||
      // "My team" waits for the roster rather than flash everyone's.
      (teamView && team.ids === null)
        ? null
        : rankWorklist(loaded.inputs, loaded.now, {
            userId: user.id,
            role: accountRole,
            ...(teamView
              ? { team: team.ids }
              : assignedTo && assignedTo !== WORKLIST_MY_TEAM
                ? { assignedTo }
                : {}),
          }),
    [loaded, accountId, user, accountRole, assignedTo, teamView, team.ids]
  );

  const options = useMemo(
    () =>
      members.map((m) => ({
        userId: m.user_id,
        name: m.full_name || m.email,
      })),
    [members]
  );

  return (
    <WorklistView
      items={items}
      mode={mode}
      nameOf={nameOf}
      assignedTo={assignedTo}
      onAssignedTo={(userId) => setFilter({ accountId, userId })}
      members={options}
      teamOption={team.canLead}
      noTeam={teamView && team.ids !== null && team.ids.length <= 1}
      now={loaded?.now ?? 0}
    />
  );
}
