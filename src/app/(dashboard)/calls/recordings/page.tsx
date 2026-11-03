import { Suspense } from 'react';

import { TeamRecordings } from '@/components/calls/team-recordings';

/**
 * /calls/recordings — Team call recordings (module 015): a leader's or
 * admin's per-person summary and day-by-day list of their people's
 * recorded calls, playable inline. Browse and listen only; every play
 * is logged by the recording route. GET /api/pbx/calls/recordings
 * scopes the people.
 */
export default function TeamRecordingsPage() {
  return (
    <Suspense
      fallback={<div className="bg-muted m-6 h-40 animate-pulse rounded-xl" />}
    >
      <TeamRecordings />
    </Suspense>
  );
}
