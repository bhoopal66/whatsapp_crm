import type { ReactNode } from 'react';

import { StaffOnlyLayout } from '@/components/auth/admin-only-layout';

// The Calls screen (module 015) is every staff member's: viewers read
// it, agents and up call back. A bank guest is sent away on the server,
// whatever the sidebar shows; RLS still decides which calls each person
// gets back (pbx_can_view_call).
export default function Layout({ children }: { children: ReactNode }) {
  return <StaffOnlyLayout>{children}</StaffOnlyLayout>;
}
