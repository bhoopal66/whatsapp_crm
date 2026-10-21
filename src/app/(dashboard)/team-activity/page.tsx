'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Info, Loader2, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import {
  DailyChart,
  HourlyChart,
} from '@/components/team-activity/activity-charts';
import { LimitsDialog } from '@/components/team-activity/limits-dialog';
import { NumbersPanel } from '@/components/team-activity/numbers-panel';
import {
  AttentionList,
  GlanceTiles,
  OverviewSkeleton,
  type AttentionItem,
} from '@/components/team-activity/overview';
import {
  AutomaticSenders,
  PeopleGrid,
} from '@/components/team-activity/people-grid';
import { PersonSheet } from '@/components/team-activity/person-sheet';
import { useSenderName } from '@/components/team-activity/shared';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCan } from '@/hooks/use-can';
import { hourLabel } from '@/lib/team-activity/format';
import { glanceOf } from '@/lib/team-activity/glance';
import {
  TEAM_ACTIVITY_DEFAULTS,
  WARM_UP_DAILY_LIMIT,
  type TeamActivityLimits,
} from '@/lib/team-activity/limits';
import type { RangePreset } from '@/lib/team-activity/range';
import {
  isListedSender,
  numberDisplayName,
  type TeamActivityReport,
} from '@/lib/team-activity/report';
import { assessReport, type PersonAssessment } from '@/lib/team-activity/risk';
import type { SafetyEntry } from '@/lib/team-activity/safety';
import { cn } from '@/lib/utils';

interface Loaded {
  report: TeamActivityReport;
  range: { preset: RangePreset; from: string; to: string };
}

const ALL = 'all';
/** The periods offered, in plain words. */
const PERIODS = [
  'today',
  '7d',
  '30d',
] as const satisfies readonly RangePreset[];

function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export default function TeamActivityPage() {
  const t = useTranslations('TeamActivity.page');
  const th = useTranslations('TeamActivity.how');
  // The limits and the Safety Meter stay admin-only (their routes
  // refuse anyone else); a team leader reads the page.
  const admin = useCan('edit-settings');
  const senderName = useSenderName();

  const [preset, setPreset] = useState<RangePreset>('7d');
  const [channel, setChannel] = useState<string>(ALL);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [safety, setSafety] = useState<Record<string, SafetyEntry>>({});
  const [safetyLoading, setSafetyLoading] = useState(true);
  const [recalculating, setRecalculating] = useState<string | null>(null);

  const [openPerson, setOpenPerson] = useState<PersonAssessment | null>(null);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [limitsKey, setLimitsKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ range: preset, tz: viewerZone() });
    if (channel !== ALL) params.set('channel', channel);
    void fetch(`/api/team-activity?${params}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          (Loaded & { error?: string }) | null;
        if (cancelled) return;
        if (!res.ok || !body?.report) {
          setError(t('loadFailed'));
          return;
        }
        setError(null);
        setLoaded({ report: body.report, range: body.range });
      })
      .catch(() => {
        if (!cancelled) setError(t('loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [preset, channel, reloadKey, t]);

  // The Safety Meter, once per visit (the server caches it). Admins only.
  useEffect(() => {
    if (!admin) return;
    let cancelled = false;
    void fetch('/api/team-activity/safety')
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as {
          numbers?: SafetyEntry[];
        } | null;
        if (cancelled || !res.ok || !body?.numbers) return;
        setSafety(
          Object.fromEntries(body.numbers.map((n) => [n.channelId, n]))
        );
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setSafetyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [admin]);

  const reload = useCallback(() => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }, []);

  const recalculate = useCallback(
    async (channelId: string) => {
      setRecalculating(channelId);
      try {
        const res = await fetch('/api/team-activity/safety', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelId }),
        });
        const body = (await res.json().catch(() => null)) as {
          number?: SafetyEntry;
        } | null;
        if (!res.ok || !body?.number) {
          toast.error(t('meterFailed'));
          return;
        }
        setSafety((prev) => ({ ...prev, [channelId]: body.number! }));
        if (body.number.error) toast.error(t('meterFailed'));
      } catch {
        toast.error(t('meterFailed'));
      } finally {
        setRecalculating(null);
      }
    },
    [t]
  );

  const report = loaded?.report ?? null;
  const team = report?.scope === 'team';

  const assessment = useMemo(
    () =>
      report
        ? assessReport(report, {
            viewer: admin ? 'owner' : 'leader',
            safety: admin ? (id) => safety[id]?.rating ?? null : undefined,
          })
        : null,
    [report, admin, safety]
  );

  const attention: AttentionItem[] = useMemo(() => {
    if (!report || !assessment) return [];
    const r = report;
    const a = assessment;
    return a.today.map((f) => ({
      ...attentionFor(f),
      also: a.todayMore[f.id] ?? [],
    }));
    function attentionFor(f: (typeof a.today)[number]) {
      const s = f.subject;
      if (s.type === 'person') {
        const p = a.people.find(
          (x) => x.sender.userId === s.userId && x.sender.kind === s.senderKind
        );
        const sender =
          p?.sender ??
          r.senders.find(
            (x) => x.userId === s.userId && x.kind === s.senderKind
          );
        return {
          finding: f,
          who: sender ? senderName(sender) : null,
          onOpen: p ? () => setOpenPerson(p) : undefined,
        };
      }
      if (s.type === 'number') {
        const n = r.numbers.find((x) => x.channelId === s.channelId);
        return { finding: f, who: n ? numberDisplayName(n) : null };
      }
      return { finding: f, who: null };
    }
  }, [report, assessment, senderName]);

  const automatic = useMemo(
    () =>
      report && admin && !team
        ? report.senders.filter((s) => s.kind !== 'person' && isListedSender(s))
        : [],
    [report, admin, team]
  );

  const channelItems = useMemo(() => {
    const items: Record<string, string> = { [ALL]: t('allNumbers') };
    for (const n of report?.numbers ?? []) {
      if (n.channelId) items[n.channelId] = numberDisplayName(n) ?? n.channelId;
    }
    return items;
  }, [report, t]);

  const onLimitsSaved = useCallback(
    (limits: TeamActivityLimits) => {
      setLoaded((prev) =>
        prev
          ? { ...prev, report: { ...prev.report, limits, limitsSaved: true } }
          : prev
      );
      reload();
    },
    [reload]
  );

  const openLimits = () => {
    setLimitsKey((k) => k + 1);
    setLimitsOpen(true);
  };

  const title =
    team && report.teamNames.length > 0
      ? t('titleTeam', { teams: report.teamNames.join(', ') })
      : t('title');
  const limits = report?.limits ?? TEAM_ACTIVITY_DEFAULTS;
  const quietOff = limits.quietHoursStart === limits.quietHoursEnd;

  return (
    <div className="min-w-0 space-y-8">
      {/* 1. Header */}
      <div className="flex flex-col gap-4 2xl:flex-row 2xl:items-end 2xl:justify-between">
        <div className="min-w-0">
          <h1 className="text-foreground text-2xl font-bold break-words">
            {title}
          </h1>
          <p className="text-muted-foreground mt-1 max-w-[65ch] text-sm">
            {t('description')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="bg-muted/60 flex items-center gap-1 rounded-lg p-1"
            role="group"
            aria-label={t('period')}
          >
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={preset === p}
                onClick={() => {
                  setLoading(true);
                  setPreset(p);
                }}
                className={cn(
                  'rounded-md px-2.5 py-1 text-sm font-medium whitespace-nowrap transition-colors',
                  preset === p
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t(`periods.${p}`)}
              </button>
            ))}
          </div>
          <Select
            value={channel}
            onValueChange={(v) => {
              setLoading(true);
              setChannel(String(v ?? ALL));
            }}
            items={channelItems}
          >
            <SelectTrigger
              className="w-full max-w-56 sm:w-48"
              aria-label={t('numberFilter')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(channelItems).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={reload}
            disabled={loading}
            aria-label={t('refresh')}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
          {admin && (
            <Button
              type="button"
              variant="outline"
              onClick={openLimits}
              disabled={!report}
            >
              <SlidersHorizontal className="h-4 w-4" />
              {t('limits')}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="border-destructive/30 bg-destructive-soft text-destructive flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm">
          <span>{error}</span>
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            {t('retry')}
          </Button>
        </div>
      )}

      {admin && report && !report.limitsSaved && (
        <div className="border-border bg-card flex items-start gap-3 rounded-xl border px-4 py-3 text-sm">
          <Info className="text-primary mt-0.5 h-4 w-4 shrink-0" />
          <p className="text-muted-foreground">
            {t('defaultsNotice')}{' '}
            <button
              type="button"
              className="text-primary font-medium hover:underline"
              onClick={openLimits}
            >
              {t('reviewLimits')}
            </button>
          </p>
        </div>
      )}

      {!report || !assessment ? (
        loading && <OverviewSkeleton />
      ) : (
        <div
          className={cn(
            'space-y-8 transition-opacity',
            loading && 'opacity-60'
          )}
        >
          {/* 2. */}
          <AttentionList items={attention} />

          {/* 3. */}
          <GlanceTiles
            glance={glanceOf(report)}
            limits={report.limits}
            periodLabel={t(
              `periodsInline.${preset as (typeof PERIODS)[number]}`
            )}
          />

          {/* 4. */}
          <PeopleGrid
            people={assessment.people}
            title={t(team ? 'peopleTeam' : 'people')}
            onOpen={setOpenPerson}
          />
          <AutomaticSenders senders={automatic} findings={assessment.owner} />

          {/* 5. */}
          <NumbersPanel
            numbers={assessment.numbers}
            report={report}
            admin={admin}
            safety={safety}
            safetyLoading={safetyLoading}
            recalculating={recalculating}
            onRecalculate={(id) => void recalculate(id)}
          />

          {/* 6. */}
          <Accordion className="border-border bg-card rounded-xl border px-4">
            <AccordionItem value="charts">
              <AccordionTrigger className="text-base">
                {t('chartsTitle')}
              </AccordionTrigger>
              <AccordionContent>
                <div className="grid grid-cols-1 gap-4 pt-2 xl:grid-cols-2">
                  <DailyChart daily={report.daily} />
                  <HourlyChart hourly={report.hourly} limits={report.limits} />
                </div>
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="how">
              <AccordionTrigger className="text-base">
                {th('title')}
              </AccordionTrigger>
              <AccordionContent>
                <ul className="text-muted-foreground list-disc space-y-1.5 pl-5 text-sm">
                  <li>{th('newChat')}</li>
                  <li>{th('replied')}</li>
                  <li>
                    {th('tenMinutes', { max: limits.maxUnansweredInRow })}
                  </li>
                  <li>
                    {th('limits', {
                      perPerson: limits.dailyNewChatsPerUser,
                      perNumber: limits.dailyNewChatsPerNumber,
                      warm: WARM_UP_DAILY_LIMIT,
                    })}
                  </li>
                  <li>{th('official')}</li>
                  <li>
                    {quietOff
                      ? th('hoursOff')
                      : th('hours', {
                          from: hourLabel(limits.quietHoursEnd),
                          to: hourLabel(limits.quietHoursStart),
                        })}
                  </li>
                  <li>{th('timezone', { timezone: report.tz })}</li>
                  <li>{th('phone')}</li>
                </ul>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      )}

      {/* 7. */}
      {admin && report && (
        <LimitsDialog
          key={limitsKey}
          open={limitsOpen}
          onOpenChange={setLimitsOpen}
          limits={report.limits}
          saved={report.limitsSaved}
          onSaved={onLimitsSaved}
        />
      )}

      <PersonSheet
        row={openPerson}
        name={openPerson ? senderName(openPerson.sender) : ''}
        open={openPerson !== null}
        onOpenChange={(o) => {
          if (!o) setOpenPerson(null);
        }}
        range={loaded ? { from: loaded.range.from, to: loaded.range.to } : null}
        channelId={channel === ALL ? null : channel}
        limits={limits}
      />
    </div>
  );
}
