import type { ReactNode } from 'react';

import { StaffOnlyLayout } from '@/components/auth/admin-only-layout';

// The calendar is every staff member's. A bank guest is sent away on
// the server, whatever the sidebar shows; the feed answers them 403
// anyway, and RLS decides which events, meetings and tasks come back.
export default function Layout({ children }: { children: ReactNode }) {
  return <StaffOnlyLayout>{children}</StaffOnlyLayout>;
}
