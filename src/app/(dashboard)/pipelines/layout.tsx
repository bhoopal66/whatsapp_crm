import type { ReactNode } from 'react';

import { SalesOnlyLayout } from '@/components/auth/admin-only-layout';

// Pipelines are every staff member's (migration 080) except a
// restricted department (migration 192), sent to their own inbox on the
// server whatever the sidebar shows. See
// components/auth/admin-only-layout.tsx.
export default function Layout({ children }: { children: ReactNode }) {
  return <SalesOnlyLayout>{children}</SalesOnlyLayout>;
}
