'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlarmClock, CalendarClock, Video, X } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { useNotifications } from '@/components/notifications/notifications-provider';
import { useCalls } from '@/components/pbx/call-provider';
import { useActiveCall } from '@/components/meetings/session/meeting-session-provider';
import { isRingerBusy, meetingRoomPath } from '@/lib/meetings/invite-ring';
import {
  notificationRow,
  type BellContext,
  type NotificationRowPlan,
} from '@/lib/notifications/target';
import {
  ALARM_MAX_AGE_MS,
  ALARM_TYPES,
  AlarmQueue,
  SNOOZE_OPTIONS,
  flashTitle,
  snoozeUntil,
  visibleAlarms,
  type Alarm,
  type AlarmKind,
  type SnoozeOption,
} from '@/lib/reminders/alarm';
import { createClient } from '@/lib/supabase/client';
import { tabTitle } from '@/lib/tab-alerts/title-owner';
import { cn } from '@/lib/utils';
import type { Notification } from '@/types';

import { playAlarmChime } from './alarm-tone';

/** How many unread alarm rows the page load reads. */
const SEED_LIMIT = 10;

const KIND_STYLE: Record<
  AlarmKind,
  { border: string; strip: string; text: string; ring: string }
> = {
  task: {
    border: 'border-warning',
    strip: 'bg-warning-soft',
    text: 'text-warning',
    ring: 'bg-warning/40',
  },
  meeting: {
    border: 'border-info',
    strip: 'bg-info-soft',
    text: 'text-info',
    ring: 'bg-info/40',
  },
  event: {
    border: 'border-violet-500 dark:border-violet-400',
    strip: 'bg-violet-50 dark:bg-violet-950/40',
    text: 'text-violet-700 dark:text-violet-300',
    ring: 'bg-violet-500/40 dark:bg-violet-400/40',
  },
};

const KIND_ICON = { task: AlarmClock, meeting: Video, event: CalendarClock };
const KIND_LABEL = {
  task: 'reminder',
  meeting: 'meeting',
  event: 'event',
} as const;
const SNOOZE_LABEL: Record<SnoozeOption, string> = {
  '10m': 'snooze10m',
  '1h': 'snooze1h',
  tomorrow: 'snoozeTomorrow',
};

/**
 * Whether the card may change the task itself. The task API answers for
 * the active workspace only, so a row of another workspace (both ids
 * known and different) gets Open and Dismiss, never Snooze or Done.
 */
export function canManageAlarm(
  alarm: Alarm,
  activeWorkspaceId: string | null
): boolean {
  if (alarm.kind !== 'task' || !alarm.taskId) return false;
  return !(
    alarm.accountId &&
    activeWorkspaceId &&
    alarm.accountId !== activeWorkspaceId
  );
}

/** The OS notification tag a web push for the same row uses (197). */
export function alarmNotificationTag(alarm: Alarm): string {
  return alarm.kind === 'task' && alarm.taskId
    ? `task:${alarm.taskId}`
    : `bell:${alarm.row.id}`;
}

/**
 * A system notification for an alarm that starts ringing while the tab
 * is hidden. Same tag as the web push, so the OS shows one, not two.
 */
export function maybeSystemNotification(alarm: Alarm, url: string): void {
  try {
    if (typeof document === 'undefined') return;
    if (document.visibilityState !== 'hidden') return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready
      .then((reg) =>
        reg.showNotification(alarm.title, {
          body: alarm.body ?? undefined,
          tag: alarmNotificationTag(alarm),
          requireInteraction: true,
          data: { url },
        })
      )
      .catch(() => {});
  } catch {
    // Best-effort: the card and the chime still ring.
  }
}

export interface AlarmActionDeps {
  alarm: Alarm;
  plan: NotificationRowPlan;
  markRead: (id: string) => Promise<void>;
  openNotification: (
    n: Notification,
    plan: NotificationRowPlan
  ) => Promise<void>;
  /** Takes the card off this tab at once. */
  remove: (id: string) => void;
  t: (key: string, values?: Record<string, string | number>) => string;
  formatWhen: (when: Date) => string;
  now?: () => Date;
}

export interface AlarmActions {
  open: () => void;
  dismiss: () => void;
  snooze: (option: SnoozeOption) => Promise<void>;
  done: () => Promise<void>;
}

async function patchTask(
  taskId: string,
  body: Record<string, string>
): Promise<boolean> {
  try {
    const res = await fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * What the card's buttons do. Every one that closes the card marks the
 * row read: the realtime UPDATE closes it on the person's other tabs.
 * A failed PATCH leaves the card where it is.
 */
export function alarmActions(deps: AlarmActionDeps): AlarmActions {
  const { alarm, plan, markRead, openNotification, remove, t } = deps;
  const close = () => {
    void markRead(alarm.row.id);
    remove(alarm.id);
  };
  return {
    open: () => {
      // A meeting starting now opens its lobby, like the invite card;
      // the 10-minute heads-up keeps the meeting page.
      const startsNow = alarm.offset === 0 || alarm.offset === null;
      const href =
        alarm.kind === 'meeting' && alarm.meetingId && startsNow
          ? meetingRoomPath(alarm.meetingId)
          : plan.href;
      void openNotification(alarm.row, { ...plan, href });
      remove(alarm.id);
    },
    dismiss: close,
    snooze: async (option) => {
      if (!alarm.taskId) return;
      const until = snoozeUntil(option, deps.now?.() ?? new Date());
      if (!(await patchTask(alarm.taskId, { dueAt: until.toISOString() }))) {
        toast.error(t('failed'));
        return;
      }
      close();
      toast.success(t('snoozedUntil', { when: deps.formatWhen(until) }));
    },
    done: async () => {
      if (!alarm.taskId) return;
      if (!(await patchTask(alarm.taskId, { status: 'done' }))) {
        toast.error(t('failed'));
        return;
      }
      close();
      toast.success(t('doneToast'));
    },
  };
}

/** The snooze choices, with a way back to the card's own buttons. */
export function SnoozeRow({
  pending,
  onPick,
  onBack,
}: {
  pending: boolean;
  onPick: (option: SnoozeOption) => void;
  onBack: () => void;
}) {
  const t = useTranslations('Reminders.alarm');
  const secondary =
    'inline-flex h-9 flex-1 items-center justify-center rounded-lg bg-card-2 px-3 text-sm font-medium hover:bg-muted disabled:opacity-60';
  return (
    <div className="mt-3 flex gap-2" data-snooze-menu>
      <button
        type="button"
        data-snooze-back
        onClick={onBack}
        className={secondary}
      >
        {t('back')}
      </button>
      {SNOOZE_OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          disabled={pending}
          onClick={() => onPick(option)}
          className={secondary}
        >
          {t(SNOOZE_LABEL[option])}
        </button>
      ))}
    </div>
  );
}

export interface ReminderAlarmCardProps {
  alarm: Alarm;
  /** Snooze and Done are offered. */
  manageable: boolean;
  actions: AlarmActions;
}

export function ReminderAlarmCard({
  alarm,
  manageable,
  actions,
}: ReminderAlarmCardProps) {
  const t = useTranslations('Reminders.alarm');
  const [snoozing, setSnoozing] = useState(false);
  const [pending, setPending] = useState(false);
  const style = KIND_STYLE[alarm.kind];
  const Icon = KIND_ICON[alarm.kind];
  const run = (fn: () => Promise<void>) => {
    setPending(true);
    void fn().finally(() => setPending(false));
  };
  const button =
    'inline-flex h-9 flex-1 items-center justify-center rounded-lg px-3 text-sm font-medium disabled:opacity-60';
  const secondary = cn(button, 'bg-card-2 hover:bg-muted');
  return (
    <div
      role="alert"
      data-reminder-alarm={alarm.kind}
      className={cn(
        'bg-card motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-4 max-sm:motion-safe:slide-in-from-bottom-4 overflow-hidden rounded-xl border-2 shadow-xl',
        style.border
      )}
    >
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2 text-xs font-semibold',
          style.strip,
          style.text
        )}
      >
        <span className="relative inline-flex size-7 shrink-0 items-center justify-center">
          {!alarm.missed && (
            <span
              data-alarm-ping
              className={cn(
                'absolute inset-0 rounded-full motion-safe:animate-ping',
                style.ring
              )}
            />
          )}
          <span className="bg-card relative inline-flex size-7 items-center justify-center rounded-full">
            <Icon className="size-4" />
          </span>
        </span>
        <span className="truncate">{t(KIND_LABEL[alarm.kind])}</span>
        {alarm.missed && (
          <span className="bg-destructive-soft text-destructive rounded-full px-2 py-0.5 text-xs font-medium">
            {t('missed')}
          </span>
        )}
        <button
          type="button"
          onClick={actions.dismiss}
          aria-label={t('dismiss')}
          className="text-muted-foreground hover:bg-card/60 hover:text-foreground ml-auto inline-flex size-7 items-center justify-center rounded-full"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="px-4 pt-3 pb-3">
        <p className="text-base font-semibold break-words">{alarm.title}</p>
        {alarm.body && (
          <p className="text-muted-foreground mt-0.5 text-sm break-words">
            {alarm.body}
          </p>
        )}
        {snoozing && manageable ? (
          <SnoozeRow
            pending={pending}
            onPick={(option) => run(() => actions.snooze(option))}
            onBack={() => setSnoozing(false)}
          />
        ) : (
          <div className="mt-3 flex gap-2">
            {alarm.kind === 'meeting' ? (
              <>
                <button
                  type="button"
                  onClick={actions.dismiss}
                  className={secondary}
                >
                  {t('dismiss')}
                </button>
                <button
                  type="button"
                  onClick={actions.open}
                  className={cn(
                    button,
                    'bg-primary text-primary-foreground hover:bg-primary/90'
                  )}
                >
                  {t('join')}
                </button>
              </>
            ) : manageable ? (
              <>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setSnoozing(true)}
                  className={secondary}
                >
                  {t('snooze')}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(actions.done)}
                  className={secondary}
                >
                  {t('done')}
                </button>
                <button
                  type="button"
                  onClick={actions.open}
                  className={cn(
                    button,
                    'bg-primary text-primary-foreground hover:bg-primary/90'
                  )}
                >
                  {t('open')}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={actions.dismiss}
                  className={secondary}
                >
                  {t('dismiss')}
                </button>
                <button
                  type="button"
                  onClick={actions.open}
                  className={cn(
                    button,
                    'bg-primary text-primary-foreground hover:bg-primary/90'
                  )}
                >
                  {t('open')}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export interface ReminderAlarmStackProps {
  shown: readonly Alarm[];
  hidden: number;
  /** The card for one alarm. */
  renderCard: (alarm: Alarm) => React.ReactNode;
}

/** Top right under the top bar; across the bottom on a phone. */
export function ReminderAlarmStack({
  shown,
  hidden,
  renderCard,
}: ReminderAlarmStackProps) {
  const t = useTranslations('Reminders.alarm');
  if (shown.length === 0) return null;
  return (
    <div
      data-reminder-alarms
      className="fixed top-[68px] right-4 z-[56] flex w-[360px] max-w-[calc(100vw-24px)] flex-col gap-2 max-sm:top-auto max-sm:right-3 max-sm:bottom-3 max-sm:left-3 max-sm:w-auto max-sm:max-w-none"
    >
      {shown.map((alarm) => (
        <div key={alarm.id}>{renderCard(alarm)}</div>
      ))}
      {hidden > 0 && (
        <p className="bg-card text-muted-foreground rounded-lg px-3 py-1.5 text-center text-xs font-medium shadow">
          {t('more', { count: hidden })}
        </p>
      )}
    </div>
  );
}

/** One alarm card with its actions wired to the bell and the task API. */
export function ConnectedAlarmCard({
  alarm,
  remove,
}: {
  alarm: Alarm;
  remove: (id: string) => void;
}) {
  const t = useTranslations('Reminders.alarm');
  const format = useFormatter();
  const { activeWorkspaceId, accountRole, workspaces } = useAuth();
  const { markRead, openNotification } = useNotifications();
  const plan = notificationRow(alarm.row, {
    activeWorkspaceId,
    activeRole: accountRole,
    workspaces,
  });
  const actions = alarmActions({
    alarm,
    plan,
    markRead,
    openNotification,
    remove,
    t,
    formatWhen: (when) =>
      format.dateTime(when, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      }),
  });
  return (
    <ReminderAlarmCard
      alarm={alarm}
      manageable={canManageAlarm(alarm, activeWorkspaceId)}
      actions={actions}
    />
  );
}

/**
 * Flips the tab title while an alarm is shown and the tab is hidden.
 * Through `tabTitle` (lib/tab-alerts/title-owner.ts): the unread tab
 * title stands down while this flashes, the even ticks show its current
 * title, and the end puts the current one back, not the one saved when
 * the flash began.
 */
function useFlashingTitle(alarmTitle: string | null) {
  useEffect(() => {
    if (!alarmTitle) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    let tick = 0;
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
      tabTitle.endFlash();
    };
    const sync = () => {
      if (document.visibilityState !== 'hidden') {
        stop();
        return;
      }
      if (timer !== null) return;
      tabTitle.beginFlash();
      tick = 0;
      timer = setInterval(() => {
        tick += 1;
        tabTitle.flashWrite(flashTitle(tabTitle.base(), alarmTitle, tick));
      }, 1000);
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      stop();
    };
  }, [alarmTitle]);
}

/**
 * The queue, plus the bell context the system notification's link is
 * planned with (kept current by the component, like InviteRinger's).
 */
class RingingAlarms extends AlarmQueue {
  private bell: BellContext = {
    activeWorkspaceId: null,
    activeRole: null,
    workspaces: [],
  };

  constructor() {
    super({
      chime: (id, n) => {
        playAlarmChime(id, n);
        if (n !== 0) return;
        // The first chime fires inside add(), before the snapshot holds
        // the alarm: look it up once the queue has emitted.
        setTimeout(() => {
          const alarm = this.getSnapshot().find((a) => a.id === id);
          if (!alarm) return;
          const href = notificationRow(alarm.row, this.bell).href;
          maybeSystemNotification(alarm, href ?? '/notifications');
        }, 0);
      },
    });
  }

  setBell(bell: BellContext): void {
    this.bell = bell;
  }
}

/** The ringing reminder cards, over whatever page of the dashboard is open. */
export function ReminderAlarm() {
  const { onChange } = useNotifications();
  const { user, activeWorkspaceId, accountRole, workspaces } = useAuth();
  const active = useActiveCall();
  const calls = useCalls();
  const busy = isRingerBusy(active?.call.phase ?? null, calls);

  // The system notification's link is planned with the latest context.
  const [queue] = useState(() => new RingingAlarms());

  useEffect(() => {
    queue.setBell({ activeWorkspaceId, activeRole: accountRole, workspaces });
  });

  const alarms = useSyncExternalStore(
    queue.subscribe,
    queue.getSnapshot,
    queue.getSnapshot
  );

  useEffect(() => {
    queue.setBusy(busy);
  }, [queue, busy]);

  useEffect(() => {
    const stopListening = onChange((change) => queue.handle(change));
    return () => {
      stopListening();
      queue.close();
    };
  }, [onChange, queue]);

  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      try {
        const since = new Date(Date.now() - ALARM_MAX_AGE_MS).toISOString();
        const { data, error } = await createClient()
          .from('notifications')
          .select('*')
          .eq('user_id', userId)
          .is('read_at', null)
          .in('type', [...ALARM_TYPES])
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(SEED_LIMIT);
        if (cancelled || error || !data) return;
        queue.seed(data as Notification[], Date.now());
      } catch {
        // A failed read seeds nothing; realtime still rings new rows.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [queue, userId]);

  const { shown, hidden } = visibleAlarms(alarms);
  useFlashingTitle(shown[0]?.title ?? null);

  return (
    <ReminderAlarmStack
      shown={shown}
      hidden={hidden}
      renderCard={(alarm) => (
        <ConnectedAlarmCard alarm={alarm} remove={(id) => queue.remove(id)} />
      )}
    />
  );
}
