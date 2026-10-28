'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  Check,
  CheckSquare,
  ChevronDown,
  ListChecks,
  PhoneCall,
  PhoneMissed,
  Route,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import {
  bucketTasks,
  dueLabel,
  limitGroups,
  missedRepeat,
  taskContactIds,
  taskCounts,
  taskTarget,
  type DueLabel,
  type TaskBuckets,
} from '@/lib/dashboard/home/tasks';
import { createClient } from '@/lib/supabase/client';
import type { Task, TaskKind } from '@/lib/tasks/types';
import { cn } from '@/lib/utils';
import { DashboardPanel, PanelEmpty } from './panel';
import { useWidgetData, type WidgetData } from './use-widget-data';

export interface TasksPanelProps {
  /** The person's open tasks; `update` patches the list after a tick. */
  tasks: WidgetData<Task[]>;
  /** A tick started (`pending`) or was refused (`!pending`); a done id stays reported so a stale refresh cannot bring it back. */
  onCompleting?: (id: string, pending: boolean) => void;
  className?: string;
}

/** Rows shown before "Show all". */
const ROW_LIMIT = 8;

const KIND_ICON: Record<TaskKind, LucideIcon> = {
  manual: CheckSquare,
  callback: PhoneCall,
  missed_call: PhoneMissed,
  journey: Route,
  follow_up: Undo2,
};

type MainGroup = 'overdue' | 'today' | 'upcoming';
const MAIN_GROUPS: MainGroup[] = ['overdue', 'today', 'upcoming'];
const REST_GROUPS = ['later', 'undated'] as const;

/** Contact names by id, read through the person's own RLS. */
async function loadContactNames(ids: string[]): Promise<Map<string, string>> {
  const { data, error } = await createClient()
    .from('contacts')
    .select('id, name, phone')
    .in('id', ids);
  if (error) throw error;
  const out = new Map<string, string>();
  for (const c of (data ?? []) as {
    id: string;
    name: string | null;
    phone: string | null;
  }[]) {
    const label = c.name?.trim() || c.phone;
    if (label) out.set(c.id, label);
  }
  return out;
}

/**
 * "My tasks": the person's open tasks grouped by when they are due —
 * overdue, today, the next seven days — with later and undated ones
 * folded away. Ticking one completes it at once and puts it back if
 * the server refuses.
 */
export function TasksPanel({
  tasks,
  onCompleting,
  className,
}: TasksPanelProps) {
  const t = useTranslations('Dashboard.home.tasks');
  const [expanded, setExpanded] = useState(false);
  const [restOpen, setRestOpen] = useState(false);
  // Grouping and due times are against the moment this list arrived:
  // the clock restarts whenever a new list replaces the old one.
  const [clock, setClock] = useState({ list: tasks.data, now: new Date() });
  if (clock.list !== tasks.data)
    setClock({ list: tasks.data, now: new Date() });
  const now = clock.now;

  const list = tasks.data ?? [];
  const contactIds = taskContactIds(list);
  const names = useWidgetData(
    contactIds.length ? `task-contacts:${contactIds.join(',')}` : null,
    () => loadContactNames(contactIds)
  );

  const complete = async (task: Task) => {
    onCompleting?.(task.id, true);
    tasks.update((l) => l.filter((x) => x.id !== task.id));
    const res = await fetch(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    }).catch(() => null);
    if (res?.ok) return;
    onCompleting?.(task.id, false);
    tasks.update((l) => (l.some((x) => x.id === task.id) ? l : [...l, task]));
    toast.error(t('doneFailed'));
  };

  const buckets = bucketTasks(list, now);
  const counts = taskCounts(list, now);
  const subtitle =
    counts.overdue || counts.today
      ? t('subtitle', { overdue: counts.overdue, today: counts.today })
      : counts.open
        ? t('subtitleOpen', { count: counts.open })
        : undefined;

  // The main groups, cut to ROW_LIMIT rows in order unless expanded.
  const shown = limitGroups(
    buckets,
    MAIN_GROUPS,
    expanded ? Infinity : ROW_LIMIT
  );
  const mainTotal = MAIN_GROUPS.reduce((n, g) => n + buckets[g].length, 0);
  const restTotal = buckets.later.length + buckets.undated.length;

  const row = (task: Task) => (
    <TaskRow
      key={task.id}
      task={task}
      now={now}
      contactName={
        task.contact_id ? (names.data?.get(task.contact_id) ?? null) : null
      }
      onComplete={() => void complete(task)}
    />
  );

  return (
    <DashboardPanel
      id="my-tasks"
      title={t('title')}
      subtitle={subtitle}
      icon={ListChecks}
      tone="emerald"
      loading={tasks.loading && !tasks.data}
      error={tasks.error && !tasks.data}
      onRetry={tasks.reload}
      className={cn('scroll-mt-20', className)}
    >
      {counts.open === 0 ? (
        <PanelEmpty
          icon={Check}
          title={t('emptyTitle')}
          hint={t('emptyHint')}
        />
      ) : (
        <div className="space-y-4">
          {shown.map(({ group, rows }) =>
            rows.length ? (
              <Group key={group} title={t(`groups.${group}`)} tone={group}>
                {rows.map(row)}
              </Group>
            ) : null
          )}
          {mainTotal > ROW_LIMIT && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-primary text-xs font-medium hover:underline"
            >
              {expanded ? t('showLess') : t('showAll', { count: mainTotal })}
            </button>
          )}
          {restTotal > 0 && (
            <div>
              <button
                type="button"
                aria-expanded={restOpen}
                onClick={() => setRestOpen((v) => !v)}
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-semibold tracking-wide uppercase"
              >
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 transition-transform',
                    !restOpen && '-rotate-90'
                  )}
                  aria-hidden
                />
                {t('groups.rest')}
                <span className="tabular-nums">({restTotal})</span>
              </button>
              {restOpen && (
                <div className="mt-2 space-y-4">
                  {REST_GROUPS.map((group) =>
                    buckets[group].length ? (
                      <Group key={group} title={t(`groups.${group}`)}>
                        {buckets[group].map(row)}
                      </Group>
                    ) : null
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </DashboardPanel>
  );
}

function Group({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: keyof TaskBuckets;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3
        className={cn(
          'mb-1 text-xs font-semibold tracking-wide uppercase',
          tone === 'overdue' ? 'text-destructive' : 'text-muted-foreground'
        )}
      >
        {title}
      </h3>
      <ul className="divide-border divide-y">{children}</ul>
    </section>
  );
}

function TaskRow({
  task,
  now,
  contactName,
  onComplete,
}: {
  task: Task;
  now: Date;
  contactName: string | null;
  onComplete: () => void;
}) {
  const t = useTranslations('Dashboard.home.tasks');
  const Icon = KIND_ICON[task.kind] ?? CheckSquare;
  const due = dueLabel(task, now);
  const repeat = missedRepeat(task);
  const target = taskTarget(task);
  const linkLabel =
    target?.kind === 'contact' ? contactName : target ? t('openChat') : null;
  return (
    <li className="flex items-center gap-3 py-2">
      <button
        type="button"
        role="checkbox"
        aria-checked={false}
        aria-label={t('markDone', { title: task.title })}
        onClick={onComplete}
        className="group border-input hover:border-success hover:bg-success-soft flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors"
      >
        <Check
          className="text-success h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden
        />
      </button>
      <Icon
        className="text-muted-foreground h-4 w-4 shrink-0"
        role="img"
        aria-label={t(`kind.${task.kind}`)}
      />
      <div className="min-w-0 flex-1 @md:flex @md:items-baseline @md:gap-2">
        <p className="text-foreground truncate text-sm">
          {task.title}
          {repeat !== null && (
            <span className="text-warning ml-1.5 text-xs font-semibold tabular-nums">
              {t('repeat', { count: repeat })}
            </span>
          )}
        </p>
        {target && linkLabel && (
          <Link
            href={target.href}
            className="text-muted-foreground hover:text-primary block truncate text-xs hover:underline @md:shrink-0"
          >
            {linkLabel}
          </Link>
        )}
      </div>
      <DueText due={due} />
    </li>
  );
}

function DueText({ due }: { due: DueLabel }) {
  const t = useTranslations('Dashboard.home.tasks');
  const locale = useLocale();
  if (due.kind === 'none') return null;
  let text: string;
  if (due.kind === 'overdue') {
    text = t(`overdueBy.${due.unit}`, { count: due.amount });
  } else {
    const opts: Intl.DateTimeFormatOptions =
      due.kind === 'time'
        ? { hour: '2-digit', minute: '2-digit' }
        : due.kind === 'weekday'
          ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
          : { day: 'numeric', month: 'short' };
    text = new Intl.DateTimeFormat(locale, opts).format(due.ms);
  }
  return (
    <span
      className={cn(
        'shrink-0 text-xs tabular-nums',
        due.kind === 'overdue'
          ? 'text-destructive font-medium'
          : 'text-muted-foreground'
      )}
    >
      {text}
    </span>
  );
}
