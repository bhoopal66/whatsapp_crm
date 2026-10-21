'use client';

import {
  CheckCircle2,
  MessageSquarePlus,
  MessagesSquare,
  Users,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Skeleton } from '@/components/dashboard/skeleton';
import type { Glance } from '@/lib/team-activity/glance';
import type { TeamActivityLimits } from '@/lib/team-activity/limits';
import type { Finding } from '@/lib/team-activity/risk';
import { cn } from '@/lib/utils';

import { LevelIcon, TONE_TEXT, useFindingCopy } from './shared';

export interface AttentionItem {
  finding: Finding;
  /** The person's or number's name; null for the whole team. */
  who: string | null;
  /** The same person's or number's other problems today, less urgent. */
  also?: Finding[];
  onOpen?: () => void;
}

/** "Needs attention today": up to five cards, most urgent first. */
export function AttentionList({ items }: { items: AttentionItem[] }) {
  const t = useTranslations('TeamActivity.attention');
  const copy = useFindingCopy();
  return (
    <section className="space-y-3" aria-labelledby="ta-attention">
      <h2 id="ta-attention" className="text-foreground text-base font-semibold">
        {t('title')}
      </h2>
      {items.length === 0 ? (
        <div className="border-success/30 bg-success-soft text-success flex items-center gap-2 rounded-xl border px-4 py-3 text-sm">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
          {t('empty')}
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {items.map(({ finding: f, who, also = [], onOpen }) => {
            const { title, body } = copy(f);
            const act = f.level === 'act_now';
            return (
              <li
                key={f.id}
                className={cn(
                  'bg-card flex gap-3 rounded-xl border border-l-4 p-4',
                  act
                    ? 'border-destructive/30 border-l-destructive'
                    : 'border-warning/30 border-l-warning'
                )}
              >
                <LevelIcon level={f.level} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      'text-xs font-semibold tracking-wide uppercase',
                      act ? TONE_TEXT.bad : TONE_TEXT.warn
                    )}
                  >
                    {t(act ? 'actNow' : 'keepAnEye')}
                    {who ? ` · ${who}` : ''}
                  </p>
                  <p className="text-foreground mt-1 text-sm font-semibold">
                    {title}
                  </p>
                  <p className="text-muted-foreground mt-1 text-sm">{body}</p>
                  {also.length > 0 && (
                    <p className="text-muted-foreground mt-2 text-xs">
                      {t('also', {
                        items: also.map((x) => copy(x).title).join(' · '),
                      })}
                    </p>
                  )}
                  {onOpen && (
                    <button
                      type="button"
                      onClick={onOpen}
                      className="text-primary mt-2 text-sm font-medium hover:underline"
                    >
                      {t('seeDetails')}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  hint: string;
  tone?: string;
}) {
  return (
    <div className="border-border bg-card rounded-xl border p-4">
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        {label}
      </div>
      <p
        className={cn(
          'text-foreground mt-2 text-3xl font-bold tabular-nums',
          tone
        )}
      >
        {value}
      </p>
      <p className="text-muted-foreground mt-1 text-sm">{hint}</p>
    </div>
  );
}

/** "Today at a glance": three figures, each with its scale in words. */
export function GlanceTiles({
  glance,
  limits,
  periodLabel,
}: {
  glance: Glance;
  limits: TeamActivityLimits;
  periodLabel: string;
}) {
  const t = useTranslations('TeamActivity.glance');
  const { reply } = glance;
  return (
    <section className="space-y-3" aria-labelledby="ta-glance">
      <h2 id="ta-glance" className="text-foreground text-base font-semibold">
        {t('title')}
      </h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Tile
          icon={MessageSquarePlus}
          label={t('newChats')}
          value={glance.todayNew.toLocaleString()}
          hint={t('newChatsHint', {
            perPerson: limits.dailyNewChatsPerUser,
            perNumber: limits.dailyNewChatsPerNumber,
          })}
        />
        <Tile
          icon={MessagesSquare}
          label={t('replied', { period: periodLabel })}
          value={
            reply ? t('repliedValue', { n: reply.outOfTen }) : t('notEnough')
          }
          tone={reply ? TONE_TEXT[reply.tone] : 'text-muted-foreground text-xl'}
          hint={
            reply
              ? t('repliedHint', {
                  aim: reply.aimOutOfTen,
                  replied: reply.replied,
                  total: reply.total,
                })
              : t('notEnoughHint')
          }
        />
        <Tile
          icon={Users}
          label={t('waiting')}
          value={glance.waitingRecent.toLocaleString()}
          tone={glance.waitingRecent > 0 ? TONE_TEXT.warn : undefined}
          hint={
            glance.waitingUnassignedRecent > 0
              ? t('waitingHintUnassigned', {
                  count: glance.waitingUnassignedRecent,
                })
              : t('waitingHint')
          }
        />
      </div>
    </section>
  );
}

export function OverviewSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <Skeleton className="h-6 w-48" />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-44" />
        ))}
      </div>
    </div>
  );
}
