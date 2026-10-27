'use client';

import { useLocale, useTranslations } from 'next-intl';
import { AlertCircle, Ban, Check, Clock } from 'lucide-react';

import { groupMessagesByDay } from '@/lib/groups/group-page';
import {
  bubbleKind,
  sendStatusOf,
  staffSenderLine,
  type SgMessage,
  waIdPhone,
} from '@/lib/submission-groups/ui';
import { cn } from '@/lib/utils';

/** A submission group's messages by day: staff right, customer and coordinator left. */
export function MessageList({ messages }: { messages: readonly SgMessage[] }) {
  const t = useTranslations('SubmissionGroups.chat');
  const locale = useLocale();
  const dayLabel = (day: string) =>
    day
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: 'full',
          timeZone: 'UTC',
        }).format(new Date(`${day}T00:00:00Z`))
      : '';
  const timeLabel = (iso: string) =>
    new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(
      new Date(iso)
    );

  return (
    <>
      {groupMessagesByDay(messages).map((g) => (
        <div key={g.day || 'unknown'} className="space-y-1.5">
          <div className="flex justify-center">
            <span className="bg-wa-date-chip text-wa-date-chip-fg rounded-lg px-3 py-1 text-xs shadow-sm">
              {dayLabel(g.day)}
            </span>
          </div>
          {g.messages.map((m) => {
            const kind = bubbleKind(m);
            const status = sendStatusOf(m);
            const out = kind === 'staff';
            const sender = out
              ? staffSenderLine(m)
              : m.sender_name || waIdPhone(m.sender_wa_id);
            return (
              <div
                key={m.id}
                className={cn('flex', out ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cn(
                    'text-foreground max-w-[85%] rounded-xl px-3 py-1.5 text-sm shadow-sm sm:max-w-[70%]',
                    out ? 'bg-wa-bubble-out rounded-tr-sm' : 'rounded-tl-sm',
                    kind === 'customer' && 'bg-wa-bubble-in',
                    kind === 'coordinator' &&
                      'bg-wa-bubble-in border-info border-l-2',
                    kind === 'other' && 'bg-wa-bubble-in'
                  )}
                >
                  <p
                    className={cn(
                      'flex flex-wrap items-center gap-1.5 text-xs font-medium',
                      kind === 'coordinator' ? 'text-info' : 'text-primary'
                    )}
                  >
                    <span dir="auto">{sender ?? t('someone')}</span>
                    {!out && (
                      <span className="text-muted-foreground font-normal">
                        {t(`kind.${kind}`)}
                      </span>
                    )}
                    {m.post_end && (
                      <span className="bg-warning-soft text-warning rounded-full px-1.5 py-0.5 text-[10px] font-medium">
                        {t('afterEnd')}
                      </span>
                    )}
                  </p>
                  <p className="break-words whitespace-pre-wrap">
                    {m.body || (
                      <span className="text-muted-foreground italic">
                        {t('attachment')}
                      </span>
                    )}
                  </p>
                  <p className="text-wa-meta mt-0.5 flex items-center justify-end gap-1 text-[11px]">
                    {timeLabel(m.created_at)}
                    {status && (
                      <span
                        className={cn(
                          'inline-flex items-center gap-0.5',
                          (status === 'failed' || status === 'blocked') &&
                            'text-destructive'
                        )}
                      >
                        {status === 'pending' && (
                          <Clock className="size-3" aria-hidden />
                        )}
                        {status === 'sent' && (
                          <Check className="size-3.5" aria-hidden />
                        )}
                        {status === 'failed' && (
                          <AlertCircle className="size-3.5" aria-hidden />
                        )}
                        {status === 'blocked' && (
                          <Ban className="size-3.5" aria-hidden />
                        )}
                        {t(`status.${status}`)}
                      </span>
                    )}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}
