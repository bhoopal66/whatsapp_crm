'use client';

import { Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { copyWithToast } from '@/components/context-menu/app-context-menu';
import { formatPhoneDisplay, phoneForCopy } from '@/lib/contacts/phone-format';

/**
 * A phone number shown as `+971 50 123 4401` with a copy button that
 * copies the raw international number. The button is 32px square.
 */
export function PhoneCell({
  phone,
  label,
}: {
  phone: string;
  /** Who the number belongs to, for the button's accessible name. */
  label: string;
}) {
  const t = useTranslations('ContactsTable');
  const tMenu = useTranslations('ContextMenu');
  if (!phone) return <span className="text-muted-foreground">-</span>;
  return (
    <div className="flex items-center gap-1">
      <span className="text-xs whitespace-nowrap tabular-nums">
        {formatPhoneDisplay(phone)}
      </span>
      <button
        type="button"
        aria-label={t('copyNumber', { name: label })}
        title={t('copyNumberShort')}
        onClick={(e) => {
          e.stopPropagation();
          void copyWithToast(phoneForCopy(phone), {
            copied: tMenu('copied'),
            failed: tMenu('copyFailed'),
          });
        }}
        className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring inline-flex size-8 shrink-0 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none"
      >
        <Copy aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}
