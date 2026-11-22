'use client';

/**
 * The HR inbox's list header (`/hr/*`, migration 200; package 023d-1),
 * inside the conversation list's column: the title above the list's own
 * search, then the quick filters (All / Unread / Mine / Urgent with
 * `hr_counts()` numbers), the department's topic-group chips, the stage
 * or topic and reply-state dropdowns with the Closed toggle, and a
 * removable chip per filter that is on. It owns no filter state: the
 * page reads the filters from the URL and writes `onChange`'s value
 * back. Numbers come from the shared `useHrCounts()` poll (the sidebar
 * uses the same one); a number is hidden until it is answered.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { useHrCounts } from '@/hooks/use-hr-counts';
import { loadHrRoles } from '@/lib/hr/roles-cache';
import {
  hrInboxLinks,
  hrTopicChips,
  hrTopicOptGroups,
} from '@/lib/hr/topic-ui';
import {
  HR_TABS,
  activeHrQuick,
  applyHrQuick,
  clearHrChip,
  hrActiveChips,
  hrQuickCounts,
  hrQuickFilters,
  hrTabCounts,
  switchHrTab,
  type HrActiveChip,
  type HrListFilters,
  type HrQuickFilter,
  type HrTab,
} from '@/lib/hr/list-filters';
import {
  HR_REPLY_STATES,
  HR_STAGES,
  type HrCounts,
  type HrReplyState,
  type HrRoles,
  type HrStage,
  type HrTopic,
} from '@/lib/hr/types';
import { cn } from '@/lib/utils';

const NATIVE_FIELD =
  'border-input bg-card dark:bg-input/30 h-7 min-w-0 flex-1 rounded-md border px-2 text-xs';

const QUICK_LABEL: Record<HrQuickFilter, string> = {
  all: 'list.quickAll',
  unread: 'list.quickUnread',
  mine: 'list.quickMine',
  urgent: 'list.quickUrgent',
};

const TITLE: Record<HrTab, string> = {
  all: 'list.titleAll',
  recruiter: 'list.titleRecruiter',
  dept: 'list.titleDept',
  unsorted: 'list.titleUnsorted',
};

/** The list column's title; HR department carries a sub-line. */
export function HrListTitle({ tab }: { tab: HrTab }) {
  const t = useTranslations('Hr');
  return (
    <div className="px-0.5">
      <h2 className="text-foreground text-lg leading-tight font-semibold">
        {t(TITLE[tab])}
      </h2>
      {tab === 'dept' && (
        <p className="text-muted-foreground text-xs">
          {t('list.deptSubtitle')}
        </p>
      )}
    </div>
  );
}

export interface HrListHeaderViewProps {
  filters: HrListFilters;
  onChange: (next: HrListFilters) => void;
  counts: HrCounts | null;
  /**
   * The route fixes the tab (/hr/recruiter, /hr/department,
   * /hr/unsorted): the tab row and the links are not shown, as the
   * sidebar's HR group carries both.
   */
  fixedTab?: boolean;
  /** The role-gated setup links; null while the roles load. */
  links?: { hireFast: boolean; automatedMessages: boolean } | null;
}

/** The controls under the search, without data loading (tested). */
export function HrListHeaderView({
  filters,
  onChange,
  counts,
  fixedTab = false,
  links = null,
}: HrListHeaderViewProps) {
  const t = useTranslations('Hr');
  const set = (patch: Partial<HrListFilters>) =>
    onChange({ ...filters, ...patch });
  const unsorted = filters.tab === 'unsorted';
  const quick = activeHrQuick(filters);
  const quickCounts = hrQuickCounts(counts, filters.tab);
  const tabCounts = counts ? hrTabCounts(counts) : null;
  const chips = hrActiveChips(filters);

  const tabLabel = (tab: HrTab) =>
    tab === 'all'
      ? t('list.tabAll')
      : tab === 'unsorted'
        ? t('list.tabUnsorted')
        : t(`inbox.${tab}`);

  const chipLabel = (chip: HrActiveChip): string => {
    switch (chip.key) {
      case 'stage':
        return `${t('list.stagePrefix')}${t(`stage.${chip.value}`)}`;
      case 'topic':
        return `${t('list.topicPrefix')}${t(`topic.${chip.value}`)}`;
      case 'topicGroup':
        return t(`topicFilter.${chip.value}`);
      case 'reply':
        return `${t('list.replyPrefix')}${t(`replyState.${chip.value}`)}`;
      case 'urgent':
        return t('flag.urgent');
      case 'mine':
        return t('list.mine');
      case 'closed':
        return t('list.closed');
    }
  };

  return (
    <div
      role="group"
      aria-label={t('list.filtersAria')}
      className="space-y-2 text-xs"
    >
      {!fixedTab && (
        <div
          role="group"
          aria-label={t('list.tabsAria')}
          className="flex flex-wrap gap-1"
        >
          {HR_TABS.map((tab) => {
            const label = tabLabel(tab);
            const n = tabCounts?.[tab];
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
      )}

      <div
        role="radiogroup"
        aria-label={t('list.quickAria')}
        className="flex flex-wrap gap-1.5"
      >
        {hrQuickFilters(filters.tab).map((q) => {
          const active = quick === q;
          const label = t(QUICK_LABEL[q]);
          const n = quickCounts[q];
          return (
            <button
              key={q}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={
                n === undefined
                  ? label
                  : t('list.tabCountAria', { label, count: n })
              }
              onClick={() => onChange(applyHrQuick(filters, q))}
              className={cn(
                'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[12.5px] whitespace-nowrap transition-colors',
                active
                  ? 'border-primary bg-primary/10 text-primary font-medium'
                  : 'border-input bg-card text-foreground hover:bg-card-2'
              )}
            >
              {label}
              {n !== undefined && (
                <span aria-hidden className="tabular-nums">
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {filters.tab === 'dept' && (
        <div
          role="group"
          aria-label={t('list.topicGroupsAria')}
          className="flex flex-wrap gap-1"
        >
          {hrTopicChips().map((chip) => {
            const active = filters.topicGroup === chip.value;
            return (
              <button
                key={chip.value ?? 'all'}
                type="button"
                aria-pressed={active}
                onClick={() => set({ topicGroup: chip.value })}
                className={cn(
                  'h-6 rounded-md border px-2 text-xs transition-colors',
                  active
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-input text-muted-foreground hover:text-foreground'
                )}
              >
                {t(chip.labelKey)}
              </button>
            );
          })}
        </div>
      )}

      {!unsorted && (
        <div className="flex items-center gap-1.5">
          {filters.tab === 'recruiter' && (
            <label className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="text-muted-foreground shrink-0">
                {t('list.stageLabel')}
              </span>
              <select
                className={NATIVE_FIELD}
                value={filters.stage ?? ''}
                onChange={(e) =>
                  set({ stage: (e.target.value || null) as HrStage | null })
                }
              >
                <option value="">{t('list.any')}</option>
                {HR_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {t(`stage.${s}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {filters.tab === 'dept' && (
            <label className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="text-muted-foreground shrink-0">
                {t('list.topicLabel')}
              </span>
              <select
                className={NATIVE_FIELD}
                value={filters.topic ?? ''}
                onChange={(e) =>
                  set({ topic: (e.target.value || null) as HrTopic | null })
                }
              >
                <option value="">{t('list.any')}</option>
                {hrTopicOptGroups().map((g) => (
                  <optgroup key={g.group} label={t(g.labelKey)}>
                    {g.topics.map((s) => (
                      <option key={s} value={s}>
                        {t(`topic.${s}`)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          )}
          <label className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="text-muted-foreground shrink-0">
              {t('list.replyStateLabel')}
            </span>
            <select
              className={NATIVE_FIELD}
              value={filters.reply ?? ''}
              onChange={(e) =>
                set({
                  reply: (e.target.value || null) as HrReplyState | null,
                })
              }
            >
              <option value="">{t('list.any')}</option>
              {HR_REPLY_STATES.map((s) => (
                <option key={s} value={s}>
                  {t(`replyState.${s}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1">
        {chips.length > 0 && (
          <ul
            aria-label={t('list.activeAria')}
            className="flex flex-wrap gap-1"
          >
            {chips.map((chip) => {
              const label = chipLabel(chip);
              return (
                <li
                  key={chip.key}
                  className="bg-card-2 text-foreground inline-flex h-6 items-center gap-1 rounded-full border pe-1 ps-2"
                >
                  {label}
                  <button
                    type="button"
                    aria-label={t('list.removeChip', { label })}
                    onClick={() => onChange(clearHrChip(filters, chip.key))}
                    className="text-muted-foreground hover:text-foreground rounded-full p-0.5"
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {/* Closed chats stay findable, to reopen them. */}
        <Button
          type="button"
          size="xs"
          variant={filters.closed ? 'secondary' : 'ghost'}
          aria-pressed={filters.closed}
          className={cn('ms-auto', filters.closed && 'ring-ring/50 ring-1')}
          onClick={() => set({ closed: !filters.closed })}
        >
          {t('list.showClosed')}
        </Button>
      </div>

      {!fixedTab && links && (
        <div className="flex flex-wrap gap-2">
          {links.hireFast && (
            <HeaderLink href="/hr/hire-fast" label={t('list.hireFast')} />
          )}
          {links.automatedMessages && (
            <HeaderLink
              href="/hr/automated-messages"
              label={t('list.automatedMessages')}
            />
          )}
          <HeaderLink href="/hr/tasks" label={t('list.tasks')} />
          <HeaderLink href="/hr/rules" label={t('list.setup')} />
        </div>
      )}
    </div>
  );
}

function HeaderLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
    >
      {label}
    </Link>
  );
}

/** The header's controls with their data: counts and setup links. */
export function HrListHeader({
  filters,
  onChange,
  fixedTab = false,
}: Pick<HrListHeaderViewProps, 'filters' | 'onChange' | 'fixedTab'>) {
  const counts = useHrCounts();
  const { accountId, user } = useAuth();
  const userId = user?.id ?? null;
  const [roles, setRoles] = useState<HrRoles | null>(null);

  // Roles decide which setup links show (the unfixed view only); cached,
  // shared with the panel.
  useEffect(() => {
    if (fixedTab || !accountId || !userId) return;
    let alive = true;
    loadHrRoles(accountId, userId)
      .then((r) => {
        if (alive) setRoles(r);
      })
      .catch(() => {
        // No roles: the role-gated links stay hidden.
      });
    return () => {
      alive = false;
    };
  }, [fixedTab, accountId, userId]);

  return (
    <HrListHeaderView
      filters={filters}
      onChange={onChange}
      counts={counts}
      fixedTab={fixedTab}
      links={fixedTab ? null : hrInboxLinks(roles)}
    />
  );
}
