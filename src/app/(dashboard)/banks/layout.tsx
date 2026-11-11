import type { ReactNode } from 'react';

import {
  AgentOnlyLayout,
  SalesOnlyLayout,
} from '@/components/auth/admin-only-layout';

// Partner banks (module 019) are agents and up, like Cases: a viewer or
// a bank guest is sent away on the server, whatever the sidebar shows.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <AgentOnlyLayout>
      <SalesOnlyLayout>{children}</SalesOnlyLayout>
    </AgentOnlyLayout>
  );
}
