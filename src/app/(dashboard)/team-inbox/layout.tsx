import type { ReactNode } from 'react';

import { TeamLeaderOnlyLayout } from '@/components/auth/admin-only-layout';

// Team leader and above. Guarded on the server so the URL is not a way
// around the hidden sidebar entry. Not a sales area (192): a team leader
// in a restricted department (HR) opens it too, and RLS gives a leader
// only their own and their team's chats.
export default function Layout({ children }: { children: ReactNode }) {
  return <TeamLeaderOnlyLayout>{children}</TeamLeaderOnlyLayout>;
}
