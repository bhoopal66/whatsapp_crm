'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  Archive,
  ArrowRightLeft,
  Circle,
  FileText,
  Landmark,
  ListChecks,
  ListPlus,
  Loader2,
  MessageSquare,
  Phone,
  StickyNote,
  Timer,
  UserX,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { CaseTabProps } from '@/lib/cases/case-page';
import {
  formatDuration,
  groupTimelineByDay,
  parseCallSummary,
  parseTimeline,
  timelineIcon,
  type TimelineEntry,
  type TimelineIconName,
} from '@/lib/cases/case-tabs';

const ICONS: Record<TimelineIconName, LucideIcon> = {
  ArrowRightLeft,
  ListPlus,
  ListChecks,
  StickyNote,
  FileText,
  Timer,
  Landmark,
  Users,
  UserX,
  Archive,
  MessageSquare,
  Phone,
  Circle,
};

type State = 'loading' | 'ok' | 'error';

/**
 * Timeline: every source of the case by day, newest first. WhatsApp
 * messages are opt-in, because reading them is audited for supervisors.
 */
export function TimelineTab({ caseId }: CaseTabProps) {
  const t = useTranslations('CasePage');
  const locale = useLocale();
  const { nameOf } = useWorkspaceMembers();
  const [withMessages, setWithMessages] = useState(false);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [state, setState] = useState<State>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    (async () => {
      setState('loading');
      try {
        const res = await fetch(
          `/api/cases/${caseId}/timeline${withMessages ? '?messages=1' : ''}`,
          { cache: 'no-store' }
        );
        const json: unknown = res.ok
          ? await res.json().catch(() => null)
          : null;
        if (!current) return;
        if (!res.ok) {
          setState('error');
          return;
        }
        setEntries(parseTimeline(json).reverse());
        setState('ok');
      } catch {
        if (current) setState('error');
      }
    })();
    return () => {
      current = false;
    };
  }, [caseId, withMessages, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const dayLabel = (day: string) =>
    day
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: 'full',
          timeZone: 'UTC',
        }).format(new Date(`${day}T00:00:00Z`))
      : '—';
  const timeLabel = (iso: string) =>
    new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(
      new Date(iso)
    );
  const who = (id: string | null) =>
    id ? (nameOf(id) ?? t('unknownPerson')) : t('system');
  const kindLabel = (kind: string) =>
    t.has(`timeline.kinds.${kind}`) ? t(`timeline.kinds.${kind}`) : kind;

  const summaryOf = (e: TimelineEntry) => {
    if (e.kind !== 'call') return e.summary;
    const call = parseCallSummary(e.summary);
    if (!call) return e.summary;
    const direction = t.has(`timeline.callDirection.${call.direction}`)
      ? t(`timeline.callDirection.${call.direction}`)
      : call.direction;
    const status = t.has(`timeline.callStatus.${call.status}`)
      ? t(`timeline.callStatus.${call.status}`)
      : call.status;
    return call.seconds
      ? t('timeline.callLineTalk', {
          direction,
          status,
          duration: formatDuration(call.seconds),
        })
      : t('timeline.callLine', { direction, status });
  };

  return (
    <div className="space-y-3">
      <div className="bg-card flex flex-col gap-1 rounded-lg border p-3">
        <div className="flex items-center gap-3">
          <Switch
            id="case-timeline-messages"
            checked={withMessages}
            disabled={state === 'loading'}
            onCheckedChange={(v) => setWithMessages(!!v)}
          />
          <Label htmlFor="case-timeline-messages">
            {t('timeline.includeMessages')}
          </Label>
        </div>
        <p className="text-muted-foreground text-xs">
          {t('timeline.messagesNote')}
        </p>
      </div>

      {state === 'loading' ? (
        <p className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t('tabLoading')}
        </p>
      ) : state === 'error' ? (
        <div className="flex flex-col items-center gap-2 py-8 text-sm">
          <p className="text-destructive">{t('timeline.loadFailed')}</p>
          <Button variant="outline" onClick={retry}>
            {t('retry')}
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center text-sm">
          {t('timeline.empty')}
        </p>
      ) : (
        groupTimelineByDay(entries).map((d) => (
          <section key={d.day || 'unknown'} className="space-y-2">
            <h2 className="text-muted-foreground text-xs font-semibold">
              {dayLabel(d.day)}
            </h2>
            <ol className="ml-2.5 space-y-3 border-l pl-5">
              {d.entries.map((e, i) => {
                const Icon = ICONS[timelineIcon(e.kind)];
                const summary = summaryOf(e);
                return (
                  <li
                    key={`${e.kind}-${e.refId}-${i}`}
                    className="relative flex min-w-0 flex-col gap-0.5 text-sm"
                  >
                    <span className="bg-background text-muted-foreground absolute top-0 -left-[1.95rem] flex size-5 items-center justify-center rounded-full border">
                      <Icon className="size-3" aria-hidden />
                    </span>
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">{kindLabel(e.kind)}</span>
                      <span className="text-muted-foreground text-xs">
                        {timeLabel(e.at)} · {who(e.actor)}
                      </span>
                    </span>
                    {summary && (
                      <span className="break-words whitespace-pre-wrap">
                        {summary}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        ))
      )}
    </div>
  );
}
