'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { ArrowLeft, Check } from 'lucide-react';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useAuth } from '@/hooks/use-auth';
import { isOverdue, visibleHrTasks } from '@/lib/hr/tasks-view';
import { createClient } from '@/lib/supabase/client';
import type { Task } from '@/lib/tasks/types';
import { cn } from '@/lib/utils';

/**
 * Open HR tasks (migration 200's workflow rules write them as ordinary
 * `tasks` rows). RLS decides which ones come back: the assignee, anyone
 * who can see the customer, leaders, admins (085).
 */
export default function HrTasksPage() {
  const t = useTranslations('Hr.tasks');
  const format = useFormatter();
  const { user, accountId } = useAuth();
  const { nameOf } = useWorkspaceMembers();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const [mine, setMine] = useState(false);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [doneError, setDoneError] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks?scope=all&hr=1&limit=200');
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { tasks: Task[] };
      setTasks(body.tasks);
      setFailed(false);
      setNow(Date.now());
      const ids = [
        ...new Set(body.tasks.map((x) => x.contact_id).filter(Boolean)),
      ] as string[];
      if (ids.length > 0) {
        const { data } = await createClient()
          .from('contacts')
          .select('id, name')
          .in('id', ids);
        setNames(
          Object.fromEntries(
            ((data as { id: string; name: string | null }[] | null) ?? []).map(
              (c) => [c.id, c.name ?? '']
            )
          )
        );
      }
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (accountId) void load();
  }, [accountId, load]);

  const shown = useMemo(
    () =>
      visibleHrTasks(tasks ?? [], {
        mine,
        overdueOnly,
        userId: user?.id ?? null,
        now,
      }),
    [tasks, mine, overdueOnly, user?.id, now]
  );

  async function markDone(id: string) {
    setBusy(id);
    setDoneError(false);
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setTasks((prev) => (prev ?? []).filter((x) => x.id !== id));
    } catch {
      setDoneError(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4 md:p-6">
      <Link
        href="/hr-inbox"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" />
        {t('back')}
      </Link>
      <div>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="border-border bg-card inline-flex rounded-md border p-0.5">
          {[false, true].map((value) => (
            <button
              key={String(value)}
              type="button"
              onClick={() => setMine(value)}
              className={cn(
                'rounded px-3 py-1 text-sm',
                mine === value
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {value ? t('mine') : t('all')}
            </button>
          ))}
        </div>
        <label className="inline-flex items-center gap-2 text-sm">
          <Checkbox
            checked={overdueOnly}
            onCheckedChange={(v) => setOverdueOnly(v === true)}
          />
          {t('overdueOnly')}
        </label>
      </div>

      {doneError && (
        <p className="text-destructive text-sm">{t('doneFailed')}</p>
      )}

      <div className="border-border bg-card rounded-lg border">
        <div className="border-border text-muted-foreground hidden grid-cols-[2fr_1.5fr_1.2fr_1.2fr_auto] gap-3 border-b px-4 py-2 text-xs font-medium md:grid">
          <span>{t('colTitle')}</span>
          <span>{t('colCustomer')}</span>
          <span>{t('colAssignee')}</span>
          <span>{t('colDue')}</span>
          <span className="sr-only">{t('done')}</span>
        </div>
        {failed ? (
          <p className="text-destructive p-4 text-sm">{t('loadFailed')}</p>
        ) : tasks === null ? (
          <div className="bg-card-2 h-24 animate-pulse" />
        ) : shown.length === 0 ? (
          <p className="text-muted-foreground p-4 text-sm">{t('empty')}</p>
        ) : (
          <ul className="divide-border divide-y">
            {shown.map((task) => {
              const late = isOverdue(task, now);
              const customer =
                (task.contact_id && names[task.contact_id]) ||
                t('unknownCustomer');
              return (
                <li
                  key={task.id}
                  className={cn(
                    'grid gap-1 px-4 py-3 md:grid-cols-[2fr_1.5fr_1.2fr_1.2fr_auto] md:items-center md:gap-3',
                    late && 'bg-destructive-soft'
                  )}
                >
                  <span className="min-w-0 font-medium break-words">
                    {task.title}
                  </span>
                  <span className="min-w-0 truncate text-sm">
                    {task.conversation_id ? (
                      <Link
                        href={`/hr-inbox?c=${task.conversation_id}`}
                        className="text-primary hover:underline"
                        title={t('openChat')}
                      >
                        {customer}
                      </Link>
                    ) : (
                      customer
                    )}
                  </span>
                  <span className="text-muted-foreground min-w-0 truncate text-sm">
                    {(task.assigned_to && nameOf(task.assigned_to)) ||
                      t('unassigned')}
                  </span>
                  <span
                    className={cn(
                      'text-sm',
                      late
                        ? 'text-destructive font-medium'
                        : 'text-muted-foreground'
                    )}
                    title={
                      task.due_at
                        ? format.dateTime(new Date(task.due_at), {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })
                        : undefined
                    }
                  >
                    {task.due_at
                      ? `${late ? `${t('overdue')} · ` : ''}${format.relativeTime(new Date(task.due_at), now)}`
                      : t('noDue')}
                  </span>
                  <div className="md:justify-self-end">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === task.id}
                      onClick={() => void markDone(task.id)}
                    >
                      <Check className="size-4" />
                      {t('done')}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
