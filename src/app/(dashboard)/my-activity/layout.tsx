import type { ReactNode } from 'react';

import { AgentOnlyLayout } from '@/components/auth/admin-only-layout';

// A person's own sending record against the Team activity limits:
// anyone who sends messages (agent and up). The report route narrows an
// agent to their own row (migration 205) and answers 403 while an admin
// has switched the view off; the page also narrows a leader's or
// admin's wider report to their own row.
export default function Layout({ children }: { children: ReactNode }) {
  return <AgentOnlyLayout>{children}</AgentOnlyLayout>;
}
