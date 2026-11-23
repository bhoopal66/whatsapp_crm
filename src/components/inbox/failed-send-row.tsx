'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, RotateCcw, X } from 'lucide-react';

import type { Message } from '@/types';
import {
  canRetry,
  copyableText,
  type FailedSend,
} from '@/lib/inbox/failed-send';
import { MessageBubble } from './message-bubble';
import { buildReplyPreview } from './reply-quote';
import type { SenderLabel } from './sender-label';

interface FailedSendRowProps {
  failed: FailedSend;
  /** The message it quotes, when that is loaded. */
  parent: Message | undefined;
  /** Who sent a message: the unsent one's line and its quote's author. */
  senderLabel: (message: Message) => SenderLabel;
  onRetry: (failed: FailedSend) => void;
  onCopy: (text: string) => void;
  onDiscard: (failed: FailedSend) => void;
}

/**
 * A reply that was not, or may not have been, sent: Retry only when it
 * certainly was not (lib/inbox/failed-send.ts), Copy and Discard.
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
  senderLabel,
  onRetry,
  onCopy,
  onDiscard,
}: FailedSendRowProps) {
  const t = useTranslations('Inbox.failedSend');
  const tQuote = useTranslations('Inbox.replyQuote');

  const reply = useMemo(() => {
    if (!failed.message.reply_to_message_id || !parent) return null;
    return {
      authorLabel: senderLabel(parent).text,
      preview: buildReplyPreview(parent, tQuote),
    };
  }, [failed.message.reply_to_message_id, parent, senderLabel, tQuote]);

  const maybe = failed.kind === 'maybe';
  const heading = maybe ? t('maybeSentTitle') : t('notSent');
  const copyText = copyableText(failed);

  return (
    <div className="flex w-full justify-end" role="group" aria-label={heading}>
      {/* Same width cap and `min-w-0` as <MessageActions> (issue #165). */}
      <div className="flex max-w-[75%] min-w-0 flex-col items-end gap-1">
        <MessageBubble
          message={failed.message}
          sender={senderLabel(failed.message)}
          reply={reply}
        />
        {/* The toast with the reason is gone in seconds, so the reason
            stays here too. */}
        <p
          className="line-clamp-2 max-w-full text-end text-xs break-words"
          title={failed.reason}
        >
          <span
            className={
              maybe
                ? 'text-warning font-medium'
                : 'text-destructive font-medium'
            }
          >
            {heading}
          </span>
          <span className="text-muted-foreground"> · {failed.reason}</span>
        </p>
        <div className="flex items-center gap-2 text-xs">
          {canRetry(failed.kind) && (
            <button
              type="button"
              onClick={() => onRetry(failed)}
              title={t('retryTitle')}
              className="border-border bg-card text-foreground hover:bg-muted inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 font-medium"
            >
              <RotateCcw className="h-3 w-3" />
              {t('retry')}
            </button>
          )}
          {copyText && (
            <button
              type="button"
              onClick={() => onCopy(copyText)}
              title={t('copyTitle')}
              className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5"
            >
              <Copy className="h-3 w-3" />
              {t('copy')}
            </button>
          )}
          <button
            type="button"
            onClick={() => onDiscard(failed)}
            title={t(maybe ? 'discardMaybeTitle' : 'discardTitle')}
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
