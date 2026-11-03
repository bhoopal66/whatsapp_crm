import type { ReactNode } from 'react';

import { TeamLeaderOnlyLayout } from '@/components/auth/admin-only-layout';

// Team call recordings is a team leader's and an admin's screen; the
// route answers 403 below that whatever this layout shows.
export default function Layout({ children }: { children: ReactNode }) {
  return <TeamLeaderOnlyLayout>{children}</TeamLeaderOnlyLayout>;
}
