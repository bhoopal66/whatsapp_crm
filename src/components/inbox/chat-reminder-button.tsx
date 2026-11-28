'use client';

// The chat header's "Remind me": file a follow-up task about this
// customer and this chat (POST /api/tasks, kind follow_up, source
// chat), due on a preset day at 09:00 or at a picked time. A task with
// a due date is on the calendar; its holder gets a quiet `task_due`
// heads-up 15 minutes before and the ringing alarm when it falls due. The dialog also lists the customer's upcoming
// open reminders (GET /api/tasks scope=contact, read when it opens,
// never on chat open) with a Done action where the caller may edit. Agent and up only, as the route
// is; the call window's `FollowUpReminder` is the same idea for calls.

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { BellPlus, Loader2 } from 'lucide-react';
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
import { useAuth } from '@/hooks/use-auth';
import { canSendMessages } from '@/lib/auth/roles';
import { toDateTimeLocal } from '@/lib/pbx/follow-up';
import {
  REMINDER_PRESETS,
  canMarkReminderDone,
  parseCustomReminderDue,
  reminderAssignees,
  reminderDueAt,
  savedToastKey,
  type ReminderPreset,
  loadUpcomingReminders,
  type UpcomingReminder,
} from '@/lib/tasks/reminder';
import { hrTaskTitle } from '@/lib/hr/task-title';
import { TASK_NOTE_MAX, TASK_TITLE_MAX } from '@/lib/tasks/types';
import { cn } from '@/lib/utils';
import type { Profile } from '@/types';

const chip =
  'border-border bg-card hover:bg-muted rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50';
const chipOn = 'border-primary bg-primary/10 text-primary hover:bg-primary/15';
const field =
  'border-input bg-card dark:bg-input/30 w-full rounded-md border px-2.5 py-1.5 text-sm';

export interface ChatReminderButtonProps {
  conversationId: string;
  contactId: string;
  customerName: string;
  /** Who the viewer may hand the chat to; the "For" choices. */
  assignableProfiles: Profile[];
  currentUserId: string | null;
}

export function ChatReminderButton(props: ChatReminderButtonProps) {
  const t = useTranslations('Inbox.reminder');
  const { accountRole } = useAuth();
  const [open, setOpen] = useState(false);
  if (!accountRole || !canSendMessages(accountRole)) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t('tooltip')}
        aria-label={t('action')}
        className="text-wa-icon hover:bg-wa-icon-hover inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors"
      >
        <BellPlus className="h-4 w-4" />
      </button>
      {open && <ReminderDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

type When = { kind: 'preset'; preset: ReminderPreset } | { kind: 'pick' };

export interface ReminderDialogProps extends ChatReminderButtonProps {
  onClose: () => void;
  /**
   * Prefill (a message's reminder suggestion): the title, a picked time
   * and the note. Omitted → empty title, Tomorrow, no note.
   */
  initial?: { what: string; dueAt: Date; note: string };
  /** Called with the new task's id right after a successful save. */
  onSaved?: (taskId: string) => void;
}

export function ReminderDialog({
  conversationId,
  contactId,
  customerName,
  assignableProfiles,
  currentUserId,
  onClose,
  initial,
  onSaved,
}: ReminderDialogProps) {
  const t = useTranslations('Inbox.reminder');
  const locale = useLocale();
  const { accountRole } = useAuth();
  const [what, setWhat] = useState(initial?.what ?? '');
  const [when, setWhen] = useState<When>(
    initial ? { kind: 'pick' } : { kind: 'preset', preset: 'tomorrow' }
  );
  const [custom, setCustom] = useState(
    initial ? toDateTimeLocal(initial.dueAt) : ''
  );
  const [note, setNote] = useState(initial?.note ?? '');
  const [forId, setForId] = useState<string>(currentUserId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<
    'pickInvalid' | 'pickPast' | 'pickTooSoon' | null
  >(null);
  const [upcoming, setUpcoming] = useState<UpcomingReminder[] | null>(null);
  const [upcomingFailed, setUpcomingFailed] = useState(false);
  const [ticking, setTicking] = useState<string | null>(null);

  const people = reminderAssignees(assignableProfiles, currentUserId);
  const nameOf = (userId: string | null) =>
    userId === currentUserId
      ? t('me')
      : (people.find((p) => p.user_id === userId)?.full_name ?? null);

  const formatWhen = useCallback(
    (at: Date) =>
      at.toLocaleString(locale, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    [locale]
  );

  useEffect(() => {
    // Read once when the dialog opens, never on chat open. A failed
    // read is null, shown as a failure and never as "none".
    let live = true;
    void loadUpcomingReminders(contactId).then((list) => {
      if (!live) return;
      setUpcoming(list ?? []);
      setUpcomingFailed(list === null);
    });
    return () => {
      live = false;
    };
  }, [contactId]);

  const title = what.trim();

  const dueAt = (): Date | null => {
    if (when.kind === 'preset') return reminderDueAt(when.preset, new Date());
    const r = parseCustomReminderDue(custom, new Date());
    if (!r.ok) {
      setError(
        r.reason === 'past'
          ? 'pickPast'
          : r.reason === 'tooSoon'
            ? 'pickTooSoon'
            : 'pickInvalid'
      );
      return null;
    }
    return r.at;
  };

  const cancelTask = async (id: string) => {
    const res = await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' }),
    }).catch(() => null);
    if (!res?.ok) return void toast.error(t('undoFailed'));
    toast.success(t('undone'));
  };

  const save = async () => {
    if (!title || saving) return;
    const due = dueAt();
    if (!due) return;
    setSaving(true);
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        note: note.trim() || null,
        kind: 'follow_up',
        source: 'chat',
        contactId,
        conversationId,
        ...(forId && forId !== currentUserId ? { assignedTo: forId } : {}),
        dueAt: due.toISOString(),
      }),
    }).catch(() => null);
    const body = res?.ok
      ? ((await res.json().catch(() => null)) as {
          task?: { id?: string };
        } | null)
      : null;
    setSaving(false);
    const id = body?.task?.id;
    if (!id) return void toast.error(t('failed'));
    onSaved?.(id);
    const key = savedToastKey(forId, currentUserId);
    const forName = people.find((p) => p.user_id === forId)?.full_name ?? '';
    toast.success(t(key, { when: formatWhen(due), name: forName }), {
      action: { label: t('undo'), onClick: () => void cancelTask(id) },
    });
    onClose();
  };

  const markDone = async (task: UpcomingReminder) => {
    setTicking(task.id);
    const res = await fetch(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    }).catch(() => null);
    setTicking(null);
    if (!res?.ok) return void toast.error(t('doneFailed'));
    toast.success(t('doneSaved'));
    setUpcoming((prev) => prev?.filter((r) => r.id !== task.id) ?? prev);
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title', { name: customerName })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t('whatLabel')}</span>
            <input
              type="text"
              value={what}
              maxLength={TASK_TITLE_MAX}
              autoFocus
              placeholder={t('whatPlaceholder')}
              onChange={(e) => setWhat(e.target.value)}
              className={field}
            />
          </label>

          <div className="space-y-1">
            <span className="text-sm font-medium">{t('whenLabel')}</span>
            <div className="flex flex-wrap gap-1.5">
              {REMINDER_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={when.kind === 'preset' && when.preset === p}
                  className={cn(
                    chip,
                    when.kind === 'preset' && when.preset === p && chipOn
                  )}
                  onClick={() => {
                    setWhen({ kind: 'preset', preset: p });
                    setError(null);
                  }}
                >
                  {t(`presets.${p}`)}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={when.kind === 'pick'}
                className={cn(chip, when.kind === 'pick' && chipOn)}
                onClick={() => {
                  setWhen({ kind: 'pick' });
                  if (!custom)
                    setCustom(
                      toDateTimeLocal(reminderDueAt('tomorrow', new Date()))
                    );
                }}
              >
                {t('pick')}
              </button>
            </div>
            {when.kind === 'pick' && (
              <input
                type="datetime-local"
                value={custom}
                aria-label={t('pickLabel')}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'reminder-pick-error' : undefined}
                onChange={(e) => {
                  setCustom(e.target.value);
                  setError(null);
                }}
                className={field}
              />
            )}
            {when.kind === 'preset' && (
              <p className="text-muted-foreground text-xs">
                {formatWhen(reminderDueAt(when.preset, new Date()))}
              </p>
            )}
            {error && (
              <p
                id="reminder-pick-error"
                role="alert"
                className="text-destructive text-xs"
              >
                {t(error)}
              </p>
            )}
          </div>

          <label className="block space-y-1">
            <span className="text-sm font-medium">{t('noteLabel')}</span>
            <textarea
              value={note}
              maxLength={TASK_NOTE_MAX}
              rows={2}
              placeholder={t('notePlaceholder')}
              onChange={(e) => setNote(e.target.value)}
              className={cn(field, 'resize-none')}
            />
          </label>

          {people.length > 1 && (
            <label className="block space-y-1">
              <span className="text-sm font-medium">{t('forLabel')}</span>
              <select
                value={forId}
                onChange={(e) => setForId(e.target.value)}
                className={field}
              >
                {people.map((p) => (
                  <option key={p.user_id} value={p.user_id}>
                    {p.user_id === currentUserId ? t('me') : p.full_name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <div className="border-border space-y-1 border-t pt-3">
          <h3 className="text-sm font-semibold">{t('upcomingTitle')}</h3>
          {upcoming === null ? (
            <div
              className="bg-muted h-8 animate-pulse rounded-md"
              aria-hidden
            />
          ) : upcomingFailed ? (
            <p className="text-destructive text-sm" role="alert">
              {t('upcomingFailed')}
            </p>
          ) : upcoming.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t('upcomingEmpty')}
            </p>
          ) : (
            <ul className="divide-border max-h-40 divide-y overflow-y-auto">
              {upcoming.map((task) => {
                const who = task.assigned_to
                  ? nameOf(task.assigned_to)
                  : t('unassigned');
                return (
                  <li
                    key={task.id}
                    className="flex items-center gap-2 py-1.5 text-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate">{hrTaskTitle(task, locale)}</p>
                      <p className="text-muted-foreground text-xs">
                        {formatWhen(new Date(task.due_at!))}
                        {who ? ` · ${who}` : ''}
                      </p>
                    </div>
                    {canMarkReminderDone(task, currentUserId, accountRole) && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={ticking === task.id}
                        onClick={() => void markDone(task)}
                        aria-label={t('markDone', {
                          title: hrTaskTitle(task, locale),
                        })}
                      >
                        {t('done')}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button disabled={!title || saving} onClick={() => void save()}>
            {saving && <Loader2 className="me-1 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
