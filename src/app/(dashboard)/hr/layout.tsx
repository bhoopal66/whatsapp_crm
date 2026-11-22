import type { ReactNode } from 'react';

import { HrAccessLayout } from '@/components/auth/admin-only-layout';
import { HrTabs } from '@/components/hr/hr-tabs';

// HR's chats (migrations 192, 200): owners, admins and HR team members.
// Guarded on the server so the URL is not a way around the hidden
// sidebar entry; covers the nested HR tasks and setup screens too.
// The tab bar is the HR area's own navigation (the sidebar has one row);
// the wrapper is a flex column so the full-bleed inbox screens keep
// filling the space under it.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <HrAccessLayout>
      <div className="flex min-h-0 flex-1 flex-col">
        <HrTabs />
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </HrAccessLayout>
  );
}
