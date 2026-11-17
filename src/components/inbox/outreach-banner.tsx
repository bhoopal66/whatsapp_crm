'use client';

import { AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { OutreachNotice } from '@/lib/team-activity/thread-guard';
import { cn } from '@/lib/utils';

/**
 * Warnings above the composer when the next message risks the Whapi
 * number: the day's new-chat limit, a contact who stopped answering,
 * or a first message to someone new (migration 068). Warns; a block
 * is the server's (204-205), and the wording says when it applies.
 */
export function OutreachBanner({ notices }: { notices: OutreachNotice[] }) {
  const t = useTranslations('TeamActivity.guard');
  if (notices.length === 0) return null;

  return (
    <div className="bg-wa-panel-header border-warning/40 border-t">
      {notices.map((n) => {
        const Icon =
          n.severity === 'critical'
            ? ShieldAlert
            : n.severity === 'warning'
              ? AlertTriangle
              : Info;
        let message: string;
        switch (n.kind) {
          case 'limit_reached':
            message = t(
              n.throttled
                ? 'limitReachedThrottled'
                : n.blocked
                  ? 'limitReachedBlocked'
                  : 'limitReached',
              { started: n.started, limit: n.limit }
            );
            break;
          case 'limit_near':
            message = t(n.throttled ? 'limitNearThrottled' : 'limitNear', {
              started: n.started,
              limit: n.limit,
            });
            break;
          case 'quiet_hours':
            message = t('quietHours', { end: n.end });
            break;
          case 'number_limit':
            message = t(n.blocked ? 'numberLimitBlocked' : 'numberLimit', {
              started: n.started,
              limit: n.limit,
            });
            break;
          case 'unanswered':
            message = t(n.blocked ? 'unansweredBlocked' : 'unanswered', {
              count: n.count,
            });
            break;
          case 'new_contact_tip':
            message = t('newContactTip');
            break;
        }
        return (
          <div
            key={n.kind}
            role={n.severity === 'info' ? 'note' : 'status'}
            className={cn(
              'flex items-start gap-2 px-3 py-2 text-xs sm:px-4',
              n.severity === 'critical' && 'text-destructive',
              n.severity === 'warning' && 'text-wa-warning',
              n.severity === 'info' && 'text-muted-foreground'
            )}
          >
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{message}</span>
          </div>
        );
      })}
    </div>
  );
}
