'use client';

import type { ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UsersRound } from 'lucide-react';

import { cn } from '@/lib/utils';

import { GroupsList } from './groups-list';

/**
 * /groups and /groups/[id] as one split view, like the Inbox: the list
 * on the left, the selected group (chat + info) beside it. It lives in
 * the route's layout, so picking another group keeps the list mounted
 * (search, filters, scroll and its realtime channel survive). Below lg
 * one pane at a time: the list on /groups, the group on /groups/[id],
 * whose own back link returns to the list.
 */
export function GroupsWorkspace({ children }: { children: ReactNode }) {
  const params = useParams<{ id?: string | string[] }>();
  const raw = params?.id;
  const selectedId = (Array.isArray(raw) ? raw[0] : raw) ?? null;

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] overflow-hidden sm:-m-6">
      {/* `min-w-0`: a long name must truncate, not widen the pane. */}
      <aside
        className={cn(
          'border-wa-divider bg-wa-panel h-full min-w-0 flex-1 flex-col lg:w-[22rem] lg:flex-none lg:border-r',
          selectedId ? 'hidden lg:flex' : 'flex'
        )}
      >
        <GroupsList selectedId={selectedId} />
      </aside>
      {/* The detail pane: GroupPage (or the placeholder) fills it. */}
      <section
        className={cn(
          'h-full min-h-0 min-w-0 flex-1 flex-col',
          selectedId ? 'flex' : 'hidden lg:flex'
        )}
      >
        {children}
      </section>
    </div>
  );
}

/** The detail pane on /groups (lg and up; below lg it is hidden). */
export function NoGroupSelected() {
  const t = useTranslations('Groups');
  return (
    <div className="bg-wa-panel-header border-b-wa-green flex flex-1 flex-col items-center justify-center border-b-4 px-6 text-center">
      <span className="bg-wa-panel flex size-20 items-center justify-center rounded-full">
        <UsersRound className="text-wa-green size-9" aria-hidden />
      </span>
      <h2 className="text-wa-text mt-5 text-lg font-light">
        {t('selectTitle')}
      </h2>
      <p className="text-wa-text-secondary mt-1 max-w-sm text-sm">
        {t('selectBody')}
      </p>
    </div>
  );
}
