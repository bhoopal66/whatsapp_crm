import type { ReactNode } from 'react';

import { TeamLeaderOnlyLayout } from '@/components/auth/admin-only-layout';

// The Live view shows people's presence and their waiting customers:
// owners and admins see the whole workspace, a team leader the teams
// they lead (migration 238 scopes it in SQL). The guard runs on the
// server, so typing the URL gets the same answer as the hidden sidebar
// link; live_team_view() refuses anyone below team leader as well.
export default function Layout({ children }: { children: ReactNode }) {
  return <TeamLeaderOnlyLayout>{children}</TeamLeaderOnlyLayout>;
}
