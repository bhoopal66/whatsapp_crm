'use client';

import { Suspense } from 'react';

import { InboxPageInner } from '../inbox/page';

/**
 * HR inbox — the chats owned by or assigned to people in HR
 * (`conversations.inbox_department = 'hr'`, migration 192).
 *
 * Same screen as /inbox, one flag apart. Those chats leave the main
 * Inbox and Team inbox (each HR person still sees their own in their
 * Inbox), and owners and admins read them here.
 */
export default function HrInboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxPageInner departmentView="hr" />
    </Suspense>
  );
}
