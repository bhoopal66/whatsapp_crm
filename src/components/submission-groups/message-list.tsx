'use client';

import { useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertCircle, Ban, Check, Clock } from 'lucide-react';

import { groupMessagesByDay } from '@/lib/groups/group-page';
import { GroupMessageMedia } from '@/components/groups/group-message-media';
import { ContactCardMessage } from '@/components/inbox/contact-card-message';
import { groupContactCards, groupMediaView } from '@/lib/groups/group-media';
import { senderColors } from '@/lib/groups/sender-colors';
import {
  bubbleKind,
  isAutomatic,
  sendStatusOf,
  staffSenderLine,
  type SgMessage,
  waIdPhone,
} from '@/lib/submission-groups/ui';
import { cn } from '@/lib/utils';

/**
 * A submission group's messages by day: staff right, customer and
 * coordinator left, every sender in a colour of their own.
 */
export function MessageList({ messages }: { messages: readonly SgMessage[] }) {
  const t = useTranslations('SubmissionGroups.chat');
  const locale = useLocale();
  const colorOf = useMemo(() => senderColors(messages), [messages]);
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
            const color = colorOf(m);
            const media = groupMediaView(m.type, m.media, m.body);
            const cards = groupContactCards(m.type, m.media, m.body);
            const sender = isAutomatic(m)
              ? t('automatic')
              : out
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
                    color.stripe,
                    out
                      ? 'bg-wa-bubble-out rounded-tr-sm border-e-4'
                      : 'bg-wa-bubble-in rounded-tl-sm border-s-4'
                  )}
                >
                  <p
                    className={cn(
                      'flex flex-wrap items-center gap-1.5 text-xs font-medium',
                      out ? color.textOut : color.text
                    )}
                  >
                    <span dir="auto">{sender ?? t('someone')}</span>
                    {!out && (
                      <span className="text-muted-foreground font-normal">
                        {t(`kind.${kind}`)}
                      </span>
                    )}
                    {m.post_end && (
                      <span className="bg-warning-soft text-warning rounded-full px-1.5 py-0.5 text-xs font-medium">
                        {t('afterEnd')}
                      </span>
                    )}
                  </p>
                  {cards ? (
                    <ContactCardMessage cards={cards} />
                  ) : media ? (
                    <GroupMessageMedia view={media} />
                  ) : (
                    <p className="break-words whitespace-pre-wrap">
                      {m.body || (
                        <span className="text-muted-foreground italic">
                          {t('attachment')}
                        </span>
                      )}
                    </p>
                  )}
                  <p className="text-wa-meta mt-0.5 flex items-center justify-end gap-1 text-xs">
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
