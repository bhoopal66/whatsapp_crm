import type { ReactNode } from 'react';

import { StaffOnlyLayout } from '@/components/auth/admin-only-layout';

// WhatsApp groups (migration 114) are every staff member's to open. A
// bank guest is sent away on the server, whatever the sidebar shows,
// and that covers /groups/[id] too; RLS still decides which groups each
// person gets back (whatsapp_group_visible_ids).
export default function Layout({ children }: { children: ReactNode }) {
  return <StaffOnlyLayout>{children}</StaffOnlyLayout>;
}
