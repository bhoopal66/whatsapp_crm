'use client';

// The in-call window's Open tasks block: the customer's open tasks the
// caller may see (GET /api/tasks with scope=contact: the default `mine`
// scope ignores the contact). RLS decides what comes back. Ticking one
// done is the customer page's PATCH; only agent and up may, as there.
// A refused read renders nothing.

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  CheckSquare,
  PhoneCall,
  PhoneMissed,
  Route,
  Undo2,
  type LucideIcon,
} from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { canSendMessages } from '@/lib/auth/roles';
import { isOverdue } from '@/lib/pbx/call-context';
import { messageWhen } from '@/lib/pbx/call-ui';
import type { Task, TaskKind } from '@/lib/tasks/types';
import { cn } from '@/lib/utils';

import { useCalls } from './call-provider';

const KIND_ICON: Record<TaskKind, LucideIcon> = {
  manual: CheckSquare,
  callback: PhoneCall,
  missed_call: PhoneMissed,
  journey: Route,
  follow_up: Undo2,
};

type OpenTask = Pick<Task, 'id' | 'kind' | 'title' | 'due_at' | 'assigned_to'>;

export function OpenTasks({ contactId }: { contactId: string }) {
  const t = useTranslations('CallContext.tasks');
  const locale = useLocale();
  const { accountRole } = useAuth();
  const names = useCalls()?.names;
  const canTick = !!accountRole && canSendMessages(accountRole);
  // Keyed by the contact it was read for, so a new contact reads as
  // loading without a state reset inside the effect.
  const [read, setRead] = useState<{
    contactId: string;
    state: 'ready' | 'hidden' | 'error';
    rows: OpenTask[];
  } | null>(null);
  const [ticking, setTicking] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    const settle = (
      state: 'ready' | 'hidden' | 'error',
      rows: OpenTask[] = []
    ) => live && setRead({ contactId, state, rows });
    const q = new URLSearchParams({
      scope: 'contact',
      contactId,
      status: 'open',
      limit: '5',
    });
    void fetch(`/api/tasks?${q}`, { cache: 'no-store' })
      .then(async (r) => {
        if (r.status === 403 || r.status === 404) return settle('hidden');
        if (!r.ok) return settle('error');
        const body = (await r.json().catch(() => null)) as {
          tasks?: unknown;
        } | null;
        if (!Array.isArray(body?.tasks)) return settle('error');
        settle('ready', body.tasks as OpenTask[]);
      })
      .catch(() => settle('error'));
    return () => {
      live = false;
    };
  }, [contactId]);

  const mine = read?.contactId === contactId ? read : null;

  const tick = async (task: OpenTask) => {
    setTicking(task.id);
    const res = await fetch(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    }).catch(() => null);
    setTicking(null);
    if (!res?.ok) return void toast.error(t('doneFailed'));
    toast.success(t('done'));
    setRead((prev) =>
      prev && prev.contactId === contactId
        ? { ...prev, rows: prev.rows.filter((r) => r.id !== task.id) }
        : prev
    );
  };

  if (!mine)
    return (
      <div className="bg-muted h-10 animate-pulse rounded-md" aria-hidden />
    );
  if (mine.state === 'hidden') return null;
  if (mine.state === 'error')
    return <p className="text-muted-foreground text-xs">{t('failed')}</p>;

  return (
    <div className="space-y-1">
      <h3 className="text-sm font-semibold">{t('title')}</h3>
      {mine.rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="divide-border divide-y">
          {mine.rows.map((task) => {
            const Icon = KIND_ICON[task.kind] ?? CheckSquare;
            const overdue = isOverdue(task.due_at, now);
            const when = task.due_at
              ? messageWhen(task.due_at, now, { locale })
              : '';
            const who = task.assigned_to
              ? (names?.[task.assigned_to] ?? null)
              : t('unassigned');
            return (
              <li key={task.id} className="flex items-start gap-2 py-2 text-sm">
                {canTick && (
                  <input
                    type="checkbox"
                    className="border-input bg-card dark:bg-input/30 mt-0.5 size-4 shrink-0 rounded"
                    checked={false}
                    disabled={ticking === task.id}
                    onChange={() => void tick(task)}
                    aria-label={t('markDone', { title: task.title })}
                  />
                )}
                <Icon
                  className="text-muted-foreground mt-0.5 size-4 shrink-0"
                  aria-label={t(`kinds.${task.kind}`)}
                />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="truncate font-medium">{task.title}</p>
                  <p
                    className={cn(
                      'truncate text-xs',
                      overdue ? 'text-destructive' : 'text-muted-foreground'
                    )}
                  >
                    {[
                      task.due_at
                        ? t(overdue ? 'overdue' : 'due', { when })
                        : t('noDue'),
                      who,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
