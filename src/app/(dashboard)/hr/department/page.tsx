'use client';

import { Suspense } from 'react';

import { InboxPageInner } from '../../inbox/page';

/**
 * HR department: chats with an HR department row (a topic).
 * The /inbox screen in its HR view with the tab fixed to this inbox
 * (migration 200); the sidebar's HR group lists the three.
 */
export default function HrDepartmentPage() {
  return (
    <Suspense fallback={null}>
      <InboxPageInner departmentView="hr" hrInbox="dept" />
    </Suspense>
  );
}
