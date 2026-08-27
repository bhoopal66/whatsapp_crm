import type { ReactNode } from 'react';

import { AdminOnlyLayout } from '@/components/auth/admin-only-layout';

// Workspace configuration — admin and owner only. The guard runs on
// the server, so typing the URL directly gets the same answer as the
// hidden sidebar link. See components/auth/admin-only-layout.tsx.
export default function Layout({ children }: { children: ReactNode }) {
  return <AdminOnlyLayout>{children}</AdminOnlyLayout>;
}
