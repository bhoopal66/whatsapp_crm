'use client';

/**
 * The HR panel at the top of a chat's contact panel (migration 200,
 * HR_SPEC "UI"). Every write is an `hr_*` RPC that re-checks the caller
 * and the chat's visibility; `lib/hr/panel.ts` only decides what to
 * offer. Mount it keyed by the conversation id so a chat switch starts
 * from empty state; late answers are still dropped once unmounted.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import {
  hrClose,
  hrOpen,
  hrReopen,
  hrSetFlag,
  hrSetStage,
  hrSetTopic,
  type HrResult,
} from '@/lib/hr/api';
import { hasHrAccess } from '@/lib/hr/access';
import { loadHrRoles } from '@/lib/hr/roles-cache';
import { isHrTask } from '@/lib/hr/tasks-view';
import {
  furthestStage,
  hasReason,
  laterStage,
  openKinds,
  outcomeToSend,
  panelActions,
  showHrPanel,
  stepNeedsReason,
  stepperSteps,
  type StepState,
} from '@/lib/hr/panel';
import {
  HR_FLAGS,
  HR_OUTCOMES,
  HR_TOPICS,
  type HrConversation,
  type HrOpenKind,
  type HrOutcome,
  type HrReplyState,
  type HrRoles,
  type HrStage,
  type HrTopic,
} from '@/lib/hr/types';
import type { Task } from '@/lib/tasks/types';
import { cn } from '@/lib/utils';

export { hrRolesCacheKey } from '@/lib/hr/roles-cache';

const NATIVE_FIELD =
  'border-input bg-card dark:bg-input/30 h-7 w-full rounded-md border px-2 text-xs';

const REPLY_TONE: Record<HrReplyState, string> = {
  new: 'bg-info-soft text-info',
  reply_due: 'bg-warning-soft text-warning',
  waiting: 'bg-card-2 text-muted-foreground',
};

const STEP_TONE: Record<StepState['progress'], string> = {
  done: 'bg-success-soft text-success border-transparent',
  current: 'bg-primary text-primary-foreground border-transparent',
  todo: 'bg-card-2 text-muted-foreground border-input',
};

type ReasonAsk = { kind: 'back'; stage: HrStage } | { kind: 'reopen' };

interface HrPanelProps {
  conversationId: string;
  /** `conversations.inbox_department` (migration 192). */
  inboxDepartment: string | null | undefined;
}

export function HrPanel({ conversationId, inboxDepartment }: HrPanelProps) {
  const t = useTranslations('Hr');
  const { accountId, user } = useAuth();
  const userId = user?.id ?? null;

  const [roles, setRoles] = useState<HrRoles | null>(null);
  const [row, setRow] = useState<HrConversation | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [furthest, setFurthest] = useState<HrStage | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  const [doneBusy, setDoneBusy] = useState<Set<string>>(new Set());
  const [outcome, setOutcome] = useState<HrOutcome | ''>('');
  const [ask, setAsk] = useState<ReasonAsk | null>(null);
  const [reason, setReason] = useState('');

  // The id this panel answers for; any late response for another chat
  // (or after unmount) is dropped rather than painted over the open one.
  const currentRef = useRef<string | null>(conversationId);
  useEffect(() => {
    currentRef.current = conversationId;
    return () => {
      currentRef.current = null;
    };
  }, [conversationId]);
  const isCurrent = useCallback((id: string) => currentRef.current === id, []);

  // Roles: slow-moving reference data, cached per account and user.
  useEffect(() => {
    if (!accountId || !userId) return;
    let alive = true;
    loadHrRoles(accountId, userId)
      .then((r) => {
        if (alive) setRoles(r);
      })
      .catch(() => {
        // No roles (or no migration 200 yet): the panel stays hidden.
      });
    return () => {
      alive = false;
    };
  }, [accountId, userId]);

  const hasAccess = roles !== null && hasHrAccess(roles);

  const loadTasks = useCallback(
    async (id: string) => {
      try {
        const params = new URLSearchParams({
          scope: 'conversation',
          conversationId: id,
          status: 'open',
          hr: '1',
        });
        const res = await fetch(`/api/tasks?${params}`);
        if (!res.ok) return;
        const body = (await res.json()) as { tasks?: Task[] };
        if (isCurrent(id)) setTasks((body.tasks ?? []).filter(isHrTask));
      } catch {
        // The list is a convenience; the tasks screens hold the truth.
      }
    },
    [isCurrent]
  );

  // The row and the furthest stage ever reached.
  useEffect(() => {
    if (!hasAccess) return;
    const id = conversationId;
    const sb = createClient();
    void (async () => {
      const [rowRes, historyRes] = await Promise.all([
        sb
          .from('hr_conversations')
          .select('*')
          .eq('conversation_id', id)
          .maybeSingle(),
        sb
          .from('hr_stage_history')
          .select('to_stage')
          .eq('conversation_id', id),
      ]);
      if (!isCurrent(id)) return;
      const next = (rowRes.data as HrConversation | null) ?? null;
      setRow(next);
      setFurthest(
        laterStage(
          furthestStage(
            historyRes.data as { to_stage: string | null }[] | null
          ),
          next?.stage_key
        )
      );
      setLoaded(true);
      if (next) void loadTasks(id);
    })();
  }, [conversationId, hasAccess, isCurrent, loadTasks]);

  const rowRef = useRef<HrConversation | null>(null);
  useEffect(() => {
    rowRef.current = row;
  }, [row]);

  // The outcome pick belongs to the row it was made on.
  const rowInbox = row?.inbox;
  useEffect(() => {
    setOutcome('');
  }, [rowInbox]);

  // Live: another person's write (or a rule's flag) lands here too.
  const onChangeRef = useRef<(next: HrConversation | null) => void>(() => {});
  useEffect(() => {
    onChangeRef.current = (next) => {
      if (!isCurrent(conversationId)) return;
      const prev = rowRef.current;
      setRow(next);
      if (next) {
        setFurthest((f) => laterStage(f, next.stage_key));
        // Message stamps change only last_*_at; they open no tasks.
        if (
          !prev ||
          prev.stage_key !== next.stage_key ||
          prev.topic !== next.topic ||
          prev.inbox !== next.inbox ||
          prev.closed_at !== next.closed_at
        )
          void loadTasks(conversationId);
      }
    };
  });
  useEffect(() => {
    if (!hasAccess) return;
    const sb = createClient();
    const channel = sb
      .channel(`hr-panel:${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'hr_conversations',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          onChangeRef.current(
            payload.eventType === 'DELETE'
              ? null
              : (payload.new as HrConversation)
          );
        }
      )
      .subscribe();
    return () => {
      void sb.removeChannel(channel);
    };
  }, [conversationId, hasAccess]);

  const run = useCallback(
    async (write: () => Promise<HrResult<HrConversation>>) => {
      const id = conversationId;
      setBusy(true);
      let res: HrResult<HrConversation>;
      try {
        res = await write();
      } catch {
        if (isCurrent(id)) setBusy(false);
        toast.error(t('error.UNKNOWN'));
        return false;
      }
      if (!isCurrent(id)) return;
      setBusy(false);
      if ('error' in res) {
        toast.error(t(`error.${res.error}`));
        return false;
      }
      setRow(res.data);
      setFurthest((f) => laterStage(f, res.data.stage_key));
      // Rules open tasks on stage and topic changes.
      void loadTasks(id);
      return true;
    },
    [conversationId, isCurrent, loadTasks, t]
  );

  const sb = () => createClient();
  const open = (kind: HrOpenKind) =>
    run(() => hrOpen(sb(), conversationId, kind));
  const setStage = (stage: HrStage, why?: string) =>
    run(() => hrSetStage(sb(), conversationId, stage, why ?? null));
  const setTopic = (topic: HrTopic) =>
    run(() => hrSetTopic(sb(), conversationId, topic));

  const pickStage = (step: StepState) => {
    if (step.move === 'forward') void setStage(step.stage);
    else if (stepNeedsReason(step)) {
      setReason('');
      setAsk({ kind: 'back', stage: step.stage });
    }
  };

  const confirmReason = async () => {
    if (!ask || !hasReason(reason)) return;
    const ok =
      ask.kind === 'back'
        ? await setStage(ask.stage, reason.trim())
        : await run(() => hrReopen(sb(), conversationId, reason.trim()));
    if (ok) {
      setAsk(null);
      if (ask.kind === 'reopen') setOutcome('');
    }
  };

  const markDone = async (task: Task) => {
    const id = conversationId;
    if (doneBusy.has(task.id)) return;
    setDoneBusy((s) => new Set(s).add(task.id));
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      });
      if (!res.ok) throw new Error(String(res.status));
      if (isCurrent(id))
        setTasks((list) => list.filter((x) => x.id !== task.id));
    } catch {
      toast.error(t('panel.taskFailed'));
    } finally {
      setDoneBusy((s) => {
        const n = new Set(s);
        n.delete(task.id);
        return n;
      });
    }
  };

  if (!roles || !showHrPanel(roles, inboxDepartment, row !== null) || !loaded)
    return null;

  const header = (
    <div className="flex items-center justify-between gap-2">
      <h4 className="text-sm font-semibold">{t('panel.title')}</h4>
      {row && (
        <span className="text-muted-foreground text-xs">
          {t(`inbox.${row.inbox}`)}
        </span>
      )}
    </div>
  );

  if (!row) {
    const kinds = openKinds(roles);
    if (kinds.length === 0) return null;
    return (
      <section className="bg-wa-panel space-y-2 px-4 py-3">
        {header}
        <p className="text-muted-foreground text-xs">{t('panel.trackAs')}</p>
        <div className="flex flex-wrap gap-2">
          {kinds.map((kind) => (
            <Button
              key={kind}
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void open(kind)}
            >
              {t(
                kind === 'candidate'
                  ? 'panel.kindCandidate'
                  : 'panel.kindEmployee'
              )}
            </Button>
          ))}
        </div>
      </section>
    );
  }

  const actions = panelActions(row, roles);
  const steps = stepperSteps(row, roles, furthest);
  const closed = row.closed_at !== null;
  const stageLabel = (s: HrStage) => t(`stage.${s}`);

  return (
    <section className="bg-wa-panel space-y-3 px-4 py-3" aria-busy={busy}>
      {header}

      <div className="flex flex-wrap items-center gap-1.5">
        <span
          aria-label={t('panel.replyState')}
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-medium',
            REPLY_TONE[row.reply_state]
          )}
        >
          {t(`replyState.${row.reply_state}`)}
        </span>
        {HR_FLAGS.map((flag) => {
          const on = row[flag];
          const tone =
            flag === 'urgent'
              ? 'bg-destructive-soft text-destructive'
              : 'bg-warning-soft text-warning';
          return actions.edit ? (
            <Button
              key={flag}
              size="xs"
              variant="outline"
              aria-pressed={on}
              disabled={busy}
              className={cn(on && tone, on && 'border-transparent')}
              onClick={() =>
                void run(() => hrSetFlag(sb(), conversationId, flag, !on))
              }
            >
              {t(`flag.${flag}`)}
            </Button>
          ) : on ? (
            <span
              key={flag}
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-medium',
                tone
              )}
            >
              {t(`flag.${flag}`)}
            </span>
          ) : null;
        })}
        {!actions.edit && !closed && (
          <span className="text-muted-foreground text-[11px]">
            {t('panel.readOnly')}
          </span>
        )}
      </div>

      {actions.stepper && (
        <ol className="grid grid-cols-2 gap-1" aria-label={t('panel.stage')}>
          {steps.map((step) => {
            const clickable =
              step.move === 'forward' || step.move === 'backward';
            const label =
              step.progress === 'done'
                ? t('panel.stepDone', { stage: stageLabel(step.stage) })
                : step.progress === 'current'
                  ? t('panel.stepCurrent', { stage: stageLabel(step.stage) })
                  : stageLabel(step.stage);
            return (
              <li key={step.stage}>
                <button
                  type="button"
                  disabled={!clickable || busy}
                  aria-current={
                    step.progress === 'current' ? 'step' : undefined
                  }
                  aria-label={
                    clickable
                      ? t('panel.moveTo', { stage: stageLabel(step.stage) })
                      : label
                  }
                  title={step.move === 'locked' ? t('panel.lockedStep') : label}
                  onClick={() => pickStage(step)}
                  className={cn(
                    'flex w-full items-center gap-1 rounded-md border px-2 py-1 text-left text-[11px] leading-tight',
                    STEP_TONE[step.progress],
                    clickable &&
                      'hover:ring-ring/50 cursor-pointer hover:ring-2',
                    !clickable && 'cursor-default'
                  )}
                >
                  {step.progress === 'done' && (
                    <Check className="size-3 shrink-0" aria-hidden />
                  )}
                  <span className="truncate">{stageLabel(step.stage)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {actions.topic && (
        <label className="block space-y-1">
          <span className="text-muted-foreground text-xs">
            {t('panel.topic')}
          </span>
          {actions.edit ? (
            <select
              className={NATIVE_FIELD}
              value={row.topic ?? ''}
              disabled={busy}
              onChange={(e) => {
                if (e.target.value) void setTopic(e.target.value as HrTopic);
              }}
            >
              {row.topic === null && (
                <option value="" disabled>
                  {t('panel.noTopic')}
                </option>
              )}
              {HR_TOPICS.map((topic) => (
                <option key={topic} value={topic}>
                  {t(`topic.${topic}`)}
                </option>
              ))}
            </select>
          ) : (
            <span className="block text-xs">
              {row.topic ? t(`topic.${row.topic}`) : t('panel.noTopic')}
            </span>
          )}
        </label>
      )}

      {actions.moveToDept && (
        <label className="block space-y-1">
          <span className="text-muted-foreground text-xs">
            {t('panel.moveToDept')}
          </span>
          <select
            className={NATIVE_FIELD}
            value=""
            disabled={busy}
            onChange={(e) => {
              if (e.target.value) void setTopic(e.target.value as HrTopic);
            }}
          >
            <option value="" disabled>
              {t('panel.chooseTopic')}
            </option>
            {HR_TOPICS.map((topic) => (
              <option key={topic} value={topic}>
                {t(`topic.${topic}`)}
              </option>
            ))}
          </select>
        </label>
      )}

      {actions.moveToRecruitment && (
        <label className="block space-y-1">
          <span className="text-muted-foreground text-xs">
            {t('panel.moveToRecruitment')}
          </span>
          <select
            className={NATIVE_FIELD}
            value=""
            disabled={busy}
            onChange={(e) => {
              const step = steps.find((s) => s.stage === e.target.value);
              if (step) pickStage(step);
            }}
          >
            <option value="" disabled>
              {t('panel.chooseStage')}
            </option>
            {steps.map((step) => (
              <option
                key={step.stage}
                value={step.stage}
                disabled={step.move === 'locked' || step.move === 'none'}
              >
                {stageLabel(step.stage)}
              </option>
            ))}
          </select>
        </label>
      )}

      {actions.close && (
        <div className="flex items-end gap-2">
          {actions.close.needsOutcome && (
            <label className="min-w-0 flex-1 space-y-1">
              <span className="text-muted-foreground text-xs">
                {t('panel.outcome')}
              </span>
              <select
                className={NATIVE_FIELD}
                value={outcome}
                disabled={busy}
                onChange={(e) => setOutcome(e.target.value as HrOutcome | '')}
              >
                <option value="" disabled>
                  {t('panel.chooseOutcome')}
                </option>
                {HR_OUTCOMES.map((o) => (
                  <option key={o} value={o}>
                    {t(`outcome.${o}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || (actions.close.needsOutcome && outcome === '')}
            onClick={() =>
              void (async () => {
                const ok = await run(() =>
                  hrClose(sb(), conversationId, outcomeToSend(row, outcome))
                );
                if (ok) setOutcome('');
              })()
            }
          >
            {t('panel.close')}
          </Button>
        </div>
      )}

      {closed && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">
            {row.outcome
              ? t('panel.closedWith', { outcome: t(`outcome.${row.outcome}`) })
              : t('panel.closed')}
          </span>
          {actions.reopen && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setReason('');
                setAsk({ kind: 'reopen' });
              }}
            >
              {t('panel.reopen')}
            </Button>
          )}
        </div>
      )}

      <div className="space-y-1">
        <h5 className="text-muted-foreground text-xs font-medium">
          {t('panel.tasks')}
        </h5>
        {tasks.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t('panel.noTasks')}</p>
        ) : (
          <ul className="space-y-1">
            {tasks.map((task) => (
              <li
                key={task.id}
                className="bg-card-2 flex items-center gap-2 rounded-md px-2 py-1"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs">{task.title}</p>
                  <p className="text-muted-foreground text-[11px]">
                    {task.due_at
                      ? t('panel.due', {
                          when: formatDistanceToNow(new Date(task.due_at), {
                            addSuffix: true,
                          }),
                        })
                      : t('panel.noDue')}
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={t('panel.markDone', { title: task.title })}
                  disabled={doneBusy.has(task.id)}
                  onClick={() => void markDone(task)}
                >
                  {t('panel.taskDone')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog open={ask !== null} onOpenChange={(o) => !o && setAsk(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {ask?.kind === 'back'
                ? t('panel.backTitle', { stage: stageLabel(ask.stage) })
                : t('panel.reopenTitle')}
            </DialogTitle>
            <DialogDescription>{t('panel.reasonHint')}</DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label={t('panel.reason')}
            placeholder={t('panel.reason')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsk(null)}>
              {t('panel.cancel')}
            </Button>
            <Button
              disabled={busy || !hasReason(reason)}
              onClick={() => void confirmReason()}
            >
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              {t('panel.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
