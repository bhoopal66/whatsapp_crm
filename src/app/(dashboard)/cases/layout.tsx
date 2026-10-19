import type { ReactNode } from 'react';

import { AgentOnlyLayout } from '@/components/auth/admin-only-layout';

// Cases (module 019) are worked by agents and up: a viewer or a bank
// guest is sent away on the server, whatever the sidebar shows, and that
// covers /cases/[id] too. Which cases each person gets back is
// Postgres's call (`case_inbox`, case_role), server-side.
export default function Layout({ children }: { children: ReactNode }) {
  return <AgentOnlyLayout>{children}</AgentOnlyLayout>;
}
