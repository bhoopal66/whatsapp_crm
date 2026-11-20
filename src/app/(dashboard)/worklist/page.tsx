'use client';

/**
 * My worklist (package 029c): what needs action next, ranked in the
 * browser from reads other screens already make (`loadWorklistInputs`,
 * which never throws). There is no worklist API and nothing here
 * writes; each row opens its existing screen.
 */
import { useEffect, useMemo, useState } from 'react';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { WorklistView } from '@/components/worklist/worklist-view';
import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import { loadWorklistInputs } from '@/lib/worklist/load';
import {
  rankWorklist,
  worklistMode,
  type WorklistInputs,
} from '@/lib/worklist/rank';

export default function WorklistPage() {
  const { user, accountId, accountRole } = useAuth();
  const { members, nameOf } = useWorkspaceMembers();
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
  // null while the profile loads: not the same as a guest's empty list.
  const mode = accountRole === null ? null : worklistMode(accountRole);

  useEffect(() => {
    if (!accountId) return;
    let live = true;
    const now = Date.now();
    void loadWorklistInputs(createClient(), fetch, now).then((inputs) => {
      if (live) setLoaded({ accountId, inputs, now });
    });
    return () => {
      live = false;
    };
  }, [accountId]);

  const items = useMemo(
    () =>
      loaded === null || loaded.accountId !== accountId || !user
        ? null
        : rankWorklist(loaded.inputs, loaded.now, {
            userId: user.id,
            role: accountRole,
            ...(assignedTo ? { assignedTo } : {}),
          }),
    [loaded, accountId, user, accountRole, assignedTo]
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
    />
  );
}
