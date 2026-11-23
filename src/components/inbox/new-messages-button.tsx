'use client';

import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * Floats over the end of the thread while messages that arrived below
 * the reader's place are out of sight. Rendered right after the
 * scroller, in a box with no height so nothing moves.
 */
export function NewMessagesButton({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  const t = useTranslations('Inbox.messageThread');
  if (count <= 0) return null;
  return (
    <div className="relative z-10 h-0">
      <button
        type="button"
        onClick={onClick}
        className="bg-wa-panel text-wa-text border-border focus-visible:ring-ring absolute end-4 bottom-3 flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium shadow-md outline-none focus-visible:ring-2"
      >
        <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0" />
        {t('newMessagesBelow', { count })}
      </button>
    </div>
  );
}
