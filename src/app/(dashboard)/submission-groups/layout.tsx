import type { ReactNode } from 'react';

import { AgentOnlyLayout } from '@/components/auth/admin-only-layout';
import { SubmissionGroupsWorkspace } from '@/components/submission-groups/submission-groups-workspace';

// Submission groups (module 018a) are worked by agents and up: a viewer
// or a bank guest is sent away on the server, whatever the sidebar
// shows, and that covers /submission-groups/[id] too. Which groups each
// person gets back is the access list's call, server-side.
//
// Inside the guard, the split view: the list stays mounted here while
// the selected submission (the child route) changes beside it.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <AgentOnlyLayout>
      <SubmissionGroupsWorkspace>{children}</SubmissionGroupsWorkspace>
    </AgentOnlyLayout>
  );
}
