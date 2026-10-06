'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { RotateCcw, X } from 'lucide-react';

import type { Message } from '@/types';
import type { FailedSend } from '@/lib/inbox/failed-send';
import { MessageBubble } from './message-bubble';
import { buildReplyPreview } from './reply-quote';

interface FailedSendRowProps {
  failed: FailedSend;
  /** The message it quotes, when that is loaded. */
  parent: Message | undefined;
  /** Author label for a quote of a customer message. */
  contactLabel: string;
  onRetry: (failed: FailedSend) => void;
  onDiscard: (failed: FailedSend) => void;
}

/**
 * A reply the gateway refused, with Retry and Discard.
 *
 * It sits below the thread and not inside it. The inbox drops every
 * optimistic bubble when any new message arrives, so a failed one kept
 * there would disappear the moment the customer wrote again. The agent
 * still has to act on it, so it stays at the bottom until then. It has
 * no hover toolbar: replying to it or reacting to it would point at a
 * message that does not exist.
 */
export function FailedSendRow({
  failed,
  parent,
  contactLabel,
  onRetry,
  onDiscard,
}: FailedSendRowProps) {
  const t = useTranslations('Inbox.failedSend');
  const tThread = useTranslations('Inbox.messageThread');
  const tQuote = useTranslations('Inbox.replyQuote');

  const reply = useMemo(() => {
    if (!failed.message.reply_to_message_id || !parent) return null;
    return {
      authorLabel:
        parent.sender_type === 'agent' || parent.sender_type === 'bot'
          ? tThread('me')
          : contactLabel,
      preview: buildReplyPreview(parent, tQuote),
    };
  }, [
    failed.message.reply_to_message_id,
    parent,
    contactLabel,
    tThread,
    tQuote,
  ]);

  return (
    <div
      className="flex w-full justify-end"
      role="group"
      aria-label={t('notSent')}
    >
      {/* Same width cap and `min-w-0` as <MessageActions> (issue #165). */}
      <div className="flex max-w-[75%] min-w-0 flex-col items-end gap-1">
        <MessageBubble message={failed.message} reply={reply} />
        {/* The toast with the reason is gone in seconds, so the reason
            stays here too. */}
        <p
          className="line-clamp-2 max-w-full text-right text-[11px] break-words"
          title={failed.reason}
        >
          <span className="font-medium text-red-600 dark:text-red-400">
            {t('notSent')}
          </span>
          <span className="text-muted-foreground"> · {failed.reason}</span>
        </p>
        <div className="flex items-center gap-2 text-[11px]">
          <button
            type="button"
            onClick={() => onRetry(failed)}
            title={t('retryTitle')}
            className="border-border bg-card text-foreground hover:bg-muted inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 font-medium"
          >
            <RotateCcw className="h-3 w-3" />
            {t('retry')}
          </button>
          <button
            type="button"
            onClick={() => onDiscard(failed)}
            title={t('discardTitle')}
            className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5"
          >
            <X className="h-3 w-3" />
            {t('discard')}
          </button>
        </div>
      </div>
    </div>
  );
}
