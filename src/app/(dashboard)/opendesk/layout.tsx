import type { ReactNode } from 'react';

import { AdminOnlyLayout } from '@/components/auth/admin-only-layout';

// Contacts the OpenDesk sales app marked Interested — PII from outside
// the CRM, readable by admin+ only (migration 139's RLS says the same).
// The guard runs on the server; see components/auth/admin-only-layout.tsx.
export default function Layout({ children }: { children: ReactNode }) {
  return <AdminOnlyLayout>{children}</AdminOnlyLayout>;
}
