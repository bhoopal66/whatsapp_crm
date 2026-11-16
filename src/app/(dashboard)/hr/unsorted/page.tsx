'use client';

import { Suspense } from 'react';

import { InboxPageInner } from '../../inbox/page';

/**
 * Not sorted: HR-department chats (migration 192) with no HR row yet, neither a candidate nor an employee topic.
 * The /inbox screen in its HR view with the tab fixed to this inbox
 * (migration 200); the sidebar's HR group lists the three.
 */
export default function HrUnsortedPage() {
  return (
    <Suspense fallback={null}>
      <InboxPageInner departmentView="hr" hrInbox="unsorted" />
    </Suspense>
  );
}
