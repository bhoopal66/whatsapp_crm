import type { ReactNode } from 'react';

import {
  AgentOnlyLayout,
  SalesOnlyLayout,
} from '@/components/auth/admin-only-layout';

// The second brain's Daily digest (package 022e), guarded like /brain:
// agents and up, outside a restricted department. Whether it is
// switched on, and whose digest a caller may read, is the API's call.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <AgentOnlyLayout>
      <SalesOnlyLayout>{children}</SalesOnlyLayout>
    </AgentOnlyLayout>
  );
}
