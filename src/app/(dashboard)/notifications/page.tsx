'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Bell, CheckCheck, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useNotifications } from '@/components/notifications/notifications-provider';
import { NotificationItem } from '@/components/notifications/notification-item';

/**
 * Every recent notification, full width. The top bar's bell is the
 * everyday way in; this page stays as its "View all" and as the place
 * push notifications and SQL's push_bell_url fall back to. List, count
 * and realtime are the shell's NotificationsProvider, shared with the
 * bell.
 */
export default function NotificationsPage() {
  const t = useTranslations('Notifications');
  const {
    notifications,
    unread,
    error,
    loading,
    markingAll,
    load,
    markAllRead,
  } = useNotifications();

  useEffect(() => {
    void load();
  }, [load]);

  if (error && notifications === null) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-destructive text-sm">{error}</p>
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => void load()}
        >
          {t('retry')}
        </Button>
      </div>
    );
  }

  if (notifications === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('description')}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={unread === 0 || markingAll}
          onClick={() => void markAllRead()}
        >
          {markingAll ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CheckCheck className="h-4 w-4" />
          )}
          {t('markAllRead')}
        </Button>
      </div>

      {notifications.length === 0 ? (
        <div className="border-border bg-muted/40 flex h-48 flex-col items-center justify-center rounded-xl border border-dashed">
          <div className="bg-primary/10 flex h-12 w-12 items-center justify-center rounded-xl">
            <Bell className="text-primary h-6 w-6" />
          </div>
          <p className="text-foreground mt-3 text-sm font-medium">
            {t('emptyTitle')}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">{t('emptyBody')}</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {notifications.map((n) => (
            <NotificationItem key={n.id} notification={n} />
          ))}
        </ul>
      )}
    </div>
  );
}
