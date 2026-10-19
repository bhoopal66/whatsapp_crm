import type { ReactNode } from 'react';

import { AgentOnlyLayout } from '@/components/auth/admin-only-layout';

// Partner banks (module 019) are agents and up, like Cases: a viewer or
// a bank guest is sent away on the server, whatever the sidebar shows.
// The pages under it come in a later job.
export default function Layout({ children }: { children: ReactNode }) {
  return <AgentOnlyLayout>{children}</AgentOnlyLayout>;
}
