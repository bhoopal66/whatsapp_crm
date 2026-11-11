import type { ReactNode } from 'react';

import { AdminOnlyLayout } from '@/components/auth/admin-only-layout';

// HR's chats (migration 192): owners and admins only. Guarded on the
// server so the URL is not a way around the hidden sidebar entry.
export default function Layout({ children }: { children: ReactNode }) {
  return <AdminOnlyLayout>{children}</AdminOnlyLayout>;
}
