import type { ReactNode } from 'react';

import { AdminOnlyLayout } from '@/components/auth/admin-only-layout';

// The Funnel report covers the whole account's sales pipeline: owners
// and admins only. The guard runs on the server, so a typed URL gets
// the same answer as a hidden link; the API route and funnel_report
// (migration 254) refuse anyone else as well.
export default function Layout({ children }: { children: ReactNode }) {
  return <AdminOnlyLayout>{children}</AdminOnlyLayout>;
}
