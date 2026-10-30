'use client';

import { useTranslations } from 'next-intl';

import { useTypers } from '@/hooks/use-typers';
import { typingLabel } from '@/lib/chat';

import { useChatWorkspaceContext } from './chat-context';

/**
 * "Sara is typing…" just above a composer. The line always takes its
 * height, so appearing or fading never moves the timeline or the input.
 */
export function TypingIndicator({
  channelId,
  threadRootId = null,
}: {
  channelId: string;
  threadRootId?: string | null;
}) {
  const t = useTranslations('Chat');
  const ws = useChatWorkspaceContext();
  const typers = useTypers(ws, channelId, threadRootId);
  // Someone not (yet) in the people list is left out rather than unnamed.
  const names = typers.flatMap((id) => {
    const name = ws.peopleById.get(id.toLowerCase())?.fullName?.trim();
    return name ? [name] : [];
  });
  const label = names.length ? typingLabel(names) : null;

  return (
    <div
      aria-live="polite"
      className="text-muted-foreground flex h-5 shrink-0 items-center gap-1.5 truncate px-4 text-xs"
    >
      {label && (
        <>
          <span aria-hidden className="flex items-center gap-0.5">
            {[0, 150, 300].map((delay) => (
              <span
                key={delay}
                className="bg-muted-foreground/70 size-1 rounded-full motion-safe:animate-bounce"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </span>
          <span className="truncate">
            {label.key === 'one'
              ? t('typing.one', { name: label.names[0] })
              : label.key === 'two'
                ? t('typing.two', {
                    first: label.names[0],
                    second: label.names[1],
                  })
                : t('typing.many')}
          </span>
        </>
      )}
    </div>
  );
}
