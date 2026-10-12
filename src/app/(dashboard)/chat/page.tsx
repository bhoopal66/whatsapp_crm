'use client';

import { MessagesSquare } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * Team chat — the one screen a bank guest may open (the dashboard shell
 * keeps a guest here). A placeholder until team chat ships.
 */
export default function ChatPage() {
  const t = useTranslations('Chat');
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 py-16 text-center">
      <MessagesSquare className="text-muted-foreground size-10" />
      <h2 className="text-foreground text-lg font-semibold">
        {t('settingUpTitle')}
      </h2>
      <p className="text-muted-foreground max-w-sm text-sm">
        {t('settingUpBody')}
      </p>
    </div>
  );
}
