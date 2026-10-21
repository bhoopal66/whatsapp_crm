'use client';

// Ring groups and call queues, Linkus-style. Reads GET /api/pbx/groups
// on mount, every 15 s while the tab is visible, and after each queue
// action. The caller's own Log in / Pause posts without an extension;
// a manager's buttons on someone else's row post theirs. Every rule
// about the payload (parsing, states, offered actions, order, error
// wording) is in lib/pbx/groups.ts.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Headset, RefreshCw, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  ACTION_KEYS,
  agentActions,
  agentChip,
  displayName,
  errorCode,
  actionErrorKey,
  isEmptyGroups,
  loadErrorKey,
  myQueueState,
  parseGroupsPayload,
  sortAgents,
  strategyKey,
  type Chip,
  type GroupsPayload,
  type QueueAction,
  type QueueView,
  type RingGroupView,
  type Tone,
} from '@/lib/pbx/groups';
import { CallButton } from './call-button';

const POLL_MS = 15_000;

const TONE_CLASS: Record<Tone, string> = {
  green: 'bg-success-soft text-success',
  amber: 'bg-warning-soft text-warning',
  red: 'bg-destructive-soft text-destructive',
  blue: 'bg-info-soft text-info',
  muted: 'bg-muted text-muted-foreground',
};

type Act = (
  queueId: number,
  action: QueueAction,
  extension?: string
) => Promise<void>;

export function GroupsPanel() {
  const t = useTranslations('PbxGroups');
  const [data, setData] = useState<GroupsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // Only the latest load may write: a slow poll must not undo an action.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const res = await fetch('/api/pbx/groups', { cache: 'no-store' });
      const body: unknown = await res.json().catch(() => null);
      if (n !== seq.current) return;
      if (!res.ok) {
        setLoadError(loadErrorKey(errorCode(body)));
        return;
      }
      setData(parseGroupsPayload(body));
      setLoadError(null);
    } catch {
      if (n === seq.current) setLoadError('loadFailed');
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const act: Act = async (queueId, action, extension) => {
    setPending(`${queueId}:${extension ?? ''}:${action}`);
    try {
      const res = await fetch(`/api/pbx/queues/${queueId}/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(extension ? { action, extension } : { action }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        toast.error(t(actionErrorKey(errorCode(body))));
      }
    } catch {
      toast.error(t('errAction'));
    } finally {
      await load();
      setPending(null);
    }
  };

  const header = (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold">{t('title')}</h2>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={pending !== null}
        onClick={() => void load()}
      >
        <RefreshCw />
        {t('refresh')}
      </Button>
    </div>
  );

  if (!data)
    return (
      <div className="space-y-4">
        {header}
        {loadError ? (
          <p className="text-muted-foreground rounded-lg border p-4 text-sm">
            {t(loadError)}
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">{t('loading')}</p>
        )}
      </div>
    );

  return (
    <div className="space-y-6">
      {header}
      {loadError && (
        <p className="text-muted-foreground rounded-lg border p-3 text-sm">
          {t(loadError)}
        </p>
      )}
      {isEmptyGroups(data) ? (
        <p className="text-muted-foreground rounded-lg border p-4 text-sm">
          {t('empty')}
        </p>
      ) : (
        <>
          {data.queues.length > 0 && (
            <section className="space-y-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Headset className="size-4" />
                {t('queues')}
              </h3>
              <div className="grid gap-3 lg:grid-cols-2">
                {data.queues.map((q) => (
                  <QueueCard
                    key={q.id}
                    queue={q}
                    myExtension={data.myExtension}
                    canManage={data.canManage}
                    pending={pending}
                    act={act}
                  />
                ))}
              </div>
            </section>
          )}
          {data.queuesTruncated && (
            <p className="text-muted-foreground text-xs">{t('truncated')}</p>
          )}
          {data.ringGroups.length > 0 && (
            <section className="space-y-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Users className="size-4" />
                {t('ringGroups')}
              </h3>
              <div className="grid gap-3 lg:grid-cols-2">
                {data.ringGroups.map((g) => (
                  <RingGroupCard
                    key={g.id}
                    group={g}
                    myExtension={data.myExtension}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function StatusChip({ chip }: { chip: Chip }) {
  const t = useTranslations('PbxGroups');
  return <Badge className={TONE_CLASS[chip.tone]}>{t(chip.key)}</Badge>;
}

function QueueCard({
  queue,
  myExtension,
  canManage,
  pending,
  act,
}: {
  queue: QueueView;
  myExtension: string | null;
  canManage: boolean;
  pending: string | null;
  act: Act;
}) {
  const t = useTranslations('PbxGroups');
  const mine = myQueueState(queue, myExtension);
  const ext = (extension: string) => t('ext', { extension });
  const agents = sortAgents(queue.agents, myExtension);
  const busy = pending !== null;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{queue.name}</CardTitle>
        <CardDescription>
          {t('number', { number: queue.number })} ·{' '}
          {t('agentsCount', { count: queue.agents.length })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="bg-muted/50 flex flex-wrap items-center gap-2 rounded-lg p-2 text-sm">
          <span className="font-medium">{t('myState')}</span>
          {mine.member ? (
            <>
              <span className="text-muted-foreground">
                {mine.static
                  ? t('staticAgent')
                  : t(mine.loggedIn ? 'loggedIn' : 'loggedOut')}
                {mine.paused ? ` · ${t('pausedNote')}` : ''}
              </span>
              <span className="ml-auto flex gap-1">
                {mine.actions.map((a) => (
                  <Button
                    key={a}
                    size="xs"
                    variant={a === 'login' ? 'default' : 'outline'}
                    disabled={busy}
                    onClick={() => void act(queue.id, a)}
                  >
                    {t(ACTION_KEYS[a])}
                  </Button>
                ))}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">{t('notMember')}</span>
          )}
        </div>
        {agents.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noAgents')}</p>
        ) : (
          <ul className="divide-y text-sm">
            {agents.map((a) => {
              const isMe = a.extension === myExtension;
              const name = displayName(a, ext);
              return (
                <li
                  key={a.extension}
                  className="flex flex-wrap items-center gap-2 py-1.5"
                >
                  <span className="min-w-0 truncate font-medium">
                    {isMe ? t('you', { name }) : name}
                  </span>
                  {a.name && (
                    <span className="text-muted-foreground text-xs">
                      {ext(a.extension)}
                    </span>
                  )}
                  <StatusChip chip={agentChip(a)} />
                  <span className="ml-auto flex gap-1">
                    {agentActions(a, { canManage, isMe }).map((action) => (
                      <Button
                        key={action}
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void act(queue.id, action, a.extension)}
                      >
                        {t(ACTION_KEYS[action])}
                      </Button>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function RingGroupCard({
  group,
  myExtension,
}: {
  group: RingGroupView;
  myExtension: string | null;
}) {
  const t = useTranslations('PbxGroups');
  const ext = (extension: string) => t('ext', { extension });
  const sk = strategyKey(group.strategy);
  const members = sortAgents(group.members, myExtension);

  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle>{group.name}</CardTitle>
            <CardDescription>
              {t('number', { number: group.number })} ·{' '}
              {t('membersCount', { count: group.members.length })}
              {group.strategy && (
                <>
                  {' · '}
                  {t('strategy', { strategy: sk ? t(sk) : group.strategy })}
                </>
              )}
            </CardDescription>
          </div>
          <CallButton number={group.number} label={t('callGroup')} />
        </div>
      </CardHeader>
      <CardContent>
        {members.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noMembers')}</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5 text-sm">
            {members.map((m) => {
              const name = displayName(m, ext);
              return (
                <li key={m.extension}>
                  <Badge variant="outline">
                    {m.extension === myExtension ? t('you', { name }) : name}
                  </Badge>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
