'use client';

import { AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { OutreachNotice } from '@/lib/team-activity/thread-guard';
import { cn } from '@/lib/utils';

/**
 * Warnings above the composer when the next message risks the Whapi
 * number: the day's new-chat limit, a contact who stopped answering,
 * or a first message to someone new (migration 068). Warns; the
 * optional block is enforced by the server, not here.
 */
export function OutreachBanner({ notices }: { notices: OutreachNotice[] }) {
  const t = useTranslations('TeamActivity.guard');
  if (notices.length === 0) return null;

  return (
    <div className="bg-wa-panel-header border-t border-amber-500/40">
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
            message = t(n.blocked ? 'limitReachedBlocked' : 'limitReached', {
              started: n.started,
              limit: n.limit,
            });
            break;
          case 'limit_near':
            message = t('limitNear', { started: n.started, limit: n.limit });
            break;
          case 'number_limit':
            message = t(n.blocked ? 'numberLimitBlocked' : 'numberLimit', {
              started: n.started,
              limit: n.limit,
            });
            break;
          case 'unanswered':
            message = t('unanswered', { count: n.count });
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
              n.severity === 'critical' && 'text-red-600 dark:text-red-400',
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
