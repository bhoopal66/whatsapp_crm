'use client';

import { Suspense } from 'react';

import { InboxPageInner } from '../../inbox/page';

/**
 * Campaign inbox — the conversations that started as a reply to a
 * broadcast (migration 048) while the bot is answering them, so the
 * people running campaigns can watch it work the replies without
 * wading through the rest of the inbox. Every other chat is in /inbox,
 * so each is in exactly one place: a hand-off, a chat the bot is not
 * answering, and — for good — one a person has stepped into (assigned,
 * or replied in; migration 067), and one carrying a chat tag, are all
 * found there.
 *
 * Same screen as /inbox with `campaignView` on: the list is narrowed to
 * those threads and gains a per-campaign filter. Inherits the
 * admin-only guard of the Broadcasts section from the parent layout.
 */
export default function CampaignInboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxPageInner campaignView />
    </Suspense>
  );
}
