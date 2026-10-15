import type { ReactNode } from 'react';

import { StaffOnlyLayout } from '@/components/auth/admin-only-layout';

// Video meetings (migration 106) are every staff member's. A bank guest
// is sent away on the server, whatever the sidebar shows, and that
// covers the room under /meetings/[id]/room too; RLS still decides
// which meetings each person gets back (meeting_can_view).
export default function Layout({ children }: { children: ReactNode }) {
  return <StaffOnlyLayout>{children}</StaffOnlyLayout>;
}
