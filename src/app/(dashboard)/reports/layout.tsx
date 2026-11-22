import type { ReactNode } from 'react';

import { ReportsLandingLayout } from '@/components/auth/admin-only-layout';

// Reports: admin and up (the funnel is theirs), or anyone the owner
// granted a report (migration 255). This applies to every page under
// /reports, so each report also carries its own guard in its folder:
// /reports/tags its per-person ReportAccessLayout, /reports/funnel
// AdminOnlyLayout.
export default function Layout({ children }: { children: ReactNode }) {
  return <ReportsLandingLayout>{children}</ReportsLandingLayout>;
}
