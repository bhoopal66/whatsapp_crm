'use client';

import { useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertCircle, Check, CheckCheck, Clock } from 'lucide-react';

import {
  groupMessageSender,
  groupMessagesByDay,
  statusTick,
} from '@/lib/groups/group-page';
import { GroupMessageMedia } from '@/components/groups/group-message-media';
import { ContactCardMessage } from '@/components/inbox/contact-card-message';
import { groupContactCards, groupMediaView } from '@/lib/groups/group-media';
import { senderColors } from '@/lib/groups/sender-colors';
import type { WhatsappGroupMessageRow } from '@/lib/groups/types';
import { cn } from '@/lib/utils';

export type GroupChatMessage = Pick<
  WhatsappGroupMessageRow,
  | 'id'
  | 'direction'
  | 'sender_wa_id'
  | 'sender_name'
  | 'type'
  | 'body'
  | 'status'
  | 'created_at'
> &
  Partial<WhatsappGroupMessageRow>;

/**
 * A WhatsApp group's messages by day: ours right, the participants left,
 * every sender in a colour of their own.
 */
export function GroupMessageLog({
  messages,
  currentUserId,
}: {
  messages: readonly GroupChatMessage[];
  currentUserId: string | null;
}) {
  const t = useTranslations('Groups.page');
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
            <span className="bg-muted text-muted-foreground rounded-full px-3 py-0.5 text-xs">
              {dayLabel(g.day)}
            </span>
          </div>
          {g.messages.map((m) => {
            const out = m.direction === 'out';
            const tick = statusTick(m.direction, m.status);
            const sender = groupMessageSender(m, currentUserId);
            const color = colorOf(m);
            const media = groupMediaView(m.type, m.media, m.body);
            const cards = groupContactCards(m.type, m.media, m.body);
            return (
              <div
                key={m.id}
                className={cn('flex', out ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cn(
                    'max-w-[85%] rounded-lg px-3 py-1.5 text-sm shadow-sm sm:max-w-[70%]',
                    color.stripe,
                    out
                      ? 'bg-wa-bubble-out text-foreground border-e-4'
                      : 'bg-wa-bubble-in text-foreground border-s-4'
                  )}
                >
                  <p
                    className={cn(
                      'truncate text-xs font-medium',
                      out ? color.textOut : color.text
                    )}
                  >
                    {sender.name
                      ? sender.isMe
                        ? t('chat.me', { name: sender.name })
                        : sender.name
                      : t(out ? 'chat.yourNumber' : 'chat.someone')}
                  </p>
                  {cards ? (
                    <ContactCardMessage cards={cards} />
                  ) : media ? (
                    <GroupMessageMedia view={media} />
                  ) : (
                    <p className="break-words whitespace-pre-wrap">
                      {m.body || (
                        <span className="text-muted-foreground italic">
                          {t('chat.attachment')}
                        </span>
                      )}
                    </p>
                  )}
                  <p className="text-muted-foreground mt-0.5 flex items-center justify-end gap-1 text-xs">
                    {timeLabel(m.created_at)}
                    {tick === 'clock' && <Clock className="size-3" />}
                    {tick === 'single' && <Check className="size-3.5" />}
                    {tick === 'double' && <CheckCheck className="size-3.5" />}
                    {tick === 'read' && (
                      <CheckCheck className="text-wa-tick-read size-3.5" />
                    )}
                    {tick === 'failed' && (
                      <AlertCircle className="text-destructive size-3.5" />
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
