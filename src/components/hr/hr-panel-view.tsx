'use client';

/**
 * The HR panel's render, laid out as the HR package's "Conversation"
 * pane: the contact, then labelled fieldsets of outlined segmented
 * buttons. Plain props only, so it renders on the server in tests; the
 * data, the writes and the reason dialog live in `hr-panel.tsx`, and
 * `lib/hr/panel.ts` decides which sections and buttons this viewer gets.
 */
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { Check, Circle, Contrast } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { hrTopicOptGroups } from '@/lib/hr/topic-ui';
import {
  closeChoices,
  paneKind,
  paneMoveHintKey,
  paneSections,
  type CloseChoice,
  type PaneSection,
  type PanelActions,
  type StepState,
} from '@/lib/hr/panel';
import {
  HR_FLAGS,
  type HrConversation,
  type HrFlag,
  type HrOpenKind,
  type HrReplyState,
  type HrStage,
  type HrTopic,
} from '@/lib/hr/types';
import type { Task } from '@/lib/tasks/types';
import { cn } from '@/lib/utils';

const NATIVE_FIELD =
  'border-input bg-card dark:bg-input/30 h-7 min-w-0 flex-1 rounded-md border px-2 text-xs';

/** One outlined segment; `on` is the highlighted (current/pressed) one. */
const SEGMENT =
  'border-input inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs leading-tight transition-colors disabled:cursor-default enabled:hover:bg-card-2';
const SEGMENT_ON = 'border-primary text-primary';

const FLAG_ON: Record<HrFlag, string> = {
  urgent: 'border-destructive bg-destructive-soft text-destructive',
  upset: 'border-warning bg-warning-soft text-warning',
};

const REPLY_TONE: Record<HrReplyState, string> = {
  new: 'text-info',
  reply_due: 'text-warning',
  waiting: 'text-muted-foreground',
};

export interface HrPanelViewProps {
  contactName: string;
  busy: boolean;
  /** The chat's HR row; null = not sorted yet. */
  row: HrConversation | null;
  /** Not sorted: the kinds this viewer may track it as. */
  kinds: HrOpenKind[];
  /** Tracked: what this viewer may do (`panelActions`). */
  actions: PanelActions | null;
  /** Tracked: the four stage steps (`stepperSteps`). */
  steps: StepState[];
  tasks: Task[];
  doneBusy: ReadonlySet<string>;
  /** The close waiting for confirmation, if any. */
  pendingClose: CloseChoice | null;
  onOpen: (kind: HrOpenKind) => void;
  onTopic: (topic: HrTopic) => void;
  onPickStage: (step: StepState) => void;
  onFlag: (flag: HrFlag, on: boolean) => void;
  onAskClose: (choice: CloseChoice | null) => void;
  onConfirmClose: () => void;
  onReopen: () => void;
  onTaskDone: (task: Task) => void;
  /** Rendered after the tasks (the recruiter-only mounts, the dialog). */
  children?: ReactNode;
}

function Field({
  legend,
  hint,
  children,
}: {
  legend: string;
  hint?: string | null;
  children: ReactNode;
}) {
  return (
    <fieldset className="border-input min-w-0 space-y-1.5 rounded-md border px-2.5 pt-0.5 pb-2.5">
      <legend className="text-muted-foreground px-1 text-xs">{legend}</legend>
      {children}
      {hint && <p className="text-muted-foreground text-[11px]">{hint}</p>}
    </fieldset>
  );
}

export function HrPanelView(props: HrPanelViewProps) {
  const t = useTranslations('Hr');
  const { contactName, busy, row, actions } = props;
  const kind = paneKind(row);
  const stageLabel = (s: HrStage) => t(`stage.${s}`);

  const head = (
    <div className="space-y-0.5">
      <h4 className="text-sm font-semibold">{t('pane.conversation')}</h4>
      <p className="truncate text-lg font-semibold" title={contactName}>
        {contactName}
      </p>
      {row && (
        <p className="text-muted-foreground text-xs">
          {t('pane.inboxLine', { inbox: t(`pane.inboxName.${kind}`) })}
        </p>
      )}
    </div>
  );

  if (!row || !actions) {
    return (
      <section className="bg-wa-panel space-y-3 px-4 py-3" aria-busy={busy}>
        {head}
        <Field legend={t('panel.trackAs')}>
          <div className="flex flex-wrap gap-1">
            {props.kinds.map((k) => (
              <button
                key={k}
                type="button"
                className={SEGMENT}
                disabled={busy}
                onClick={() => props.onOpen(k)}
              >
                {t(
                  k === 'candidate'
                    ? 'panel.kindCandidate'
                    : 'panel.kindEmployee'
                )}
              </button>
            ))}
          </div>
        </Field>
      </section>
    );
  }

  const closed = row.closed_at !== null;
  const hint = (s: PaneSection) => {
    const key = paneMoveHintKey(kind, s);
    return key ? t(key) : null;
  };

  const topicOptions = hrTopicOptGroups().map((g) => (
    <optgroup key={g.group} label={t(g.labelKey)}>
      {g.topics.map((topic) => (
        <option key={topic} value={topic}>
          {t(`topic.${topic}`)}
        </option>
      ))}
    </optgroup>
  ));

  const sections: Record<PaneSection, () => ReactNode> = {
    stage: () => (
      <Field key="stage" legend={t('panel.stage')} hint={hint('stage')}>
        <div className="flex flex-wrap gap-1">
          {props.steps.map((step) => {
            const clickable =
              step.move === 'forward' || step.move === 'backward';
            const current = step.progress === 'current';
            const label = current
              ? t('panel.stepCurrent', { stage: stageLabel(step.stage) })
              : step.progress === 'done'
                ? t('panel.stepDone', { stage: stageLabel(step.stage) })
                : stageLabel(step.stage);
            return (
              <button
                key={step.stage}
                type="button"
                disabled={!clickable || busy}
                aria-current={current ? 'step' : undefined}
                aria-label={
                  clickable
                    ? t('panel.moveTo', { stage: stageLabel(step.stage) })
                    : label
                }
                title={step.move === 'locked' ? t('panel.lockedStep') : label}
                onClick={() => props.onPickStage(step)}
                className={cn(SEGMENT, current && SEGMENT_ON)}
              >
                {step.progress === 'done' && (
                  <Check
                    className="text-muted-foreground size-3 shrink-0"
                    aria-hidden
                  />
                )}
                {stageLabel(step.stage)}
              </button>
            );
          })}
        </div>
      </Field>
    ),
    topic: () => (
      <div key="topic" className="space-y-1">
        <label className="flex items-center gap-2">
          <span className="text-xs">{t('panel.topic')}</span>
          {actions.edit ? (
            <select
              className={NATIVE_FIELD}
              value={row.topic ?? ''}
              disabled={busy}
              onChange={(e) => {
                if (e.target.value) props.onTopic(e.target.value as HrTopic);
              }}
            >
              {row.topic === null && (
                <option value="" disabled>
                  {t('pane.noTopic')}
                </option>
              )}
              {topicOptions}
            </select>
          ) : (
            <span className="text-xs">
              {row.topic ? t(`topic.${row.topic}`) : t('pane.noTopic')}
            </span>
          )}
        </label>
        {hint('topic') && (
          <p className="text-muted-foreground text-[11px]">{hint('topic')}</p>
        )}
      </div>
    ),
    flags: () => (
      <Field key="flags" legend={t('pane.flags')}>
        <div className="flex flex-wrap gap-1">
          {HR_FLAGS.map((flag) => {
            const on = row[flag];
            return (
              <button
                key={flag}
                type="button"
                aria-pressed={on}
                disabled={!actions.edit || busy}
                onClick={() => props.onFlag(flag, !on)}
                className={cn(SEGMENT, on && FLAG_ON[flag])}
              >
                {t(`flag.${flag}`)}
              </button>
            );
          })}
        </div>
      </Field>
    ),
    reply: () => (
      <p
        key="reply"
        className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs"
        aria-label={t('panel.replyState')}
      >
        <span
          className={cn(
            'inline-flex items-center gap-1 font-medium',
            REPLY_TONE[row.reply_state]
          )}
        >
          {row.reply_state === 'reply_due' ? (
            <Contrast className="size-3" aria-hidden />
          ) : (
            <Circle
              className={cn(
                'size-3',
                row.reply_state === 'new' && 'fill-current'
              )}
              aria-hidden
            />
          )}
          {t(`replyState.${row.reply_state}`)}
        </span>
        <span className="text-muted-foreground">{t('pane.replyAuto')}</span>
        {!actions.edit && !closed && (
          <span className="text-muted-foreground basis-full text-[11px]">
            {t('panel.readOnly')}
          </span>
        )}
      </p>
    ),
    close: () => (
      <Field key="close" legend={t('panel.close')}>
        {closed ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs">
              {row.outcome
                ? t('pane.closedWith', {
                    outcome: t(`outcome.${row.outcome}`),
                  })
                : t('panel.closed')}
            </span>
            {actions.reopen && (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={props.onReopen}
              >
                {t('panel.reopen')}
              </Button>
            )}
          </div>
        ) : props.pendingClose ? (
          <div className="space-y-1.5" role="group">
            <p className="text-xs font-medium">
              {t(props.pendingClose.confirmKey, {
                outcome: props.pendingClose.outcome
                  ? t(`outcome.${props.pendingClose.outcome}`)
                  : '',
              })}
            </p>
            <div className="flex flex-wrap gap-1">
              <Button size="xs" disabled={busy} onClick={props.onConfirmClose}>
                {t('panel.confirm')}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => props.onAskClose(null)}
              >
                {t('panel.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {closeChoices(row).map((choice) => (
              <button
                key={choice.labelKey}
                type="button"
                className={SEGMENT}
                disabled={busy}
                onClick={() => props.onAskClose(choice)}
              >
                {t(choice.labelKey)}
              </button>
            ))}
          </div>
        )}
      </Field>
    ),
  };

  return (
    <section className="bg-wa-panel space-y-3 px-4 py-3" aria-busy={busy}>
      {head}
      <h5 className="text-sm font-semibold">
        {kind === 'dept' ? t('panel.staffConversation') : t('pane.tags')}
      </h5>
      {paneSections(row, actions).map((s) => sections[s]())}

      <div className="space-y-1">
        <h5 className="text-muted-foreground text-xs font-medium">
          {t('panel.tasks')}
        </h5>
        {props.tasks.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t('panel.noTasks')}</p>
        ) : (
          <ul className="space-y-1">
            {props.tasks.map((task) => (
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
                  disabled={props.doneBusy.has(task.id)}
                  onClick={() => props.onTaskDone(task)}
                >
                  {t('panel.taskDone')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {props.children}
    </section>
  );
}
