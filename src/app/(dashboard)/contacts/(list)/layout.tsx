import type { ReactNode } from 'react';

import { SalesOnlyLayout } from '@/components/auth/admin-only-layout';

// The All Contacts list is a sales area: a restricted department
// (migration 192) is sent to their own inbox. The list lives in the
// `(list)` route group so this guard wraps /contacts only, never the
// customer page /contacts/[id], which they keep for the customers they
// chat with (RLS decides which). See components/auth/admin-only-layout.tsx.
export default function Layout({ children }: { children: ReactNode }) {
  return <SalesOnlyLayout>{children}</SalesOnlyLayout>;
}
