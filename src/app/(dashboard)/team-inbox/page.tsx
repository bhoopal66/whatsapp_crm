'use client';

import { Suspense } from 'react';

import { InboxPageInner } from '../inbox/page';

/**
 * Team inbox — every conversation this team leader's people own or
 * hold.
 *
 * Same screen as /inbox, one flag apart: /inbox narrows a leader down
 * to their own threads, this one shows everything the database will
 * give them, which for a leader is their team's work (migration 044).
 * Admins see the account-wide view here, same as their /inbox.
 */
export default function TeamInboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxPageInner teamView />
    </Suspense>
  );
}
