'use client';

import { useTranslations } from 'next-intl';

import { stageIndex } from '@/lib/hr/access';
import type { HrListRow } from '@/lib/hr/list-filters';
import { HR_STAGES } from '@/lib/hr/types';

// Complete literal class strings (Tailwind cannot see composed names),
// status tokens, each raw hue with a dark: pair (CLAUDE.md).
const CHIP =
  'inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium leading-4';
const REPLY_CLASS = {
  new: 'bg-info-soft text-info',
  reply_due: 'bg-warning-soft text-warning',
  waiting: 'bg-muted text-muted-foreground',
} as const;
const TOPIC_CLASS =
  'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300';

/**
 * The HR chips on an HR-inbox row (migration 200): stage marker or
 * topic tag, reply state, Urgent, Upset. They sit on the meta line and
 * never replace the message preview; every chip carries words and an
 * aria-label.
 */
export function HrChips({ hr }: { hr: HrListRow | null | undefined }) {
  const t = useTranslations('Hr');
  if (!hr) return null;
  const reached = stageIndex(hr.stage_key);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {hr.inbox === 'recruiter' && hr.stage_key ? (
        <span
          className={`${CHIP} bg-muted text-foreground`}
          aria-label={t('list.stageAria', {
            stage: t(`stage.${hr.stage_key}`),
          })}
        >
          <span aria-hidden className="inline-flex items-end gap-px">
            {HR_STAGES.map((s, i) => (
              <span
                key={s}
                className={
                  i <= reached
                    ? 'bg-primary h-2 w-1 rounded-sm'
                    : 'bg-muted-foreground/30 h-2 w-1 rounded-sm'
                }
              />
            ))}
          </span>
          {t(`stage.${hr.stage_key}`)}
        </span>
      ) : null}
      {hr.inbox === 'dept' && hr.topic ? (
        <span
          className={`${CHIP} ${TOPIC_CLASS}`}
          aria-label={t('list.topicAria', { topic: t(`topic.${hr.topic}`) })}
        >
          {t(`topic.${hr.topic}`)}
        </span>
      ) : null}
      {hr.closed_at === null ? (
        <span
          className={`${CHIP} ${REPLY_CLASS[hr.reply_state]}`}
          aria-label={t('list.replyAria', {
            state: t(`replyState.${hr.reply_state}`),
          })}
        >
          {t(`replyState.${hr.reply_state}`)}
        </span>
      ) : (
        <span
          className={`${CHIP} bg-muted text-muted-foreground`}
          aria-label={t('list.closed')}
        >
          {t('list.closed')}
        </span>
      )}
      {hr.urgent ? (
        <span
          className={`${CHIP} bg-destructive-soft text-destructive`}
          aria-label={t('flag.urgent')}
        >
          {t('flag.urgent')}
        </span>
      ) : null}
      {hr.upset ? (
        <span
          className={`${CHIP} bg-warning-soft text-warning`}
          aria-label={t('flag.upset')}
        >
          {t('flag.upset')}
        </span>
      ) : null}
    </span>
  );
}
