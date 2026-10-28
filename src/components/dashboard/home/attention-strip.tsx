'use client';

import Link from 'next/link';
import { useState, type ComponentType } from 'react';
import {
  Bot,
  BriefcaseBusiness,
  CircleCheck,
  ListTodo,
  MessageCircle,
  PhoneMissed,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAiAutoReplyLive } from '@/hooks/use-ai-auto-reply-live';
import { useAuth } from '@/hooks/use-auth';
import { UNREAD_ROW_COLUMNS } from '@/hooks/use-total-unread';
import {
  countInboxUnread,
  formatCount,
  overdueCases,
  tileState,
} from '@/lib/dashboard/home/attention';
import type { OpenCases } from '@/lib/dashboard/home/sources';
import { taskCounts } from '@/lib/dashboard/home/tasks';
import type { CampaignInboxFields } from '@/lib/inbox/campaign-inbox';
import { createClient } from '@/lib/supabase/client';
import type { Task } from '@/lib/tasks/types';
import { cn } from '@/lib/utils';
import { Skeleton } from '../skeleton';
import { useWidgetData, type WidgetData } from './use-widget-data';

export interface AttentionStripProps {
  refreshKey: number;
  /** The person's open tasks (the page's; the tasks panel shares it). Null: the role holds no tasks. */
  tasks: WidgetData<Task[]> | null;
  /** Open cases (the page's; the cases card shares it). Null: the role gets no cases. */
  cases: WidgetData<OpenCases> | null;
  /** Open missed-call tasks assigned to this person; null without a phone system. */
  missedCalls: number | null;
  className?: string;
}

type UnreadRow = CampaignInboxFields & { unread_count: number | null };

interface ChatCounts {
  unreadRows: UnreadRow[];
  handoffs: number;
  drafts: number;
}

/** The strip's own reads: unread chats and AI hand-offs, all scoped by RLS. */
async function loadChatCounts(): Promise<ChatCounts> {
  const supabase = createClient();
  const [unread, handoffs, drafts] = await Promise.all([
    supabase
      .from('conversations')
      .select(UNREAD_ROW_COLUMNS)
      .gt('unread_count', 0),
    supabase
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .not('ai_attention_at', 'is', null),
    supabase
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .not('ai_pending_draft', 'is', null),
  ]);
  if (unread.error) throw unread.error;
  if (handoffs.error) throw handoffs.error;
  if (drafts.error) throw drafts.error;
  return {
    unreadRows: (unread.data ?? []) as unknown as UnreadRow[],
    handoffs: handoffs.count ?? 0,
    drafts: drafts.count ?? 0,
  };
}

type Tone = 'destructive' | 'warning' | 'info';

const ALERT_TONE: Record<Tone, { tile: string; icon: string; value: string }> =
  {
    destructive: {
      tile: 'border-destructive/30',
      icon: 'bg-destructive-soft text-destructive',
      value: 'text-destructive',
    },
    warning: {
      tile: 'border-warning/30',
      icon: 'bg-warning-soft text-warning',
      value: 'text-warning',
    },
    info: {
      tile: 'border-info/30',
      icon: 'bg-info-soft text-info',
      value: 'text-info',
    },
  };

interface TileProps {
  href: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  tone: Tone;
  count: number | null;
  /** The figure as shown, e.g. "12+"; defaults to the count. */
  display?: string;
  error: boolean;
  /** One line under the label while there is something to do. */
  hint?: string;
}

/**
 * "Needs your attention": one compact tile per thing waiting on this
 * person. Each tile links to where it is dealt with; a calm zero says
 * "All clear". A null prop leaves its tile out for this role.
 */
export function AttentionStrip({
  refreshKey,
  tasks,
  cases,
  missedCalls,
  className,
}: AttentionStripProps) {
  const t = useTranslations('Dashboard.home.attention');
  const { accountId } = useAuth();
  const aiLive = useAiAutoReplyLive() === true;
  const chats = useWidgetData(
    accountId ? `attention-chats:${accountId}:${refreshKey}` : null,
    loadChatCounts
  );
  // "Now" for the overdue split, taken once per refresh.
  const [clock, setClock] = useState({ refreshKey, now: new Date() });
  if (clock.refreshKey !== refreshKey)
    setClock({ refreshKey, now: new Date() });

  const chatError = chats.error && !chats.data;
  const unread = chats.data
    ? countInboxUnread(chats.data.unreadRows, aiLive)
    : null;
  const taskFigures = tasks?.data ? taskCounts(tasks.data, clock.now) : null;
  const caseFigures = cases?.data ? overdueCases(cases.data.rows) : null;

  const tiles: (TileProps & { key: string })[] = [
    {
      key: 'unread',
      href: '/inbox',
      icon: MessageCircle,
      label: t('unread.label'),
      tone: 'info',
      count: unread,
      error: chatError,
      hint: t('unread.hint'),
    },
    {
      key: 'handoffs',
      href: '/inbox',
      icon: Bot,
      label: t('handoffs.label'),
      tone: 'warning',
      count: chats.data?.handoffs ?? null,
      error: chatError,
      hint:
        chats.data && chats.data.drafts > 0
          ? t('handoffs.drafts', { count: chats.data.drafts })
          : t('handoffs.hint'),
    },
  ];
  if (tasks) {
    tiles.push({
      key: 'tasks',
      href: '#my-tasks',
      icon: ListTodo,
      label: t('overdueTasks.label'),
      tone: 'destructive',
      count: taskFigures?.overdue ?? null,
      error: tasks.error && !tasks.data,
      hint: t('overdueTasks.hint', { count: taskFigures?.today ?? 0 }),
    });
  }
  if (missedCalls !== null) {
    tiles.push({
      key: 'calls',
      href: '/calls',
      icon: PhoneMissed,
      label: t('missedCalls.label'),
      tone: 'warning',
      count: missedCalls,
      error: false,
      hint: t('missedCalls.hint'),
    });
  }
  if (cases) {
    tiles.push({
      key: 'cases',
      href: '/cases?sla_state=overdue',
      icon: BriefcaseBusiness,
      label: t('overdueCases.label'),
      tone: 'destructive',
      count: caseFigures?.overdue ?? null,
      display: caseFigures
        ? formatCount(caseFigures.overdue, cases.data?.truncated)
        : undefined,
      error: cases.error && !cases.data,
      hint: t('overdueCases.hint', { count: caseFigures?.waiting ?? 0 }),
    });
  }

  return (
    <section
      aria-label={t('title')}
      className={cn(
        'grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5',
        className
      )}
    >
      {tiles.map(({ key, ...tile }) => (
        <Tile key={key} {...tile} />
      ))}
    </section>
  );
}

function Tile({
  href,
  icon: Icon,
  label,
  tone,
  count,
  display,
  error,
  hint,
}: TileProps) {
  const t = useTranslations('Dashboard.home.attention');
  const state = tileState(count, error);
  const alert = state === 'alert' ? ALERT_TONE[tone] : null;
  const StateIcon = state === 'clear' ? CircleCheck : Icon;
  return (
    <Link
      href={href}
      className={cn(
        'border-border bg-card hover:bg-card-2 flex min-w-0 flex-col gap-2 rounded-xl border p-3.5 shadow-xs transition-colors dark:shadow-none',
        alert?.tile
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
            alert?.icon ??
              (state === 'clear'
                ? 'bg-success-soft text-success'
                : 'bg-card-2 text-muted-foreground')
          )}
        >
          <StateIcon className="h-4 w-4" aria-hidden />
        </span>
        {state === 'loading' ? (
          <Skeleton className="h-7 w-10" />
        ) : (
          <span
            className={cn(
              'text-2xl leading-none font-bold tabular-nums',
              alert?.value ?? 'text-muted-foreground'
            )}
          >
            {state === 'error' ? '–' : (display ?? count)}
          </span>
        )}
      </div>
      <div className="min-w-0">
        <p className="text-foreground truncate text-sm font-medium">{label}</p>
        <p className="text-muted-foreground truncate text-xs">
          {state === 'clear'
            ? t('allClear')
            : state === 'error'
              ? t('unavailable')
              : hint}
        </p>
      </div>
    </Link>
  );
}
