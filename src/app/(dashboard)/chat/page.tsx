'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { MessagesSquare } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** No channel open: a prompt to pick one (search results arrive in a later job). */
function ChatHome() {
  const t = useTranslations('Chat');
  const search = useSearchParams().get('search');
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <MessagesSquare className="text-muted-foreground size-10" />
      <h2 className="text-foreground text-lg font-semibold">
        {search ? t('searchSoon', { q: search }) : t('pickTitle')}
      </h2>
      {!search && (
        <p className="text-muted-foreground max-w-sm text-sm">
          {t('pickBody')}
        </p>
      )}
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <ChatHome />
    </Suspense>
  );
}
