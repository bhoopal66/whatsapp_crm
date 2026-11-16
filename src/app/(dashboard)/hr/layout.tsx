import type { ReactNode } from 'react';

import { HrAccessLayout } from '@/components/auth/admin-only-layout';

// HR's chats (migrations 192, 200): owners, admins and HR team members.
// Guarded on the server so the URL is not a way around the hidden
// sidebar entry; covers the nested HR tasks and setup screens too.
export default function Layout({ children }: { children: ReactNode }) {
  return <HrAccessLayout>{children}</HrAccessLayout>;
}
