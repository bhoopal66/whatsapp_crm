import type { ReactNode } from 'react';

import {
  SalesOnlyLayout,
  TeamLeaderOnlyLayout,
} from '@/components/auth/admin-only-layout';

// Declined recycling (migration 251): team leaders and up. A bank guest
// and anyone below team leader are sent away on the server; which
// customers come back is Postgres's call (contacts RLS through the
// SECURITY INVOKER `recycle_candidates`). Restricted departments (HR …)
// have no sales areas, so this joins them.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <TeamLeaderOnlyLayout>
      <SalesOnlyLayout>{children}</SalesOnlyLayout>
    </TeamLeaderOnlyLayout>
  );
}
