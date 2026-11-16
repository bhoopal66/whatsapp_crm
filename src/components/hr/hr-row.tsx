'use client';

import { Flag, Smartphone } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { HrListRow } from '@/lib/hr/list-filters';
import { hrRowView, initialsOf, type HrRowTag } from '@/lib/hr/row-view';
import { HR_STAGES } from '@/lib/hr/types';
import { cn } from '@/lib/utils';

// Complete literal class strings (Tailwind cannot see composed names),
// status tokens, each raw hue with a dark: pair (CLAUDE.md).
const TAG = 'inline-flex shrink-0 items-center gap-1 text-[11px] leading-4';
const TOPIC_DOT = 'bg-violet-500 dark:bg-violet-300';
const REPLY_CLASS = {
  new: 'text-info',
  reply_due: 'text-warning',
  waiting: 'text-wa-text-secondary',
} as const;
// New = filled dot, Reply due = half circle, Waiting on them = ring.
const REPLY_MARK = {
  new: 'h-2 w-2 rounded-full bg-current',
  reply_due:
    'h-2 w-2 rounded-full border border-current bg-[linear-gradient(90deg,currentColor_50%,transparent_50%)]',
  waiting: 'h-2 w-2 rounded-full border border-current',
} as const;

export interface HrRowBodyProps {
  displayName: string;
  /** The formatted last-message time. */
  time: string;
  unread: boolean;
  /** The chat's HR row; null = "Not sorted". */
  hr: HrListRow | null;
  /** The assignee's display name, null when nobody holds the chat. */
  ownerName: string | null;
  /** The personal-chat label (migration 191), or null. */
  personalLabel?: string | null;
}

/**
 * An HR-inbox row's avatar and two lines (the package's 023d row): name
 * and time, then one tag line closed by the owner's first name. No
 * message preview. Rendered inside the inbox's row button.
 */
export function HrRowBody({
  displayName,
  time,
  unread,
  hr,
  ownerName,
  personalLabel = null,
}: HrRowBodyProps) {
  const t = useTranslations('Hr');
  const view = hrRowView(hr, ownerName);
  const initials = initialsOf(displayName);

  const tag = (x: HrRowTag) => {
    switch (x.kind) {
      case 'stage': {
        const label = t(`stage.${x.stage}`);
        return (
          <span
            key="stage"
            role="img"
            aria-label={`${t('list.stagePrefix')}${label}`}
            className={cn(TAG, 'text-wa-text')}
          >
            <span className="inline-flex items-end gap-px">
              {HR_STAGES.map((s, i) => (
                <span
                  key={s}
                  className={
                    i <= x.reached
                      ? 'bg-primary h-2.5 w-1 rounded-sm'
                      : 'bg-muted-foreground/30 h-2.5 w-1 rounded-sm'
                  }
                />
              ))}
            </span>
            {label}
          </span>
        );
      }
      case 'topic': {
        const label = t(`topic.${x.topic}`);
        return (
          <span
            key="topic"
            role="img"
            aria-label={`${t('list.topicPrefix')}${label}`}
            className={cn(TAG, 'text-wa-text')}
          >
            <span className={cn('h-2 w-2 rounded-full', TOPIC_DOT)} />
            {label}
          </span>
        );
      }
      case 'noTopic':
        return (
          <span
            key="noTopic"
            role="img"
            aria-label={`${t('list.topicPrefix')}${t('pane.noTopic')}`}
            className={cn(TAG, 'text-wa-text-secondary')}
          >
            <span className="h-2 w-2 rounded-full border border-current" />
            {t('pane.noTopic')}
          </span>
        );
      case 'notSorted':
        return (
          <span
            key="notSorted"
            role="img"
            aria-label={t('list.tabUnsorted')}
            className="bg-muted text-muted-foreground inline-flex shrink-0 items-center rounded px-1.5 text-[11px] leading-4"
          >
            {t('list.tabUnsorted')}
          </span>
        );
      case 'reply': {
        const label = t(`replyState.${x.state}`);
        return (
          <span
            key="reply"
            role="img"
            aria-label={`${t('list.replyPrefix')}${label}`}
            className={cn(TAG, REPLY_CLASS[x.state])}
          >
            <span className={REPLY_MARK[x.state]} />
            {label}
          </span>
        );
      }
      case 'closed':
        return (
          <span
            key="closed"
            role="img"
            aria-label={t('list.closed')}
            className="bg-muted text-muted-foreground inline-flex shrink-0 items-center rounded px-1.5 text-[11px] leading-4"
          >
            {t('list.closed')}
          </span>
        );
      case 'urgent':
        return (
          <span
            key="urgent"
            role="img"
            aria-label={t('flag.urgent')}
            className={cn(TAG, 'text-destructive')}
          >
            <Flag className="h-3 w-3 fill-current" />
            {t('flag.urgent')}
          </span>
        );
      case 'unread':
        return (
          <span
            key="unread"
            role="img"
            aria-label={t('list.unread')}
            className="bg-wa-green text-wa-green-fg inline-flex shrink-0 items-center rounded px-1.5 text-[10px] leading-4 font-semibold"
          >
            {t('list.unread')}
          </span>
        );
    }
  };

  const owner = view.ownerFirstName ?? t('list.unassigned');

  return (
    <>
      {view.staffAvatar ? (
        <span
          role="img"
          aria-label={t('list.staff')}
          className="border-primary text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold"
        >
          {initials}
        </span>
      ) : (
        <span
          aria-hidden
          className="bg-muted text-muted-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
        >
          {initials}
        </span>
      )}

      <div className="border-wa-divider min-w-0 flex-1 self-stretch border-b py-2.5 pr-3">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              'text-wa-text truncate text-[15px] leading-5',
              unread ? 'font-semibold' : 'font-medium'
            )}
          >
            {displayName}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {personalLabel && (
              <span
                role="img"
                aria-label={personalLabel}
                title={personalLabel}
                className="text-info inline-flex"
              >
                <Smartphone className="h-3 w-3" />
              </span>
            )}
            <span
              className={cn(
                'text-xs',
                unread
                  ? 'text-wa-green font-semibold'
                  : 'text-wa-text-secondary'
              )}
            >
              {time}
            </span>
          </span>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {view.tags.map(tag)}
          <span
            role="img"
            className="text-wa-text-secondary ml-auto max-w-[8rem] shrink-0 truncate pl-1 text-xs"
            aria-label={
              view.ownerFirstName
                ? t('list.ownerAria', { name: view.ownerFirstName })
                : t('list.unassigned')
            }
          >
            {owner}
          </span>
        </div>
      </div>
    </>
  );
}
