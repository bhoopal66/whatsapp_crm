'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { MessagesSquare } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { SearchResults } from '@/components/chat/search-results';

/** No channel open: search results for ?search=, else a prompt to pick one. */
function ChatHome() {
  const t = useTranslations('Chat');
  const search = useSearchParams().get('search')?.trim();
  if (search) return <SearchResults query={search} />;
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

export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <ChatHome />
    </Suspense>
  );
}
