'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { useSharedUnreadChats } from '@/components/layout/unread-chats-provider';
import { cn } from '@/lib/utils';
import { TEAM_VIEW_ITEMS, canUseTeamView } from './nav-items';

const PERSONAL_HREF = { inbox: '/inbox', contacts: '/contacts' } as const;

interface TeamViewSwitchProps {
  screen: 'inbox' | 'contacts';
  /** True on /team-inbox and /team-contacts. */
  teamView: boolean;
  className?: string;
}

/**
 * Mine / Team segmented switch at the top of Inbox and Contacts. It
 * replaces the two sidebar rows, and is shown only to people who had
 * them (`canUseTeamView`, nav-items.ts). Both segments are plain links,
 * so the team routes stay shareable and the guards are the routes' own.
 * The unread count sits on the Team segment only: the sidebar's Inbox
 * row carries the personal one, so the same number is never shown twice.
 */
export function TeamViewSwitch({
  screen,
  teamView,
  className,
}: TeamViewSwitchProps) {
  const t = useTranslations('TeamViewSwitch');
  const { accountRole, profileLoading, salesRestricted } = useAuth();
  const unread = useSharedUnreadChats();

  if (
    profileLoading ||
    !canUseTeamView(screen, accountRole, { salesRestricted })
  )
    return null;

  const teamUnread = screen === 'inbox' ? unread.team : 0;
  const segment =
    'flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';
  const on = 'bg-card text-primary font-semibold shadow-xs';
  const off = 'text-muted-foreground hover:text-foreground font-medium';

  return (
    <div
      role="group"
      aria-label={t(`${screen}.label`)}
      className={cn('bg-muted flex w-full gap-1 rounded-lg p-1', className)}
    >
      <Link
        href={PERSONAL_HREF[screen]}
        aria-current={teamView ? undefined : 'page'}
        className={cn(segment, teamView ? off : on)}
      >
        {t('mine')}
      </Link>
      <Link
        href={TEAM_VIEW_ITEMS[screen].href}
        aria-current={teamView ? 'page' : undefined}
        className={cn(segment, teamView ? on : off)}
      >
        {t('team')}
        {teamUnread > 0 ? (
          <span
            aria-label={t('unread', { count: teamUnread })}
            className="bg-primary text-primary-foreground flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs font-semibold"
          >
            {teamUnread > 99 ? '99+' : teamUnread}
          </span>
        ) : null}
      </Link>
    </div>
  );
}
