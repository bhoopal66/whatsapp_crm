'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { ManagersPicker } from '@/components/groups/managers-picker';
import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings, hasMinRole } from '@/lib/auth/roles';
import { reasonKey } from '@/lib/groups/group-page';

import type { GroupTabProps } from '../group-page';

interface Manager {
  userId: string;
  name: string;
  isCreator: boolean;
}

/** The Managers tab: who works this group alongside its creator. */
export function ManagersTab({ groupId, detail, reload }: GroupTabProps) {
  const t = useTranslations('Groups.page');
  const m = useTranslations('Groups.page.managersTab');
  const { user, accountRole } = useAuth();
  const { members } = useWorkspaceMembers();
  const url = `/api/whatsapp/groups/${groupId}/managers`;
  const [managers, setManagers] = useState<Manager[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const creatorId = detail.group.created_by;
  const editable =
    (!!accountRole && canEditSettings(accountRole)) || creatorId === user?.id;

  const apply = (list: Manager[]) => {
    setManagers(list);
    setSelected(list.filter((x) => !x.isCreator).map((x) => x.userId));
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as { managers: Manager[] };
        if (!cancelled) apply(json.managers);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: selected }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;
        toast.error(t(`reasons.${reasonKey(body?.code)}`));
        return;
      }
      const json = (await res.json().catch(() => null)) as {
        managers?: Manager[];
      } | null;
      if (json?.managers) apply(json.managers);
      toast.success(m('saved'));
      void reload();
    } catch {
      toast.error(t('reasons.unknown'));
    } finally {
      setSaving(false);
    }
  };

  if (failed) {
    return (
      <p className="text-muted-foreground p-2 text-sm">{m('loadFailed')}</p>
    );
  }
  if (!managers) {
    return <div className="bg-muted h-24 animate-pulse rounded-lg" aria-busy />;
  }

  const staff = members
    .filter(
      (p) =>
        p.user_id !== creatorId &&
        !!p.account_role &&
        hasMinRole(p.account_role, 'agent')
    )
    .map((p) => ({ id: p.user_id, name: p.full_name || p.email }));
  const dirty =
    selected.length !== managers.filter((x) => !x.isCreator).length ||
    selected.some((id) => !managers.some((x) => x.userId === id));

  return (
    <div className="max-w-xl space-y-4">
      <p className="text-muted-foreground text-sm">{m('about')}</p>
      <ul className="divide-border border-border divide-y rounded-lg border">
        {managers.map((x) => (
          <li key={x.userId} className="flex items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm">
              {x.name || m('unnamed')}
            </span>
            {x.isCreator && <Badge variant="secondary">{m('creator')}</Badge>}
          </li>
        ))}
      </ul>
      {editable ? (
        <>
          <ManagersPicker
            staff={staff}
            selected={selected}
            onChange={setSelected}
          />
          <p className="text-muted-foreground text-xs">{m('creatorKept')}</p>
          <Button disabled={!dirty || saving} onClick={() => void save()}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {m('save')}
          </Button>
        </>
      ) : null}
    </div>
  );
}
