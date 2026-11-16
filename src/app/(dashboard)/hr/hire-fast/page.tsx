'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { RefreshCw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAuth } from '@/hooks/use-auth';
import { hrMyRoles } from '@/lib/hr/api';
import {
  filterCandidates,
  hireFastViews,
  overdueConversationIds,
  reasonLabelKey,
  stalledAfterHours,
  waitingLabel,
  type HireFastRow,
  type HireFastView,
} from '@/lib/hr/hirefast';
import { HR_STAGES, type HrRule, type HrStage } from '@/lib/hr/types';
import { createClient } from '@/lib/supabase/client';

const SELECT =
  'conversation_id, inbox, stage_key, urgent, upset, reply_state, last_inbound_at, last_outbound_at, closed_at, created_at, chat:conversations(assigned_agent_id, contact:contacts(name, phone))';

interface Loaded {
  rows: HireFastRow[];
  overdue: Set<string>;
  stalledAfter: number | null;
  now: number;
}

/**
 * Hire fast: open Recruitment candidates ranked by who needs action
 * next (`lib/hr/hirefast.ts`). Read only. Everything is read through the
 * user's RLS client, so only chats they can already see are ranked; no
 * caching (conversations never go in `client-cache.ts`).
 */
export default function HrHireFastPage() {
  const t = useTranslations('Hr.hireFast');
  const tStage = useTranslations('Hr.stage');
  const tReply = useTranslations('Hr.replyState');
  const { user, accountId } = useAuth();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<HrStage | null>(null);
  const [mine, setMine] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let live = true;
    void hrMyRoles(createClient()).then((res) => {
      if (!live) return;
      setAllowed(
        'data' in res && (res.data.admin || res.data.recruiter !== null)
      );
    });
    return () => {
      live = false;
    };
  }, [accountId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sb = createClient();
      const now = Date.now();
      const [convs, tasks, rules] = await Promise.all([
        sb
          .from('hr_conversations')
          .select(SELECT)
          .eq('inbox', 'recruiter')
          .is('closed_at', null)
          .limit(500),
        sb
          .from('tasks')
          .select('status, due_at, source_ref')
          .eq('status', 'open')
          .like('source_ref', 'hr:%')
          .lt('due_at', new Date(now).toISOString())
          .limit(1000),
        sb
          .from('hr_workflow_rules')
          .select('key, enabled, after_hours')
          .eq('key', 'no_activity_recruiter'),
      ]);
      if (convs.error || tasks.error || rules.error) throw new Error('load');
      setData({
        rows: (convs.data ?? []) as unknown as HireFastRow[],
        overdue: overdueConversationIds(tasks.data ?? [], now),
        stalledAfter: stalledAfterHours(
          (rules.data ?? []) as Pick<
            HrRule,
            'key' | 'enabled' | 'after_hours'
          >[]
        ),
        now,
      });
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  const views = useMemo(() => {
    if (!data) return null;
    const rows = filterCandidates(data.rows, {
      stage,
      mine,
      viewerId: user?.id ?? null,
    });
    return hireFastViews(rows, data.now, data.overdue, data.stalledAfter);
  }, [data, stage, mine, user?.id]);

  const stageLabel = (key: HrStage | null) => (key ? tStage(key) : '');
  const waiting = (v: HireFastView) => {
    const w = waitingLabel(v.waitingHours);
    return w ? t(w.key, { n: w.n }) : '';
  };
  const reasons = (v: HireFastView) => (
    <div className="flex flex-wrap gap-1">
      {v.reasons.map((r) => (
        <Badge
          key={r}
          variant={
            r === 'urgent' || r === 'upset' ? 'destructive' : 'secondary'
          }
        >
          {t(reasonLabelKey(r))}
        </Badge>
      ))}
    </div>
  );
  const status = (v: HireFastView) => (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span>{tReply(v.replyState)}</span>
      {v.urgent && <Badge variant="destructive">{t('urgent')}</Badge>}
    </span>
  );
  const candidate = (v: HireFastView) => (
    <Link href={v.href} className="text-primary font-medium hover:underline">
      {v.name ?? t('contact')}
    </Link>
  );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      {allowed === false ? (
        <p className="text-muted-foreground text-sm">{t('noAccess')}</p>
      ) : allowed === null ? (
        <div className="bg-card-2 h-24 animate-pulse rounded-lg" />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-2 text-sm">
              {t('stage')}
              <select
                value={stage ?? ''}
                onChange={(e) =>
                  setStage(
                    e.target.value === '' ? null : (e.target.value as HrStage)
                  )
                }
                className="border-input bg-card dark:bg-input/30 h-8 rounded-md border px-2 text-sm"
              >
                <option value="">{t('anyStage')}</option>
                {HR_STAGES.map((k) => (
                  <option key={k} value={k}>
                    {tStage(k)}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              <Checkbox
                checked={mine}
                onCheckedChange={(v) => setMine(v === true)}
              />
              {t('mine')}
            </label>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw className="size-4" />
              {t('refresh')}
            </Button>
          </div>

          <div className="border-border bg-card rounded-lg border">
            {failed ? (
              <p className="text-destructive p-4 text-sm">{t('loadFailed')}</p>
            ) : views === null ? (
              <div className="bg-card-2 h-24 animate-pulse" />
            ) : views.length === 0 ? (
              <p className="text-muted-foreground p-6 text-center text-sm">
                {t('empty')}
              </p>
            ) : (
              <>
                <ol className="divide-border divide-y sm:hidden">
                  {views.map((v, i) => (
                    <li key={v.conversationId} className="space-y-1.5 p-3">
                      <div className="flex items-baseline gap-2">
                        <span className="text-muted-foreground text-sm tabular-nums">
                          {i + 1}
                        </span>
                        {candidate(v)}
                        <span className="ml-auto text-sm font-semibold tabular-nums">
                          {v.score}
                        </span>
                      </div>
                      <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
                        {v.stageKey && <span>{stageLabel(v.stageKey)}</span>}
                        {status(v)}
                        {waiting(v) && <span>{waiting(v)}</span>}
                      </div>
                      {reasons(v)}
                    </li>
                  ))}
                </ol>
                <Table className="hidden sm:table">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">{t('rank')}</TableHead>
                      <TableHead>{t('candidate')}</TableHead>
                      <TableHead>{t('stage')}</TableHead>
                      <TableHead>{t('status')}</TableHead>
                      <TableHead>{t('waiting')}</TableHead>
                      <TableHead className="text-right">{t('score')}</TableHead>
                      <TableHead>{t('why')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {views.map((v, i) => (
                      <TableRow key={v.conversationId}>
                        <TableCell className="text-muted-foreground tabular-nums">
                          {i + 1}
                        </TableCell>
                        <TableCell>{candidate(v)}</TableCell>
                        <TableCell>{stageLabel(v.stageKey)}</TableCell>
                        <TableCell>{status(v)}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {waiting(v)}
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {v.score}
                        </TableCell>
                        <TableCell>{reasons(v)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
