import type { ReactNode } from 'react';

import { StaffOnlyLayout } from '@/components/auth/admin-only-layout';
import { GroupsWorkspace } from '@/components/groups/groups-workspace';

// WhatsApp groups (migration 114) are every staff member's to open. A
// bank guest is sent away on the server, whatever the sidebar shows,
// and that covers /groups/[id] too; RLS still decides which groups each
// person gets back (whatsapp_group_visible_ids).
//
// The workspace (list pane + the selected group) lives in the layout so
// moving between /groups and /groups/[id] keeps the list mounted: its
// search, filters, scroll and realtime channel survive a selection.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <StaffOnlyLayout>
      <GroupsWorkspace>{children}</GroupsWorkspace>
    </StaffOnlyLayout>
  );
}
