import type { ReactNode } from 'react';

import { CallReviewerLayout } from '@/components/auth/admin-only-layout';

// Team call recordings is a team leader's and an admin's screen, and a
// call reviewer's (migration 198); the route answers 403 to anyone else
// whatever this layout shows.
export default function Layout({ children }: { children: ReactNode }) {
  return <CallReviewerLayout>{children}</CallReviewerLayout>;
}
