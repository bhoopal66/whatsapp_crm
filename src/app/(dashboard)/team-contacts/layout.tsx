import type { ReactNode } from 'react';

import { TeamLeaderOnlyLayout } from '@/components/auth/admin-only-layout';

// Team leader and above. Guarded on the server so the URL is not a way
// around the hidden sidebar entry.
export default function Layout({ children }: { children: ReactNode }) {
  return <TeamLeaderOnlyLayout>{children}</TeamLeaderOnlyLayout>;
}
