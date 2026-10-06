import type { ReactNode } from 'react';

import { AdminOnlyLayout } from '@/components/auth/admin-only-layout';

// Customer records synced from Taamul Compass (the ERP) — PII from
// outside the CRM, readable by admin+ only (migration 056's RLS says
// the same). The guard runs on the server; see
// components/auth/admin-only-layout.tsx.
export default function Layout({ children }: { children: ReactNode }) {
  return <AdminOnlyLayout>{children}</AdminOnlyLayout>;
}
