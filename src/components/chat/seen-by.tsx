'use client';

import { useTranslations } from 'next-intl';

import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  receiptLabel,
  seenBy,
  type ChannelKind,
  type ChannelMember,
  type ChatMessage,
  type ChatPerson,
} from '@/lib/chat';
import { avatarTint, initialOf } from '@/lib/chat/view';
import { cn } from '@/lib/utils';

const MAX_FACES = 3;

export interface SeenByProps {
  message: Pick<ChatMessage, 'createdAt' | 'authorId'>;
  kind: ChannelKind;
  members: readonly ChannelMember[];
  peopleById: ReadonlyMap<string, ChatPerson>;
}

/**
 * The receipt line under the viewer's last own message: "Seen" / "Sent"
 * in a 1:1 DM, else "Seen by N" with a few faces and, on click, who has
 * and hasn't seen it. Nothing where receipts are off (receiptLabel).
 */
export function SeenBy({ message, kind, members, peopleById }: SeenByProps) {
  const t = useTranslations('Chat.receipts');
  const tc = useTranslations('Chat');
  const { seen, unseen } = seenBy({
    createdAt: message.createdAt,
    authorId: message.authorId,
    members,
  });
  const label = receiptLabel({
    kind,
    memberCount: members.length,
    seenCount: seen.length,
  });
  if (label === 'none') return null;

  const line = 'text-muted-foreground pr-4 pl-16 text-xs leading-5';
  if (label === 'seen' || (label === 'sent' && unseen.length <= 1))
    return <p className={line}>{t(label)}</p>;

  const nameOf = (id: string) =>
    peopleById.get(id.toLowerCase())?.fullName || tc('unknownPerson');
  const face = (id: string, small = false) => (
    <span
      key={id}
      aria-hidden
      className={cn(
        'ring-card flex items-center justify-center rounded-full font-bold ring-2',
        small ? 'size-5 text-xs' : 'size-6 text-xs',
        avatarTint(id)
      )}
    >
      {initialOf(peopleById.get(id.toLowerCase())?.fullName)}
    </span>
  );
  const list = (title: string, ids: string[]) =>
    ids.length > 0 && (
      <div>
        <PopoverTitle className="text-muted-foreground mb-1 text-xs">
          {title}
        </PopoverTitle>
        <ul className="space-y-1">
          {ids.map((id) => (
            <li key={id} className="flex items-center gap-2 text-sm">
              {face(id)}
              <span className="truncate">{nameOf(id)}</span>
            </li>
          ))}
        </ul>
      </div>
    );

  return (
    <div className={cn(line, 'flex')}>
      <Popover>
        <PopoverTrigger className="hover:text-foreground focus-visible:ring-ring flex items-center gap-1.5 rounded-sm focus-visible:ring-2 focus-visible:outline-none">
          {label === 'seenBy' && (
            <span className="flex -space-x-1">
              {seen.slice(0, MAX_FACES).map((id) => face(id, true))}
            </span>
          )}
          {label === 'seenBy' ? t('seenBy', { count: seen.length }) : t('sent')}
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-64 gap-3">
          {list(t('seenList'), seen)}
          {list(t('notYetList'), unseen)}
        </PopoverContent>
      </Popover>
    </div>
  );
}
