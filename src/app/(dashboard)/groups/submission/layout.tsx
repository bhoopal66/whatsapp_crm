import type { ReactNode } from 'react';

import { AgentOnlyLayout } from '@/components/auth/admin-only-layout';

// /groups is open to every staff member, but submission groups are
// worked by agents and up: the same guard as /submission-groups.
export default function Layout({ children }: { children: ReactNode }) {
  return <AgentOnlyLayout>{children}</AgentOnlyLayout>;
}
