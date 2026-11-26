'use client';

/**
 * The HR panel at the top of a chat's contact panel (migration 200,
 * HR_SPEC "UI"). Every write is an `hr_*` RPC that re-checks the caller
 * and the chat's visibility; `lib/hr/panel.ts` only decides what to
 * offer. Mount it keyed by the conversation id so a chat switch starts
 * from empty state; late answers are still dropped once unmounted.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
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
  REFERENCE_CACHE_TTL_MS,
  cachedQuery,
  membersCacheKey,
  teamRosterCacheKey,
} from '@/lib/client-cache';
import { isBankGuest } from '@/lib/auth/roles';
import { AssignConfirmDialog } from '@/components/inbox/assign-confirm-dialog';
import { assignableMembers, assignFromScreen } from '@/lib/inbox/assign';
import { startCatchUp, type LiveRead } from '@/lib/realtime/catch-up';
import type { Profile } from '@/types';
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
import { startFirstLoad, type FirstLoad } from '@/lib/hr/panel-load';
import { mayActOnDrafts } from '@/lib/hr/agents/panel';
import { HrAgentDrafts } from './hr-agent-drafts';
import { HrAutomsgConsent } from './hr-automsg-consent';
import { HrPanelView } from './hr-panel-view';
import {
  furthestStage,
  hasReason,
  hrOwnerChoices,
  laterStage,
  openKinds,
  outcomeToSend,
  panelActions,
  showHrPanel,
  stepNeedsReason,
  stepperSteps,
  type CloseChoice,
  type StepState,
} from '@/lib/hr/panel';
import type {
  HrConversation,
  HrOpenKind,
  HrRoles,
  HrStage,
  HrTopic,
} from '@/lib/hr/types';
import type { Task } from '@/lib/tasks/types';

export { hrRolesCacheKey } from '@/lib/hr/roles-cache';

type ReasonAsk = { kind: 'back'; stage: HrStage } | { kind: 'reopen' };

interface HrPanelProps {
  conversationId: string;
  /** `conversations.inbox_department` (migration 192). */
  inboxDepartment: string | null | undefined;
  /** The contact's display name, the pane's title. */
  contactName: string;
  /** `conversations.assigned_agent_id`: the pane's Owner. */
  assignedAgentId?: string | null;
  /** The inbox page's `handleAssignChange`, as the thread header calls it. */
  onAssignChange?: (conversationId: string, userId: string | null) => void;
}

type HrRead = Awaited<ReturnType<typeof readHr>>;

/** The chat's HR row and every stage it reached. */
async function readHr(conversationId: string) {
  const sb = createClient();
  const [rowRes, historyRes] = await Promise.all([
    sb
      .from('hr_conversations')
      .select('*')
      .eq('conversation_id', conversationId)
      .maybeSingle(),
    sb
      .from('hr_stage_history')
      .select('to_stage')
      .eq('conversation_id', conversationId),
  ]);
  return { rowRes, historyRes };
}

export function HrPanel({
  conversationId,
  inboxDepartment,
  contactName,
  assignedAgentId = null,
  onAssignChange,
}: HrPanelProps) {
  const t = useTranslations('Hr');
  const tRows = useTranslations('InboxRows');
  const { accountId, user, accountRole, profileLoading } = useAuth();
  const userId = user?.id ?? null;

  // The owner as the database last answered here, until the page's row
  // catches up.
  const [owner, setOwner] = useState<string | null>(assignedAgentId);
  useEffect(() => {
    setOwner(assignedAgentId);
  }, [assignedAgentId]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [leadable, setLeadable] = useState<Set<string>>(new Set());
  const [team, setTeam] = useState<{ inbox: string; ids: Set<string> } | null>(
    null
  );

  const [roles, setRoles] = useState<HrRoles | null>(null);
  const [row, setRow] = useState<HrConversation | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [furthest, setFurthest] = useState<HrStage | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  // The list's last read failed; an old list is kept, flagged.
  const [tasksFailed, setTasksFailed] = useState(false);
  // The first read of the row failed for good: not "not tracked".
  const [loadFailed, setLoadFailed] = useState(false);
  const firstLoadRef = useRef<FirstLoad | null>(null);
  const [busy, setBusy] = useState(false);
  const [doneBusy, setDoneBusy] = useState<Set<string>>(new Set());
  const [pendingClose, setPendingClose] = useState<CloseChoice | null>(null);
  const [ask, setAsk] = useState<ReasonAsk | null>(null);
  // An owner pick that found another owner than this panel showed.
  const [ownerAgain, setOwnerAgain] = useState<{ next: string | null } | null>(
    null
  );
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

  // The Owner names and choices: the thread header's member list and
  // team roster, through the same cache entries (same keys, same shape).
  useEffect(() => {
    if (!hasAccess || !accountId) return;
    let alive = true;
    void cachedQuery(
      membersCacheKey(accountId),
      REFERENCE_CACHE_TTL_MS,
      async () => {
        const { data, error } = await createClient()
          .from('profiles')
          .select('*')
          .eq('account_id', accountId)
          .order('full_name');
        if (error) throw error;
        return ((data as Profile[] | null) ?? []).filter(
          (p) => !isBankGuest(p.account_role)
        );
      }
    )
      .catch(() => [] as Profile[])
      .then((data) => {
        if (alive) setProfiles(data);
      });
    return () => {
      alive = false;
    };
  }, [hasAccess, accountId]);

  useEffect(() => {
    if (!hasAccess || accountRole !== 'team_leader' || !userId) return;
    let alive = true;
    const leaderId = userId;
    void cachedQuery(
      teamRosterCacheKey(leaderId),
      REFERENCE_CACHE_TTL_MS,
      async () => {
        const { data, error } = await createClient()
          .from('teams')
          .select('team_members(user_id)')
          .eq('leader_user_id', leaderId);
        if (error || !data) return null;
        const found = new Set<string>();
        for (const team of data as {
          team_members: { user_id: string }[] | null;
        }[]) {
          for (const m of team.team_members ?? []) found.add(m.user_id);
        }
        return found;
      }
    )
      .catch(() => null)
      .then((ids) => {
        if (alive && ids) setLeadable(ids);
      });
    return () => {
      alive = false;
    };
  }, [hasAccess, accountRole, userId]);

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
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { tasks?: Task[] };
        if (isCurrent(id)) {
          setTasks((body.tasks ?? []).filter(isHrTask));
          setTasksFailed(false);
        }
      } catch {
        if (isCurrent(id)) setTasksFailed(true);
      }
    },
    [isCurrent]
  );

  // The row and the furthest stage ever reached.
  const show = useCallback(
    (id: string, { rowRes, historyRes }: HrRead) => {
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
    },
    [isCurrent, loadTasks]
  );
  useEffect(() => {
    if (!hasAccess) return;
    const id = conversationId;
    setLoadFailed(false);
    const first = startFirstLoad(
      async () => {
        const read = await readHr(id);
        const error = read.rowRes.error ?? read.historyRes.error;
        if (error) throw error;
        return read;
      },
      {
        onData: (read) => show(id, read),
        onState: (state) => {
          if (isCurrent(id)) setLoadFailed(state === 'failed');
        },
      }
    );
    firstLoadRef.current = first;
    return () => {
      first.stop();
      if (firstLoadRef.current === first) firstLoadRef.current = null;
    };
  }, [conversationId, hasAccess, show, isCurrent]);

  // A write or the catch-up read is newer than the first read: drop it
  // (and its retries) rather than paint over them.
  const dropFirstLoad = useCallback(() => {
    firstLoadRef.current?.stop();
    setLoadFailed(false);
  }, []);

  // The inbox's HR team, which narrows a lead's Owner choices. Only a
  // lead or an admin picks others, so nobody else pays for the read. The
  // list is kept with the inbox it was read for, so a switch to a chat
  // in the other inbox never shows the old team; until it is read (or
  // when the read fails) the choices stay at the owner and Unassigned.
  const rowInboxForTeam = row?.inbox ?? null;
  const picksOthers =
    roles !== null &&
    rowInboxForTeam !== null &&
    (roles.admin || roles[rowInboxForTeam] === 'lead');
  useEffect(() => {
    if (!picksOthers || !rowInboxForTeam) return;
    let alive = true;
    void createClient()
      .from('hr_team_members')
      .select('user_id')
      .eq('inbox', rowInboxForTeam)
      .then(({ data, error }) => {
        if (!alive || error) return;
        setTeam({
          inbox: rowInboxForTeam,
          ids: new Set(
            ((data as { user_id: string }[] | null) ?? []).map((m) => m.user_id)
          ),
        });
      });
    return () => {
      alive = false;
    };
  }, [picksOthers, rowInboxForTeam]);

  const assignableIds = useMemo(
    () =>
      assignableMembers({
        accountRole: profileLoading ? null : accountRole,
        myUserId: userId,
        profiles,
        leadableUserIds: leadable,
      }).map((p) => p.user_id),
    [profileLoading, accountRole, userId, profiles, leadable]
  );

  const changeOwner = async (next: string | null) => {
    const id = conversationId;
    setOwnerAgain(null);
    setBusy(true);
    await assignFromScreen(
      createClient(),
      { conversationId: id, expected: owner, userId: next },
      {
        patch: (_, assignedTo) => {
          if (isCurrent(id)) setOwner(assignedTo);
          onAssignChange?.(id, assignedTo);
        },
        askAgain: () => {
          if (!isCurrent(id)) return false;
          setOwnerAgain({ next });
          return true;
        },
        fail: (key) => toast.error(tRows(key, { customer: contactName })),
      }
    );
    if (isCurrent(id)) setBusy(false);
  };

  const rowRef = useRef<HrConversation | null>(null);
  useEffect(() => {
    rowRef.current = row;
  }, [row]);

  // A close waiting for confirmation belongs to the row it was asked on:
  // a move to the other inbox, or someone else closing it, drops it.
  const rowInbox = row?.inbox;
  const rowClosed = row?.closed_at ?? null;
  useEffect(() => {
    setPendingClose(null);
  }, [rowInbox, rowClosed]);

  // Live: another person's write (or a rule's flag) lands here too. A
  // catch-up read in flight may be older than it, so it is dropped.
  const liveRef = useRef<LiveRead | null>(null);
  const onChangeRef = useRef<(next: HrConversation | null) => void>(() => {});
  useEffect(() => {
    onChangeRef.current = (next) => {
      if (!isCurrent(conversationId)) return;
      liveRef.current?.changed();
      // A first read still on its way is older than this: asked again,
      // for the row alone does not open the panel.
      firstLoadRef.current?.retry();
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
    // After a gap in realtime: what the first load read. A failed read
    // leaves the panel as it is.
    const live = startCatchUp(
      async () => {
        const read = await readHr(conversationId);
        const error = read.rowRes.error ?? read.historyRes.error;
        if (error) throw error;
        return read;
      },
      (read) => {
        dropFirstLoad();
        show(conversationId, read);
      }
    );
    liveRef.current = live;
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
      .subscribe(live.onStatus);
    return () => {
      live.stop();
      liveRef.current = null;
      void sb.removeChannel(channel);
    };
  }, [conversationId, hasAccess, show, dropFirstLoad]);

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
      liveRef.current?.changed();
      dropFirstLoad();
      setRow(res.data);
      setFurthest((f) => laterStage(f, res.data.stage_key));
      // Rules open tasks on stage and topic changes.
      void loadTasks(id);
      return true;
    },
    [conversationId, isCurrent, loadTasks, dropFirstLoad, t]
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
      if (ask.kind === 'reopen') setPendingClose(null);
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

  if (
    !loaded &&
    loadFailed &&
    roles &&
    showHrPanel(roles, inboxDepartment, false)
  )
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">{t('panel.loadFailed')}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setLoadFailed(false);
            firstLoadRef.current?.retry();
          }}
        >
          {t('panel.retry')}
        </Button>
      </div>
    );
  if (!roles || !showHrPanel(roles, inboxDepartment, row !== null) || !loaded)
    return null;

  const kinds = row ? [] : openKinds(roles);
  if (!row && kinds.length === 0) return null;

  const actions = row ? panelActions(row, roles) : null;
  const steps = row ? stepperSteps(row, roles, furthest) : [];
  const stageLabel = (s: HrStage) => t(`stage.${s}`);

  const nameOf = (id: string) =>
    profiles.find((p) => p.user_id === id)?.full_name || t('pane.unknownOwner');
  const ownerChoices = row
    ? hrOwnerChoices({
        roles,
        inbox: row.inbox,
        myUserId: userId,
        ownerId: owner,
        assignable: assignableIds,
        teamUserIds: team && team.inbox === row.inbox ? team.ids : null,
      })
    : null;

  const confirmClose = async () => {
    if (!row || !pendingClose) return;
    const ok = await run(() =>
      hrClose(
        sb(),
        conversationId,
        outcomeToSend(row, pendingClose.outcome ?? '')
      )
    );
    if (ok) setPendingClose(null);
  };

  return (
    <HrPanelView
      contactName={contactName}
      busy={busy}
      row={row}
      kinds={kinds}
      actions={actions}
      steps={steps}
      tasks={tasks}
      tasksFailed={tasksFailed}
      onRetryTasks={() => void loadTasks(conversationId)}
      doneBusy={doneBusy}
      pendingClose={pendingClose}
      onOpen={(kind) => void open(kind)}
      onTopic={(topic) => void setTopic(topic)}
      onPickStage={pickStage}
      onFlag={(flag, on) =>
        void run(() => hrSetFlag(sb(), conversationId, flag, on))
      }
      onAskClose={setPendingClose}
      onConfirmClose={() => void confirmClose()}
      onReopen={() => {
        setReason('');
        setAsk({ kind: 'reopen' });
      }}
      onTaskDone={(task) => void markDone(task)}
      ownerId={owner}
      ownerName={owner ? nameOf(owner) : null}
      ownerOptions={
        ownerChoices
          ? ownerChoices.userIds.map((id) => ({ userId: id, name: nameOf(id) }))
          : null
      }
      ownerUnassign={ownerChoices?.unassigned ?? false}
      onOwner={(next) => void changeOwner(next)}
    >
      {row?.inbox === 'recruiter' && (
        <>
          <HrAgentDrafts
            conversationId={conversationId}
            canAct={mayActOnDrafts(roles)}
            closedAt={row.closed_at}
          />
          <HrAutomsgConsent
            conversationId={conversationId}
            canAct={mayActOnDrafts(roles)}
          />
        </>
      )}

      <AssignConfirmDialog
        open={ownerAgain !== null}
        customer={contactName}
        currentId={owner}
        currentName={owner ? nameOf(owner) : ''}
        nextId={ownerAgain?.next ?? null}
        nextName={ownerAgain?.next ? nameOf(ownerAgain.next) : ''}
        meanwhile
        onCancel={() => setOwnerAgain(null)}
        onConfirm={() => void changeOwner(ownerAgain?.next ?? null)}
      />

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
    </HrPanelView>
  );
}
