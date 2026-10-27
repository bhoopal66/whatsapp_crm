'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Bell, CheckCheck, Loader2 } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { notificationBadgeLabel } from '@/lib/notifications/badge';
import { useNotifications } from './notifications-provider';
import { NotificationItem } from './notification-item';

/**
 * The top bar's bell: the unread count as a badge, and the latest
 * notifications in a dropdown. The list is fetched on every open (cheap,
 * and it heals anything realtime missed while the tab slept); the badge
 * is kept current by the provider's realtime subscription either way.
 */
export function NotificationBell() {
  const t = useTranslations('Notifications');
  const { isBankGuest } = useAuth();
  const {
    notifications,
    unread,
    error,
    loading,
    markingAll,
    load,
    markAllRead,
  } = useNotifications();
  const [open, setOpen] = useState(false);
  const badge = notificationBadgeLabel(unread);
  const label = t('bellLabel', { count: unread });

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void load();
      }}
    >
      <PopoverTrigger
        aria-label={label}
        title={label}
        className="text-muted-foreground hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground focus-visible:ring-ring relative flex h-10 w-10 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <Bell className="h-5 w-5" />
        {badge && (
          <span
            aria-hidden
            className="bg-primary text-primary-foreground ring-card absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold ring-2"
          >
            {badge}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[min(24rem,calc(100vw-1rem))] gap-0 p-0"
      >
        <div className="border-border flex items-center justify-between gap-2 border-b px-3 py-2.5">
          <PopoverTitle className="text-foreground text-sm font-semibold">
            {t('title')}
          </PopoverTitle>
          <Button
            variant="ghost"
            size="sm"
            disabled={unread === 0 || markingAll}
            onClick={() => void markAllRead()}
          >
            {markingAll ? <Loader2 className="animate-spin" /> : <CheckCheck />}
            {t('markAllRead')}
          </Button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto overscroll-contain">
          {notifications === null && error ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <p className="text-destructive text-sm">{t('loadFailed')}</p>
              <p className="text-muted-foreground text-xs break-words">
                {error}
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => void load()}
              >
                {t('retry')}
              </Button>
            </div>
          ) : notifications === null ? (
            <div
              role="status"
              aria-label={t('loading')}
              className="flex items-center justify-center py-10"
            >
              <Loader2 className="text-primary h-5 w-5 animate-spin" />
            </div>
          ) : notifications.length === 0 ? (
            <div className="flex flex-col items-center px-4 py-8 text-center">
              <div className="bg-primary-soft flex h-10 w-10 items-center justify-center rounded-xl">
                <Bell className="text-primary h-5 w-5" />
              </div>
              <p className="text-foreground mt-3 text-sm font-medium">
                {t('emptyTitle')}
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                {t('emptyBody')}
              </p>
            </div>
          ) : (
            <ul className="space-y-1 p-1.5">
              {notifications.map((n) => (
                <NotificationItem
                  key={n.id}
                  notification={n}
                  compact
                  onOpened={() => setOpen(false)}
                />
              ))}
            </ul>
          )}
        </div>

        {/* A bank guest is kept on team chat (guestRedirectPath), so the
            full page would only bounce them back. */}
        {!isBankGuest && (
          <div className="border-border border-t p-1.5">
            <Link
              href="/notifications"
              onClick={() => setOpen(false)}
              className="text-primary hover:bg-accent focus-visible:ring-ring flex h-9 items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              {t('viewAll')}
            </Link>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
