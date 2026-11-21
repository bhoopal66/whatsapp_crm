import type { ReactNode } from 'react';

import {
  AgentOnlyLayout,
  SalesOnlyLayout,
} from '@/components/auth/admin-only-layout';

// The case desk (migration 220) is staff work like Cases: agents and up,
// sales areas only. Who may sort which queue is Postgres's call.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <AgentOnlyLayout>
      <SalesOnlyLayout>{children}</SalesOnlyLayout>
    </AgentOnlyLayout>
  );
}
