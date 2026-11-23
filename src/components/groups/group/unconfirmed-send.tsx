'use client';

import { useTranslations } from 'next-intl';
import { Copy, X } from 'lucide-react';

/**
 * What stands under a group message that may have been sent: no Retry,
 * which could put it in the group twice (lib/groups/unconfirmed-sends.ts).
 */
export function UnconfirmedSendFooter({
  onCopy,
  onDiscard,
}: {
  /** Absent when there are no words to copy. */
  onCopy?: () => void;
  onDiscard: () => void;
}) {
  const t = useTranslations('Inbox.failedSend');
  const button =
    'text-muted-foreground hover:bg-muted hover:text-foreground inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5';
  return (
    <div className="flex max-w-[85%] flex-wrap items-center justify-end gap-2 text-xs sm:max-w-[70%]">
      <span className="text-warning text-end font-medium">
        {t('maybeSentTitle')}
      </span>
      {onCopy && (
        <button
          type="button"
          onClick={onCopy}
          title={t('copyTitle')}
          className={button}
        >
          <Copy className="h-3 w-3" />
          {t('copy')}
        </button>
      )}
      <button
        type="button"
        onClick={onDiscard}
        title={t('discardMaybeTitle')}
        className={button}
      >
        <X className="h-3 w-3" />
        {t('discard')}
      </button>
    </div>
  );
}
