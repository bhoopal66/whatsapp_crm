import type { ReactNode } from 'react';

import {
  AgentOnlyLayout,
  SalesOnlyLayout,
} from '@/components/auth/admin-only-layout';

// The second brain (package 022e) is staff work, like Cases: agents and
// up, outside a restricted department, guarded here on the server
// whatever the sidebar shows. Whether it is switched on, and what each
// person gets back, is the /api/brain routes' call.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <AgentOnlyLayout>
      <SalesOnlyLayout>{children}</SalesOnlyLayout>
    </AgentOnlyLayout>
  );
}
