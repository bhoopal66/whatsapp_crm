'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { GatedButton } from '@/components/ui/gated-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { fromLocalInput, type CaseTabProps } from '@/lib/cases/case-page';
import {
  isTaskOverdue,
  sortTasks,
  toolErrorKey,
  type TaskStatus,
} from '@/lib/cases/case-tools-ui';
import { cn } from '@/lib/utils';
import type { Profile } from '@/types';

import { sendCaseRequest } from './case-dialogs';
import {
  asList,
  asObj,
  asStr,
  TabStatus,
  useCaseResource,
  useWhen,
} from './tab-kit';

interface Task {
  id: string;
  title: string;
  ownerId: string | null;
  dueAt: string | null;
  status: TaskStatus;
  createdAt: string;
}
interface Template {
  templateKey: string;
  title: string;
  dueHours: number | null;
}

const STATUSES: readonly string[] = ['open', 'done', 'blocked'];
const DEFAULT_OWNER = '__default';

function parse(json: unknown): { tasks: Task[]; templates: Template[] } {
  const root = asObj(json);
  return {
    tasks: asList(root?.tasks).flatMap((v) => {
      const r = asObj(v);
      const id = asStr(r?.id);
      const status = asStr(r?.status);
      if (!r || !id || !status || !STATUSES.includes(status)) return [];
      return [
        {
          id,
          title: asStr(r.title) ?? asStr(r.templateKey) ?? '',
          ownerId: asStr(r.ownerId),
          dueAt: asStr(r.dueAt),
          status: status as TaskStatus,
          createdAt: asStr(r.createdAt) ?? '',
        },
      ];
    }),
    templates: asList(root?.templates).flatMap((v) => {
      const r = asObj(v);
      const key = asStr(r?.templateKey);
      if (!r || !key) return [];
      return [
        {
          templateKey: key,
          title: asStr(r.title) ?? key,
          dueHours: typeof r.dueHours === 'number' ? r.dueHours : null,
        },
      ];
    }),
  };
}

/** Where a task's status can move, as [target, label key]. */
const MOVES: Record<TaskStatus, [TaskStatus, string][]> = {
  open: [
    ['done', 'markDone'],
    ['blocked', 'block'],
  ],
  blocked: [
    ['open', 'unblock'],
    ['done', 'markDone'],
  ],
  done: [['open', 'reopen']],
};

/** The case's tasks, soonest due first, with status moves and "Add task". */
export function TasksTab({ caseId, detail }: CaseTabProps) {
  const t = useTranslations('CasePage');
  const when = useWhen();
  const { members, nameOf } = useWorkspaceMembers();
  const { data, failed, loadedAt, reload } = useCaseResource(
    `/api/cases/${caseId}/tasks`,
    parse
  );
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  if (!data)
    return (
      <TabStatus
        failed={failed}
        loading={t('tasks.loading')}
        error={t('tasks.loadFailed')}
        onRetry={() => void reload()}
      />
    );

  const closed = detail.case.closedAt !== null;
  const canAct = detail.permissions.canWrite && !closed;
  const gate = !detail.permissions.canWrite
    ? t('gate.write')
    : closed
      ? t('gate.closed')
      : undefined;

  const setStatus = async (task: Task, status: TaskStatus) => {
    setBusy(`${task.id}:${status}`);
    const r = await sendCaseRequest(
      `/api/cases/${caseId}/tasks/${task.id}`,
      'PATCH',
      { status }
    );
    setBusy(null);
    if (!r.ok) {
      const code = (r.json as { code?: unknown } | null)?.code;
      toast.error(t(toolErrorKey(r.status, code)));
      return;
    }
    const changed = (r.json as { changed?: unknown } | null)?.changed;
    if (changed === false) toast.info(t('tasks.unchanged'));
    else toast.success(t('tasks.changed'));
    void reload();
  };

  const tasks = sortTasks(data.tasks);
  const noTemplates = data.templates.length === 0;

  return (
    <section className="bg-card space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t('tasks.title')}</h2>
        <GatedButton
          size="sm"
          variant="outline"
          disabled={!canAct || noTemplates}
          title={gate ?? (noTemplates ? t('tasks.noTemplates') : undefined)}
          onClick={() => setAdding(true)}
        >
          <Plus className="size-4" aria-hidden />
          {t('tasks.add')}
        </GatedButton>
      </div>
      {noTemplates && (
        <p className="text-muted-foreground text-xs">
          {t('tasks.noTemplates')}
        </p>
      )}

      {tasks.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('tasks.empty')}</p>
      ) : (
        <ul className="divide-y">
          {tasks.map((task) => {
            const overdue = isTaskOverdue(task, loadedAt);
            const due = when(task.dueAt);
            return (
              <li
                key={task.id}
                className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        'text-sm font-medium break-words',
                        task.status === 'done' &&
                          'text-muted-foreground line-through'
                      )}
                    >
                      {task.title}
                    </span>
                    <Badge
                      variant={
                        task.status === 'blocked' ? 'outline' : 'secondary'
                      }
                    >
                      {t(`tasks.status.${task.status}`)}
                    </Badge>
                    {overdue && (
                      <Badge variant="destructive">{t('tasks.overdue')}</Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    <span className={cn(overdue && 'text-destructive')}>
                      {due ? t('tasks.due', { when: due }) : t('tasks.noDue')}
                    </span>
                    {' · '}
                    {t('tasks.owner', {
                      name: task.ownerId
                        ? (nameOf(task.ownerId) ?? t('unknownPerson'))
                        : t('nobody'),
                    })}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {MOVES[task.status].map(([to, label]) => (
                    <GatedButton
                      key={to}
                      size="sm"
                      variant="ghost"
                      disabled={!canAct || busy !== null}
                      title={gate}
                      onClick={() => void setStatus(task, to)}
                    >
                      {busy === `${task.id}:${to}` && (
                        <Loader2 className="size-4 animate-spin" />
                      )}
                      {t(`tasks.${label}`)}
                    </GatedButton>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {adding && (
        <AddTaskDialog
          caseId={caseId}
          templates={data.templates}
          members={members}
          onOpenChange={setAdding}
          onAdded={() => void reload()}
        />
      )}
    </section>
  );
}

function AddTaskDialog({
  caseId,
  templates,
  members,
  onOpenChange,
  onAdded,
}: {
  caseId: string;
  templates: Template[];
  members: Profile[];
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const t = useTranslations('CasePage');
  const [key, setKey] = useState('');
  const [owner, setOwner] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const people = members.filter((m) => !m.deactivated_at);
  const template = templates.find((x) => x.templateKey === key);
  const ownerName = (id: string) => {
    const m = members.find((p) => p.user_id === id);
    return m ? m.full_name || m.email : id;
  };

  const save = async () => {
    if (!key) return;
    const dueIso = fromLocalInput(due);
    if (due && dueIso === null) return setError(t('tasks.errors.dueInvalid'));
    setBusy(true);
    setError(null);
    const r = await sendCaseRequest(`/api/cases/${caseId}/tasks`, 'POST', {
      template_key: key,
      ...(owner ? { owner_id: owner } : {}),
      ...(dueIso ? { due_at: dueIso } : {}),
    });
    setBusy(false);
    if (!r.ok) {
      const code = (r.json as { code?: unknown } | null)?.code;
      return setError(t(toolErrorKey(r.status, code)));
    }
    toast.success(t('tasks.created'));
    onAdded();
    onOpenChange(false);
  };

  return (
    <Dialog open onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('tasks.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('tasks.dialogBody')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="case-task-template">{t('tasks.template')}</Label>
            <Select value={key} onValueChange={(v) => setKey(String(v ?? ''))}>
              <SelectTrigger id="case-task-template" className="w-full">
                <SelectValue>
                  {template ? template.title : t('tasks.pickTemplate')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {templates.map((x) => (
                  <SelectItem key={x.templateKey} value={x.templateKey}>
                    {x.dueHours === null
                      ? x.title
                      : `${x.title} (${t('tasks.templateDue', { hours: x.dueHours })})`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="case-task-owner">{t('tasks.ownerLabel')}</Label>
            <Select
              value={owner || DEFAULT_OWNER}
              onValueChange={(v) =>
                setOwner(v && v !== DEFAULT_OWNER ? String(v) : '')
              }
            >
              <SelectTrigger id="case-task-owner" className="w-full">
                <SelectValue>
                  {owner ? ownerName(owner) : t('tasks.ownerDefault')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_OWNER}>
                  {t('tasks.ownerDefault')}
                </SelectItem>
                {people.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.full_name || m.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="case-task-due">{t('tasks.dueLabel')}</Label>
            <Input
              id="case-task-due"
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              {t('tasks.dueDefault')}
            </p>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t('cancel')}
          </Button>
          <Button disabled={!key || busy} onClick={() => void save()}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t('tasks.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
