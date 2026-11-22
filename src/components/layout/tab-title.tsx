'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { pageTitleKey } from '@/components/layout/page-title';
import { useSharedUnreadChats } from '@/components/layout/unread-chats-provider';
import { formatTabTitle } from '@/lib/tab-alerts/title';
import { tabTitle } from '@/lib/tab-alerts/title-owner';

/**
 * The browser tab's title: "(N) <page> — Taamul Connect", N being the
 * sidebar Inbox entry's unread count and <page> the top bar's title.
 * Mounted once, in the dashboard shell. Headless.
 *
 * It goes through `tabTitle` rather than writing `document.title`: the
 * reminder alarm flashes the title too, and while it does this stands
 * down (lib/tab-alerts/title-owner.ts).
 *
 * Next writes the root layout's metadata title ("Taamul Connect") into
 * <head> on navigation, after this effect may already have run, so an
 * observer on <head> puts ours back whenever anything else changes it.
 * `reassert` writes only when the title differs, so it cannot loop.
 */
export function TabTitle() {
  const t = useTranslations('Header');
  const pathname = usePathname();
  const { inbox } = useSharedUnreadChats();
  const title = formatTabTitle(inbox, t(pageTitleKey(pathname) as string));

  useEffect(() => {
    tabTitle.setBase(title);
    // Re-applied on every navigation too, in case the metadata write
    // landed between renders.
  }, [title, pathname]);

  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => tabTitle.reassert());
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      observer.disconnect();
      // Signed out or the shell left: the tab keeps what it shows.
      tabTitle.setBase(null);
    };
  }, []);

  return null;
}
