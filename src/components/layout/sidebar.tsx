'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { LiveDot } from '@/components/meetings/meeting-status-badge';
import { useActiveCall } from '@/components/meetings/session/meeting-session-provider';
import { isInCall } from '@/lib/meetings/session/session';
import { useAuth } from '@/hooks/use-auth';
import { useUnreadChats } from '@/hooks/use-total-unread';
import { useCasesOverdue } from '@/hooks/use-cases-overdue';
import { useGroupsUnread } from '@/hooks/use-groups-unread';
import { useSubmissionGroupsUnread } from '@/hooks/use-submission-groups-unread';
import { useChatUnreadTotal } from '@/hooks/use-chat-unread-total';
import { useCallsNav } from '@/hooks/use-calls-nav';
import { useBrainNav } from '@/hooks/use-brain-nav';
import { useHrTeamNav } from '@/hooks/use-hr-team-nav';
import { useHrCounts } from '@/hooks/use-hr-counts';
import { hasHrAccess } from '@/lib/hr/access';
import {
  ArrowLeftRight,
  Crown,
  LogOut,
  Settings,
  Shield,
  Landmark,
  User,
  UserCog,
  UsersRound,
  X,
} from 'lucide-react';
import type { AccountRole } from '@/lib/auth/roles';
import { workspaceHomePath } from '@/lib/auth/my-workspaces';
import {
  isNavItemActive,
  navPrefetch,
  visibleBottomNavItems,
  visibleNavGroups,
  type NavItem,
} from './nav-items';

// Per-role chip metadata used in the sidebar's account strip + the
// Members tab roster. Keeping this near both consumers in a single
// place avoids drift between the two surfaces — when a designer
// wants to recolour "agent" rows, this is the one diff.
const ROLE_CHIP: Record<
  AccountRole,
  { icon: typeof Crown; labelKey: string; className: string }
> = {
  owner: {
    icon: Crown,
    labelKey: 'roleOwner',
    // Amber: scarce, immutable, "the boss" — gets visual emphasis.
    className: 'border-warning/40 bg-warning-soft text-warning',
  },
  admin: {
    icon: Shield,
    labelKey: 'roleAdmin',
    // Primary-tinted: significant but not as scarce as owner.
    className: 'border-primary/40 bg-primary/10 text-primary',
  },
  team_leader: {
    icon: UsersRound,
    labelKey: 'roleTeamLeader',
    // Sky: clearly a step up from an agent's neutral slate, clearly
    // not the amber reserved for the owner.
    className: 'border-info/40 bg-info-soft text-info',
  },
  agent: {
    icon: UserCog,
    labelKey: 'roleAgent',
    // Neutral slate: the operational default.
    className: 'border-border bg-muted text-foreground',
  },
  viewer: {
    icon: User,
    labelKey: 'roleViewer',
    // Muted slate: read-only role; visually quieter than agent.
    className: 'border-border bg-card text-muted-foreground',
  },
  bank_guest: {
    icon: Landmark,
    labelKey: 'roleBankGuest',
    // Muted like a viewer: an outside guest, not one of the staff.
    className: 'border-border bg-card text-muted-foreground',
  },
};
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface SidebarProps {
  /** Controlled on mobile by the Header's hamburger button. Ignored on lg+. */
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const t = useTranslations('Sidebar');
  const tMeetings = useTranslations('Meetings');
  const activeCall = useActiveCall();
  const inMeeting = !!activeCall && isInCall(activeCall.call.phase);
  const pathname = usePathname();
  const {
    profile,
    profileLoading,
    account,
    accountRole,
    signOut,
    workspaces,
    isBankGuest,
    salesRestricted,
    reviewsAllCalls,
  } = useAuth();
  const unreadChats = useUnreadChats();
  const casesOverdue = useCasesOverdue();
  const groupsUnread = useGroupsUnread();
  const submissionGroupsUnread = useSubmissionGroupsUnread();
  // Only what this role may open; null while the profile loads, so the
  // gated rows fail closed (see visibleNavGroups).
  const callsNav = useCallsNav();
  const brainOn = useBrainNav();
  const hrRoles = useHrTeamNav();
  // The HR group's open counts; polled only for someone with an HR role
  // (an owner/admin's hr_my_roles() says admin).
  const hrCounts = useHrCounts(!!hrRoles && hasHrAccess(hrRoles));
  const navGroups = visibleNavGroups(profileLoading ? null : accountRole, {
    pbx: callsNav.visible,
    brain: brainOn,
    salesRestricted,
    callReviewer: reviewsAllCalls,
    hrRoles,
  });
  // Prefix for the group headings' ids, which label their lists.
  const groupIdPrefix = useId();

  const chatUnread = useChatUnreadTotal();
  // Only surface the account-name strip when it actually carries
  // information. A solo user's personal account is named after them
  // (the 017 signup trigger seeds it from `full_name`), so showing it
  // here would just duplicate the user name in the footer below. Once
  // the account is renamed or the user joins a shared account, the
  // name diverges and the strip becomes meaningful — that's the signal
  // we gate on. Wait for the profile fetch to settle first, otherwise
  // the strip flashes in once the row resolves (a layout jump).
  // Someone in several workspaces always gets it: this is where the
  // active one is named (switching lives in Settings → Workspaces).
  const showAccountStrip =
    !profileLoading &&
    !!account?.name &&
    (workspaces.length > 1 || account.name !== profile?.full_name);

  // Close the drawer when route changes — users opened it to navigate,
  // so once they pick a destination the drawer should get out of the way.
  useEffect(() => {
    onClose?.();
    // Only pathname drives this — onClose identity doesn't need to re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Lock body scroll and allow Escape to close while the drawer is open on
  // mobile. No-ops on desktop because the sidebar isn't positioned there.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const PRIMARY_BADGE = 'bg-primary text-primary-foreground';
  // Amber for what is past due or missed, set apart from plain unread.
  const DUE_BADGE = 'bg-amber-400 text-amber-950';

  function navBadgeFor(
    href: string
  ): { count: number; label: string; className: string } | null {
    switch (href) {
      case '/inbox':
        return {
          count: unreadChats.inbox,
          label: t('unreadConversations', { count: unreadChats.inbox }),
          className: PRIMARY_BADGE,
        };
      case '/team-inbox':
        return {
          count: unreadChats.team,
          label: t('unreadConversations', { count: unreadChats.team }),
          className: PRIMARY_BADGE,
        };
      // The HR inboxes: open chats (hr_counts), as the package's
      // sidebar shows them, not unread.
      case '/hr/recruiter':
      case '/hr/department':
      case '/hr/unsorted': {
        if (!hrCounts) return null;
        const count =
          href === '/hr/recruiter'
            ? hrCounts.recruiter.all
            : href === '/hr/department'
              ? hrCounts.dept.all
              : hrCounts.unsorted;
        return {
          count,
          label: t('openHrChats', { count }),
          className: PRIMARY_BADGE,
        };
      }
      case '/chat':
        return {
          count: chatUnread,
          label: t('unreadChat', { count: chatUnread }),
          className: PRIMARY_BADGE,
        };
      case '/calls':
        // Open missed-call tasks assigned to them, as the chat sidebar shows.
        return {
          count: callsNav.missed,
          label: t('missedCalls', { count: callsNav.missed }),
          className: DUE_BADGE,
        };
      case '/groups':
        return {
          count: groupsUnread,
          label: t('unreadGroups', { count: groupsUnread }),
          className: PRIMARY_BADGE,
        };
      case '/submission-groups':
        return {
          count: submissionGroupsUnread,
          label: t('unreadSubmissionGroups', {
            count: submissionGroupsUnread,
          }),
          className: PRIMARY_BADGE,
        };
      case '/cases':
        return {
          count: casesOverdue,
          label: t('overdueCases', { count: casesOverdue }),
          className: DUE_BADGE,
        };
      default:
        return null;
    }
  }

  function renderNavItem(item: NavItem) {
    const isActive = isNavItemActive(item.href, pathname);

    // What waits behind the row, as a number: a dot said only
    // "something", not how much.
    const badge = navBadgeFor(item.href);
    return (
      <li key={item.href}>
        <Link
          href={item.href}
          prefetch={navPrefetch(item)}
          aria-current={isActive ? 'page' : undefined}
          className={cn(
            // Taller on mobile so fingers can hit the row reliably (≥44px);
            // 32px on desktop, to make room for the group headings.
            'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-1.5',
            isActive
              ? 'bg-card text-primary font-semibold shadow-xs'
              : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
          )}
        >
          <item.icon className="h-4 w-4" />
          <span className="flex-1">{t(item.labelKey)}</span>
          {item.href === '/meetings' && inMeeting && (
            <span role="img" aria-label={tMeetings('inAMeeting')}>
              <LiveDot />
            </span>
          )}
          {item.beta && (
            <span
              aria-label={t('beta')}
              className="border-warning/40 bg-warning-soft text-warning rounded-full border px-1.5 py-0.5 text-[9px] font-semibold tracking-wider uppercase"
            >
              {t('beta')}
            </span>
          )}
          {badge && badge.count > 0 && (
            <span
              aria-label={badge.label}
              className={cn(
                'flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-semibold',
                badge.className
              )}
            >
              {badge.count > 99 ? '99+' : badge.count}
            </span>
          )}
        </Link>
      </li>
    );
  }

  return (
    <>
      {/* Backdrop — only exists on mobile and only when open. Clicking
          it closes the drawer. Hidden from lg+ since the sidebar is
          part of the main flex row there. */}
      <button
        type="button"
        aria-label={t('closeMenu')}
        onClick={onClose}
        className={cn(
          'bg-background/70 fixed inset-0 z-30 backdrop-blur-sm transition-opacity lg:hidden',
          open
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0'
        )}
      />

      <aside
        className={cn(
          // Mobile: fixed drawer that slides in from the left.
          'border-sidebar-border bg-sidebar fixed inset-y-0 left-0 z-40 flex h-full w-64 flex-row border-r',
          'transition-transform duration-200 ease-out will-change-transform',
          open ? 'translate-x-0' : '-translate-x-full',
          // Desktop: static, always visible — reset all the mobile framing.
          'lg:static lg:z-0 lg:w-60 lg:translate-x-0 lg:transition-none'
        )}
        aria-label="Primary"
        // Navigation is dark in both modes: users found a light sidebar
        // too bright next to light pages (2026-10-21). In light mode
        // data-nav swaps the near-black for the brand navy (globals.css).
        data-mode="dark"
        data-nav="primary"
      >
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Logo row. On mobile we put a close button here; on desktop the
            close button is hidden since the sidebar is always-visible. */}
          <div className="border-border flex h-14 shrink-0 items-center justify-between gap-2 border-b px-4">
            <Link
              href={workspaceHomePath(accountRole)}
              className="flex items-center gap-2"
            >
              {/* White chip behind the mark: half the logo is navy
                (#1b547f) and reads poorly straight against the
                dark-mode sidebar. */}
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white p-1">
                <img
                  src="/brand/taamul-mark.png"
                  alt=""
                  width={24}
                  height={24}
                  className="h-6 w-6"
                />
              </div>
              <span className="text-foreground text-sm font-semibold">
                {t('title')}
              </span>
            </Link>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('closeMenu')}
              className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-9 w-9 items-center justify-center rounded-md lg:hidden"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Main navigation: headed groups (nav-items.ts), then Settings
            set apart at the foot — below everything while the groups
            fit, after them once the nav scrolls. */}
          <nav className="flex flex-1 flex-col overflow-y-auto px-3 py-4">
            <div className="flex flex-col gap-4">
              {navGroups.map((group) => {
                const headingId = `${groupIdPrefix}-${group.id}`;
                return (
                  <div key={group.id}>
                    {group.labelKey ? (
                      <div
                        id={headingId}
                        className="text-muted-foreground px-3 pb-1.5 text-[11px] font-semibold tracking-[0.09em] uppercase"
                      >
                        {t(group.labelKey)}
                      </div>
                    ) : null}
                    <ul
                      aria-labelledby={group.labelKey ? headingId : undefined}
                      className="flex flex-col gap-0.5"
                    >
                      {group.items.map(renderNavItem)}
                    </ul>
                  </div>
                );
              })}
            </div>

            <div className="mt-auto pt-4">
              <ul className="border-border flex flex-col gap-0.5 border-t pt-4">
                {visibleBottomNavItems(profileLoading ? null : accountRole).map(
                  renderNavItem
                )}
              </ul>
            </div>
          </nav>

          {/* User section */}
          <div className="border-border shrink-0 border-t p-3">
            {/* Account name display — surfaced only when the account
              name differs from the user's own name (see
              `showAccountStrip`). For a default solo account the two
              match, so we hide it to avoid duplicating the user name
              below; for renamed or shared accounts it tells the user
              which account they're acting in. */}
            {showAccountStrip && account?.name ? (
              <div className="text-muted-foreground mb-2 flex items-center gap-2 px-3 text-xs">
                <UsersRound className="size-3.5 shrink-0" />
                {/* `title=` exposes the full name on hover when it
                  gets truncated (long account names + narrow
                  sidebars). Cheap a11y win. */}
                <span className="truncate" title={account.name}>
                  {account.name}
                </span>
                {accountRole
                  ? // Always render the chip — owners used to be
                    // invisible here, which made them indistinguishable
                    // from admins at a glance. Now everyone sees their
                    // role (with a colour cue) regardless of tier.
                    (() => {
                      const meta = ROLE_CHIP[accountRole];
                      const Icon = meta.icon;
                      return (
                        <span
                          className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium tracking-wider uppercase ${meta.className}`}
                        >
                          <Icon className="size-3" />
                          {t(meta.labelKey as string)}
                        </span>
                      );
                    })()
                  : null}
              </div>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger className="hover:bg-muted/60 focus:bg-muted/60 data-popup-open:bg-muted/60 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors focus:outline-none">
                <Avatar className="size-8 shrink-0">
                  {profile?.avatar_url ? (
                    <AvatarImage
                      src={profile.avatar_url}
                      alt={profile.full_name ?? t('defaultAvatar')}
                    />
                  ) : null}
                  <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                    {profile?.full_name?.charAt(0)?.toUpperCase() ??
                      profile?.email?.charAt(0)?.toUpperCase() ??
                      'U'}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="text-foreground truncate text-sm font-medium">
                    {profile?.full_name ?? t('defaultUser')}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    {profile?.email ?? ''}
                  </p>
                </div>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                side="top"
                sideOffset={6}
                className="bg-popover text-popover-foreground ring-border min-w-56"
              >
                {/* A guest's Settings is Workspaces alone (the shell keeps
                  them on /chat and /settings): switching lives there. */}
                {isBankGuest ? (
                  <>
                    <DropdownMenuItem
                      render={
                        <Link
                          href="/settings?tab=workspaces"
                          onClick={onClose}
                          className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                        />
                      }
                    >
                      <ArrowLeftRight className="size-4" />
                      {t('menuWorkspaces')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator className="bg-border" />
                  </>
                ) : (
                  <>
                    <DropdownMenuItem
                      render={
                        <Link
                          href="/settings?tab=profile"
                          onClick={onClose}
                          className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                        />
                      }
                    >
                      <User className="size-4" />
                      {t('menuProfile')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      render={
                        <Link
                          href="/settings"
                          onClick={onClose}
                          className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                        />
                      }
                    >
                      <Settings className="size-4" />
                      {t('menuSettings')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator className="bg-border" />
                  </>
                )}
                <DropdownMenuItem
                  onClick={signOut}
                  className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                >
                  <LogOut className="size-4" />
                  {t('menuSignOut')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </aside>
    </>
  );
}
