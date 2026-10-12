import type { ReactNode } from 'react';

import { AgentOnlyLayout } from '@/components/auth/admin-only-layout';

// The Journeys screen (module 016) is where advisors act on journeys:
// agents and up. Viewers and bank guests are sent away on the server,
// whatever the sidebar shows; RLS still decides which journeys each
// agent gets back (customers they can see).
export default function Layout({ children }: { children: ReactNode }) {
  return <AgentOnlyLayout>{children}</AgentOnlyLayout>;
}
