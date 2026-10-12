'use client';

import { MessagesSquare } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** The drill-in list is the sidebar; on a wide screen this pane prompts. */
export default function DealRoomsPage() {
  const t = useTranslations('Chat.rooms');
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <MessagesSquare className="text-muted-foreground size-10" />
      <h2 className="text-foreground text-lg font-semibold">
        {t('pickTitle')}
      </h2>
      <p className="text-muted-foreground max-w-sm text-sm">{t('pickBody')}</p>
    </div>
  );
}
