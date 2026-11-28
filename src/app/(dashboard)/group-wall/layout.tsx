import type { ReactNode } from 'react';

import {
  SalesOnlyLayout,
  StaffOnlyLayout,
} from '@/components/auth/admin-only-layout';

// The group wall shows the same WhatsApp groups as /groups, so it has
// the same guards: a bank guest and a restricted department are sent
// away on the server; RLS still decides which groups and messages each
// person gets back (whatsapp_group_visible_ids). Full width: no list
// pane, unlike the /groups layout.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <StaffOnlyLayout>
      <SalesOnlyLayout>{children}</SalesOnlyLayout>
    </StaffOnlyLayout>
  );
}
