import type { ReactNode } from 'react';

import { TeamLeaderOnlyLayout } from '@/components/auth/admin-only-layout';

// Team activity reads people's sending records: owners and admins see
// the whole account, a team leader only their own team (migration 074
// scopes the report in SQL). The guard runs on the server, so typing
// the URL gets the same answer as the hidden sidebar link; the report
// function refuses anyone below team leader as well.
export default function Layout({ children }: { children: ReactNode }) {
  return <TeamLeaderOnlyLayout>{children}</TeamLeaderOnlyLayout>;
}
