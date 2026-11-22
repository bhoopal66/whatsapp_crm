'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Bell, CheckCheck, Loader2 } from 'lucide-react';
import { EmptyState } from '@/components/dashboard/empty-state';
import { ErrorState } from '@/components/dashboard/error-state';
import { LoadingState } from '@/components/dashboard/loading-state';

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
    markingAll,
    load,
    markAllRead,
  } = useNotifications();

  useEffect(() => {
    void load();
  }, [load]);

  if (error && notifications === null) {
    return <ErrorState message={error} onRetry={() => void load()} />;
  }

  if (notifications === null) {
    return <LoadingState />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
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
        <EmptyState
          icon={Bell}
          title={t('emptyTitle')}
          hint={t('emptyBody')}
          className="h-48"
        />
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
