'use client';

import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { FolderKanban } from 'lucide-react';

import { cn } from '@/lib/utils';

import { SubmissionGroupsListContext } from './list-context';
import { SubmissionGroupsList } from './submission-groups-list';

/**
 * /submission-groups as a split view, like the Inbox: the list on the
 * left, the selected submission (the route's children) on the right.
 * It lives in the layout, so the list keeps its tab, search and loaded
 * pages while the selection changes. Below lg it is one pane at a time:
 * the list at /submission-groups, the submission at /[id] (whose header
 * has the back link).
 */
export function SubmissionGroupsWorkspace({
  children,
}: {
  children: ReactNode;
}) {
  const params = useParams<{ id?: string }>();
  const selectedId = typeof params?.id === 'string' ? params.id : null;
  const reloadRef = useRef<(() => void) | null>(null);
  const registerRefresh = useCallback((fn: () => void) => {
    reloadRef.current = fn;
    return () => {
      if (reloadRef.current === fn) reloadRef.current = null;
    };
  }, []);
  const ctx = useMemo(
    () => ({ refreshList: () => reloadRef.current?.(), registerRefresh }),
    [registerRefresh]
  );

  return (
    <SubmissionGroupsListContext.Provider value={ctx}>
      <div className="-m-4 flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden sm:-m-6">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div
            className={cn(
              'border-border h-full min-w-0 flex-1 border-r lg:w-[22rem] lg:flex-none',
              selectedId ? 'hidden lg:flex' : 'flex'
            )}
          >
            <SubmissionGroupsList selectedId={selectedId} />
          </div>
          <div
            className={cn(
              'h-full min-h-0 min-w-0 flex-1 flex-col overflow-y-auto',
              selectedId ? 'flex' : 'hidden lg:flex'
            )}
          >
            {children}
          </div>
        </div>
      </div>
    </SubmissionGroupsListContext.Provider>
  );
}

/** The right pane at /submission-groups, before anything is selected. */
export function SubmissionGroupsPlaceholder() {
  const t = useTranslations('SubmissionGroups.list');
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-full">
        <FolderKanban className="size-6" aria-hidden />
      </span>
      <p className="font-semibold">{t('selectTitle')}</p>
      <p className="text-muted-foreground max-w-sm text-sm">
        {t('selectBody')}
      </p>
    </div>
  );
}
