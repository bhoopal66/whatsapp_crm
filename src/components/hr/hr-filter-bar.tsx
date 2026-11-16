'use client';

/**
 * The HR inbox's filter bar (`/hr-inbox`, migration 200): the four tabs
 * with their `hr_counts()` numbers, the stage / topic / reply selects,
 * the Urgent, Mine and Closed toggles, and the links to HR tasks and
 * setup. It owns no filter state: the page reads the filters from the
 * URL and writes `onChange`'s value back. Counts refresh on mount, on
 * every filter change and once a minute while the tab is visible; a
 * number is hidden while it loads or when the read fails.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { hrCounts } from '@/lib/hr/api';
import {
  HR_TABS,
  hrTabCounts,
  switchHrTab,
  type HrListFilters,
  type HrTab,
} from '@/lib/hr/list-filters';
import {
  HR_REPLY_STATES,
  HR_STAGES,
  HR_TOPICS,
  type HrReplyState,
  type HrStage,
  type HrTopic,
} from '@/lib/hr/types';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

const REFRESH_MS = 60_000;

const NATIVE_FIELD =
  'border-input bg-card dark:bg-input/30 h-7 rounded-md border px-2 text-xs';

interface HrFilterBarProps {
  filters: HrListFilters;
  onChange: (next: HrListFilters) => void;
}

export function HrFilterBar({ filters, onChange }: HrFilterBarProps) {
  const t = useTranslations('Hr');
  const [counts, setCounts] = useState<Record<HrTab, number> | null>(null);

  // `filters` is a dependency on purpose: a filter change is the moment
  // the person looks at the numbers, so they are re-read then too.
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.visibilityState !== 'visible') return;
      void hrCounts(createClient()).then((res) => {
        if (alive) setCounts('error' in res ? null : hrTabCounts(res.data));
      });
    };
    load();
    const id = window.setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [filters]);

  const tabLabel = (tab: HrTab) =>
    tab === 'all'
      ? t('list.tabAll')
      : tab === 'unsorted'
        ? t('list.tabUnsorted')
        : t(`inbox.${tab}`);

  const set = (patch: Partial<HrListFilters>) =>
    onChange({ ...filters, ...patch });
  const unsorted = filters.tab === 'unsorted';

  return (
    <div
      role="group"
      aria-label={t('list.filtersAria')}
      className="bg-card flex flex-wrap items-center gap-1.5 border-b px-3 py-2 text-xs"
    >
      <div
        role="group"
        aria-label={t('list.tabsAria')}
        className="flex flex-wrap gap-1"
      >
        {HR_TABS.map((tab) => {
          const label = tabLabel(tab);
          const n = counts?.[tab];
          return (
            <Button
              key={tab}
              type="button"
              size="xs"
              variant={filters.tab === tab ? 'default' : 'outline'}
              aria-pressed={filters.tab === tab}
              aria-label={
                n === undefined
                  ? label
                  : t('list.tabCountAria', { label, count: n })
              }
              onClick={() => {
                if (filters.tab !== tab) onChange(switchHrTab(filters, tab));
              }}
            >
              {label}
              {n !== undefined && (
                <span aria-hidden className="tabular-nums opacity-70">
                  {n}
                </span>
              )}
            </Button>
          );
        })}
      </div>

      {filters.tab === 'recruiter' && (
        <select
          aria-label={t('list.stageLabel')}
          className={NATIVE_FIELD}
          value={filters.stage ?? ''}
          onChange={(e) =>
            set({ stage: (e.target.value || null) as HrStage | null })
          }
        >
          <option value="">{t('list.anyStage')}</option>
          {HR_STAGES.map((s) => (
            <option key={s} value={s}>
              {t(`stage.${s}`)}
            </option>
          ))}
        </select>
      )}

      {filters.tab === 'dept' && (
        <select
          aria-label={t('list.topicLabel')}
          className={NATIVE_FIELD}
          value={filters.topic ?? ''}
          onChange={(e) =>
            set({ topic: (e.target.value || null) as HrTopic | null })
          }
        >
          <option value="">{t('list.anyTopic')}</option>
          {HR_TOPICS.map((s) => (
            <option key={s} value={s}>
              {t(`topic.${s}`)}
            </option>
          ))}
        </select>
      )}

      {!unsorted && (
        <select
          aria-label={t('list.replyLabel')}
          className={NATIVE_FIELD}
          value={filters.reply ?? ''}
          onChange={(e) =>
            set({ reply: (e.target.value || null) as HrReplyState | null })
          }
        >
          <option value="">{t('list.anyReply')}</option>
          {HR_REPLY_STATES.map((s) => (
            <option key={s} value={s}>
              {t(`replyState.${s}`)}
            </option>
          ))}
        </select>
      )}

      {!unsorted && (
        <Toggle
          on={filters.urgent}
          label={t('flag.urgent')}
          onClick={() => set({ urgent: !filters.urgent })}
        />
      )}
      <Toggle
        on={filters.mine}
        label={t('list.mine')}
        onClick={() => set({ mine: !filters.mine })}
      />
      <Toggle
        on={filters.closed}
        label={t('list.showClosed')}
        onClick={() => set({ closed: !filters.closed })}
      />

      <div className="ml-auto flex gap-2">
        <Link
          href="/hr-inbox/tasks"
          className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
        >
          {t('list.tasks')}
        </Link>
        <Link
          href="/hr-inbox/setup"
          className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
        >
          {t('list.setup')}
        </Link>
      </div>
    </div>
  );
}

function Toggle({
  on,
  label,
  onClick,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant={on ? 'secondary' : 'ghost'}
      aria-pressed={on}
      className={cn(on && 'ring-ring/50 ring-1')}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}
