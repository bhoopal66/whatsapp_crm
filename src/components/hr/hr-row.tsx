'use client';

import type { ReactNode } from 'react';
import { Flag, Frown } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { HrListRow } from '@/lib/hr/list-filters';
import { hrRowView, type HrRowTag } from '@/lib/hr/row-view';
import { HR_STAGES } from '@/lib/hr/types';
import { cn } from '@/lib/utils';

// Complete literal class strings (Tailwind cannot see composed names),
// status tokens, each raw hue with a dark: pair (CLAUDE.md).
const TAG = 'inline-flex shrink-0 items-center gap-1 text-xs leading-4';
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

/**
 * An HR-inbox row's HR line: the stage marker (recruiter), the topic
 * (dept) or "Not sorted", then the reply state or Closed, Urgent and
 * Upset. It closes the normal inbox row, which carries everything else.
 */
export function HrRowTags({ hr }: { hr: HrListRow | null }) {
  const t = useTranslations('Hr');
  const view = hrRowView(hr);

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
            className="bg-muted text-muted-foreground inline-flex shrink-0 items-center rounded px-1.5 text-xs leading-4"
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
            className="bg-muted text-muted-foreground inline-flex shrink-0 items-center rounded px-1.5 text-xs leading-4"
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
      case 'upset':
        return (
          <span
            key="upset"
            role="img"
            aria-label={t('flag.upset')}
            className={cn(TAG, 'text-warning')}
          >
            <Frown className="h-3 w-3" />
            {t('flag.upset')}
          </span>
        );
    }
  };

  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {view.tags.map(tag)}
    </div>
  );
}

/**
 * The department view's accent: the row's own avatar inside a primary
 * ring, labelled Staff. Any other HR row passes the avatar through.
 */
export function HrStaffRing({
  hr,
  children,
}: {
  hr: HrListRow | null;
  children: ReactNode;
}) {
  const t = useTranslations('Hr');
  if (!hrRowView(hr).staffAvatar) return <>{children}</>;
  return (
    <span
      role="img"
      aria-label={t('list.staff')}
      className="border-primary inline-flex shrink-0 rounded-full border-2"
    >
      {children}
    </span>
  );
}
