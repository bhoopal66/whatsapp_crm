'use client';

import { Suspense } from 'react';

import { InboxPageInner } from '../../inbox/page';

/**
 * Recruiter HR: chats with a recruitment row (a stage).
 * The /inbox screen in its HR view with the tab fixed to this inbox
 * (migration 200); the sidebar's HR group lists the three.
 */
export default function HrRecruiterPage() {
  return (
    <Suspense fallback={null}>
      <InboxPageInner departmentView="hr" hrInbox="recruiter" />
    </Suspense>
  );
}
