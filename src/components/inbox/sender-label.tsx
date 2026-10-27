'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, Sparkles, Users } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  messageSender,
  type MessageSenderKind,
  type SenderContext,
} from '@/lib/inbox/sender';
import type { Message } from '@/types';

/** A message's sender as the thread words it (lib/inbox/sender.ts). */
export interface SenderLabel {
  kind: MessageSenderKind;
  /** Empty while the name is `pending`. */
  text: string;
  /** What a label that names no person means, on hover. A name shows
   *  itself there instead, whole, since the line may truncate it. */
  title?: string;
}

/**
 * The thread's one wording of who sent a message: the line on each
 * bubble, the author of a quote, the media viewer's title. Stable while
 * its inputs are, so the memoised rows keep their memo.
 */
export function useSenderLabels({
  contactName,
  currentUserId,
  names,
  namesLoaded,
}: SenderContext): (message: Message) => SenderLabel {
  const t = useTranslations('Inbox.sender');
  return useCallback(
    (message: Message): SenderLabel => {
      const sender = messageSender(message, {
        contactName,
        currentUserId,
        names,
        namesLoaded,
      });
      switch (sender.kind) {
        case 'customer':
          return { kind: sender.kind, text: sender.name };
        case 'person':
          return {
            kind: sender.kind,
            text: !sender.name
              ? t('unknown')
              : sender.isMe
                ? t('me', { name: sender.name })
                : sender.name,
          };
        case 'pending':
          return { kind: sender.kind, text: '' };
        case 'ai':
          return { kind: sender.kind, text: t('ai'), title: t('aiTitle') };
        case 'bot':
          return { kind: sender.kind, text: t('bot'), title: t('botTitle') };
        case 'team':
          return { kind: sender.kind, text: t('team'), title: t('teamTitle') };
      }
    },
    [contactName, currentUserId, names, namesLoaded, t]
  );
}

const ICONS: Partial<Record<MessageSenderKind, typeof Bot>> = {
  ai: Sparkles,
  bot: Bot,
  team: Users,
};

/**
 * The small name at the top of a bubble. Customers are on the white
 * bubble and everyone else on the green one, so each side gets the
 * shade that reads on it in both modes.
 */
export function SenderLine({ sender }: { sender: SenderLabel }) {
  const Icon = ICONS[sender.kind];
  return (
    <div
      className={cn(
        'mb-0.5 flex min-w-0 items-center gap-1 text-[12px] leading-4 font-medium',
        sender.kind === 'customer'
          ? 'text-sky-700 dark:text-sky-300'
          : 'text-emerald-800 dark:text-emerald-200'
      )}
      title={sender.title ?? (sender.text || undefined)}
    >
      {Icon && <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />}
      {/* A blank of the same height while the name loads. */}
      <span className="truncate">{sender.text || ' '}</span>
    </div>
  );
}
