import type { ReactNode } from 'react';

import { AgentOnlyLayout } from '@/components/auth/admin-only-layout';

// Submission groups (module 018a) are worked by agents and up: a viewer
// or a bank guest is sent away on the server, whatever the sidebar
// shows, and that covers /submission-groups/[id] too. Which groups each
// person gets back is the access list's call, server-side.
export default function Layout({ children }: { children: ReactNode }) {
  return <AgentOnlyLayout>{children}</AgentOnlyLayout>;
}
