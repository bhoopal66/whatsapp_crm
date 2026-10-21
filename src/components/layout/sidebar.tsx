'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useTotalUnread } from '@/hooks/use-total-unread';
import { useChatUnreadTotal } from '@/hooks/use-chat-unread-total';
import { useCallsNav } from '@/hooks/use-calls-nav';
import { useUnreadNotifications } from '@/hooks/use-unread-notifications';
import {
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
import { showWorkspaceRail } from '@/lib/workspaces/form';
import { WorkspaceRail } from './workspace-rail';
import {
  isNavItemActive,
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
  const pathname = usePathname();
  const {
    profile,
    profileLoading,
    account,
    accountRole,
    signOut,
    workspaces,
    isBankGuest,
    canManageMembers,
  } = useAuth();
  const totalUnread = useTotalUnread();
  // Only what this role may open; null while the profile loads, so the
  // gated rows fail closed (see visibleNavGroups).
  const callsNav = useCallsNav();
  const navGroups = visibleNavGroups(profileLoading ? null : accountRole, {
    pbx: callsNav.visible,
  });
  // Prefix for the group headings' ids, which label their lists.
  const groupIdPrefix = useId();

  const unreadNotifications = useUnreadNotifications();
  const chatUnread = useChatUnreadTotal();
  // Only surface the account-name strip when it actually carries
  // information. A solo user's personal account is named after them
  // (the 017 signup trigger seeds it from `full_name`), so showing it
  // here would just duplicate the user name in the footer below. Once
  // the account is renamed or the user joins a shared account, the
  // name diverges and the strip becomes meaningful — that's the signal
  // we gate on. Wait for the profile fetch to settle first, otherwise
  // the strip flashes in once the row resolves (a layout jump).
  // Someone in several workspaces always gets it: the rail's tiles
  // carry only short names, so this is where the active one is named.
  //
  // The workspace rail: another workspace to switch to, or the "+"
  // that creates one (owner/admin of the active workspace, the gate
  // POST /api/workspaces applies).
  const canCreateWorkspace = !profileLoading && canManageMembers;
  const showRail = showWorkspaceRail(workspaces.length, canCreateWorkspace);
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

  function renderNavItem(item: NavItem) {
    const isActive = isNavItemActive(item.href, pathname);

    const showUnreadDot =
      item.href === '/inbox' && totalUnread > 0 && !isActive;

    // Unlike the inbox dot, the notifications count stays visible
    // even while the page is active — it reflects unread state
    // (cleared by marking notifications read), not "currently
    // viewing this section".
    const showNotificationBadge =
      item.href === '/notifications' && unreadNotifications > 0;
    const showChatBadge = item.href === '/chat' && chatUnread > 0;
    // Open missed-call tasks assigned to them, as the chat sidebar shows.
    const showCallsBadge = item.href === '/calls' && callsNav.missed > 0;

    return (
      <li key={item.href}>
        <Link
          href={item.href}
          aria-current={isActive ? 'page' : undefined}
          className={cn(
            // Taller on mobile so fingers can hit the row reliably (≥44px).
            'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2',
            isActive
              ? 'bg-primary-soft text-primary font-semibold'
              : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
          )}
        >
          <item.icon className="h-4 w-4" />
          <span className="flex-1">{t(item.labelKey)}</span>
          {item.beta && (
            <span
              aria-label={t('beta')}
              className="border-warning/40 bg-warning-soft text-warning rounded-full border px-1.5 py-0.5 text-[9px] font-semibold tracking-wider uppercase"
            >
              {t('beta')}
            </span>
          )}
          {showUnreadDot && (
            <span
              aria-label={t('unreadConversations', { count: totalUnread })}
              className="relative flex h-2 w-2"
            >
              <span className="bg-primary absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" />
              <span className="bg-primary relative inline-flex h-2 w-2 rounded-full" />
            </span>
          )}
          {showNotificationBadge && (
            <span
              aria-label={t('unreadNotifications', {
                count: unreadNotifications,
              })}
              className="bg-primary text-primary-foreground flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-semibold"
            >
              {unreadNotifications > 9 ? '9+' : unreadNotifications}
            </span>
          )}
          {showChatBadge && (
            <span
              aria-label={t('unreadChat', { count: chatUnread })}
              className="bg-primary text-primary-foreground flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-semibold"
            >
              {chatUnread > 99 ? '99+' : chatUnread}
            </span>
          )}
          {showCallsBadge && (
            <span
              aria-label={t('missedCalls', { count: callsNav.missed })}
              className="flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-semibold text-amber-950"
            >
              {callsNav.missed > 99 ? '99+' : callsNav.missed}
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
          // Mobile: fixed drawer that slides in from the left. With the
          // workspace rail the drawer is a row: rail, then the nav.
          'border-sidebar-border bg-sidebar fixed inset-y-0 left-0 z-40 flex h-full flex-row border-r',
          showRail ? 'w-80' : 'w-64',
          'transition-transform duration-200 ease-out will-change-transform',
          open ? 'translate-x-0' : '-translate-x-full',
          // Desktop: static, always visible — reset all the mobile framing.
          'lg:static lg:z-0 lg:translate-x-0 lg:transition-none',
          showRail ? 'lg:w-76' : 'lg:w-60'
        )}
        aria-label="Primary"
      >
        {showRail ? <WorkspaceRail canCreate={canCreateWorkspace} /> : null}
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
            <div className="flex flex-col gap-5">
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
                {/* Settings is staff-only: the shell keeps a guest on /chat. */}
                {isBankGuest ? null : (
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
                          href="/settings?tab=whatsapp"
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
