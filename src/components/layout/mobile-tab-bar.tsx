'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { isBankGuest } from '@/lib/auth/roles';
import { MOBILE_TAB_HREFS } from '@/lib/layout/focus-trap';
import { NAV_GROUPS, isNavItemActive, isNavItemVisible } from './nav-items';
import { useSharedUnreadChats } from './unread-chats-provider';

/**
 * The phone's bottom bar: Inbox, Worklist, Contacts, Team chat and More
 * (More opens the menu drawer). Staff only, and only the tabs the same
 * rules as the sidebar let this person open. Hidden from lg up, where
 * the sidebar is always on screen.
 */
export function MobileTabBar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const t = useTranslations('Sidebar');
  const tNav = useTranslations('MobileNav');
  const pathname = usePathname();
  const { accountRole, profileLoading, salesRestricted } = useAuth();
  const unread = useSharedUnreadChats();
  // A bank guest has team chat and nothing else: no bar.
  if (profileLoading || !accountRole || isBankGuest(accountRole)) return null;

  const rows = NAV_GROUPS.flatMap((g) => g.items);
  const tabs = MOBILE_TAB_HREFS.flatMap((href) => {
    const item = rows.find((r) => r.href === href);
    return item && isNavItemVisible(item, accountRole, { salesRestricted })
      ? [item]
      : [];
  });

  const base =
    'flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium';
  return (
    <nav
      aria-label={tNav('label')}
      className="border-border bg-card flex shrink-0 border-t pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {tabs.map((item) => {
        const active = isNavItemActive(item.href, pathname);
        const Icon = item.icon;
        const count = item.href === '/inbox' ? unread.inbox : 0;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              base,
              active ? 'text-primary' : 'text-muted-foreground'
            )}
          >
            <span className="relative">
              <Icon className="size-5" aria-hidden />
              {count > 0 && (
                <span className="bg-primary text-primary-foreground absolute -top-1.5 -right-3 min-w-5 rounded-full px-1 text-center text-xs leading-5 font-semibold">
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </span>
            <span
              className={cn(
                'border-b-2 px-1',
                active ? 'border-primary' : 'border-transparent'
              )}
            >
              {tNav.has(`tabs.${item.href.slice(1)}`)
                ? tNav(`tabs.${item.href.slice(1)}`)
                : t(item.labelKey)}
            </span>
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onOpenMenu}
        className={cn(base, 'text-muted-foreground')}
      >
        <Menu className="size-5" aria-hidden />
        <span className="px-1">{tNav('more')}</span>
      </button>
    </nav>
  );
}
