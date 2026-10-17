import { Suspense } from 'react';

import { CallStatsReport } from '@/components/calls/call-stats-report';

/**
 * /calls/report — the Call report (module 015, migration 119): talk
 * time, answer rate, busiest hours, people, customers and the calls of
 * a period. Every staff member with the Calls screen; the stats route
 * scopes the figures (own calls, a leader's teams, the workspace). The
 * Calls layout above turns a bank guest away.
 */
export default function CallReportPage() {
  return (
    <Suspense
      fallback={<div className="bg-muted m-6 h-40 animate-pulse rounded-xl" />}
    >
      <CallStatsReport />
    </Suspense>
  );
}
