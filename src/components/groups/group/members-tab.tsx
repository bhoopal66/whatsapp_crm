'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Loader2, MoreVertical, UserPlus } from 'lucide-react';
import { toast } from 'sonner';

import { MemberPicker } from '@/components/groups/member-picker';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import { useAccountNumbers } from '@/hooks/use-whatsapp-numbers';
import {
  reasonKey,
  removalFailed,
  summarizeAddMembers,
  type AddMembersSummary,
} from '@/lib/groups/group-page';
import {
  formatWaId,
  GROUP_MEMBERS_PER_OPERATION,
  mergeMembers,
  parsePhoneList,
  type PickedContact,
} from '@/lib/groups/ui';
import { GROUP_ADD_POLICY } from '@/lib/groups/limits';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';

import type { GroupDetail, GroupTabProps } from '../group-page';

type Participant = GroupDetail['participants'][number];

/** The Members tab: who is in the group, add people, admins, removal. */
export function MembersTab({
  groupId,
  detail,
  reload,
  onTabChange,
}: GroupTabProps) {
  const t = useTranslations('Groups.page');
  const m = useTranslations('Groups.page.membersTab');
  const numbers = useAccountNumbers();
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<Participant | null>(null);

  const blocked = detail.blocks.members;
  const blockedText = blocked ? t(`reasons.${reasonKey(blocked)}`) : null;

  // Our own number: the channel's connected phone (Whapi keeps it in waba_id).
  const ownWaId = useMemo(() => {
    const ch = numbers?.find((n) => n.id === detail.group.channel_id);
    return ch?.waba_id ? normalizePhone(ch.waba_id) || null : null;
  }, [numbers, detail.group.channel_id]);

  const nameOf = (p: Participant) => p.contact_name || formatWaId(p.wa_id);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    return detail.participants.filter(
      (p) =>
        !q ||
        (p.contact_name ?? '').toLowerCase().includes(q) ||
        (digits.length > 0 && p.wa_id.includes(digits))
    );
  }, [detail.participants, search]);

  const failed = async (res: Response) => {
    const body = (await res.json().catch(() => null)) as {
      code?: string;
    } | null;
    toast.error(t(`reasons.${reasonKey(body?.code)}`));
  };

  const changeRole = async (p: Participant, role: 'admin' | 'member') => {
    try {
      const res = await fetch(`/api/whatsapp/groups/${groupId}/participants`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ waIds: [p.wa_id], role }),
      });
      if (!res.ok) return await failed(res);
      toast.success(
        m(role === 'admin' ? 'toastMadeAdmin' : 'toastRemovedAdmin', {
          name: nameOf(p),
        })
      );
      await reload();
    } catch {
      toast.error(t('reasons.unknown'));
    }
  };

  const remove = async (p: Participant) => {
    setRemoving(null);
    try {
      const res = await fetch(`/api/whatsapp/groups/${groupId}/participants`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ waIds: [p.wa_id] }),
      });
      if (!res.ok) return await failed(res);
      // 200 even when WhatsApp refused: `failed` names who is still in.
      const json = (await res.json().catch(() => null)) as unknown;
      if (removalFailed(json))
        toast.error(m('toastRemoveFailed', { name: nameOf(p) }));
      else toast.success(m('toastRemoved', { name: nameOf(p) }));
      await reload();
    } catch {
      toast.error(t('reasons.unknown'));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          value={search}
          aria-label={m('searchLabel')}
          placeholder={m('search')}
          onChange={(e) => setSearch(e.target.value)}
          className="min-w-0 flex-1 basis-48"
        />
        <Button disabled={!!blocked} onClick={() => setAddOpen(true)}>
          <UserPlus className="size-4" />
          {m('add')}
        </Button>
      </div>
      {blockedText && (
        <p className="text-muted-foreground text-xs">
          {m('blockedHint', { reason: blockedText })}
        </p>
      )}
      <p className="text-muted-foreground text-xs tabular-nums">
        {m('count', { count: detail.participants.length })}
      </p>

      {detail.participants.length === 0 ? (
        <p className="text-muted-foreground text-sm">{m('none')}</p>
      ) : shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">{m('noMatches')}</p>
      ) : (
        <ul className="border-border divide-border min-h-0 flex-1 divide-y overflow-y-auto rounded-lg border">
          {shown.map((p) => {
            const own = ownWaId !== null && p.wa_id === ownWaId;
            const isAdmin = p.role !== 'member';
            return (
              <li
                key={p.wa_id}
                className="flex items-center gap-2 px-3 py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {p.contact_id ? (
                      <Link
                        href={`/contacts/${p.contact_id}`}
                        className="min-w-0 truncate font-medium hover:underline"
                      >
                        {nameOf(p)}
                      </Link>
                    ) : (
                      <span className="min-w-0 truncate font-medium">
                        {formatWaId(p.wa_id)}
                      </span>
                    )}
                    {own && <Badge variant="outline">{m('thisNumber')}</Badge>}
                    {isAdmin && (
                      <Badge variant="secondary">
                        {p.role === 'superadmin'
                          ? m('roleSuperadmin')
                          : m('roleAdmin')}
                      </Badge>
                    )}
                  </div>
                  {p.contact_name && (
                    <p className="text-muted-foreground truncate text-xs">
                      {formatWaId(p.wa_id)}
                    </p>
                  )}
                </div>
                {!own && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={m('actions', { name: nameOf(p) })}
                      title={blockedText ?? undefined}
                      disabled={!!blocked}
                      className={buttonVariants({
                        variant: 'ghost',
                        size: 'icon-sm',
                      })}
                    >
                      <MoreVertical className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {p.role === 'member' ? (
                        <DropdownMenuItem
                          onClick={() => void changeRole(p, 'admin')}
                        >
                          {m('makeAdmin')}
                        </DropdownMenuItem>
                      ) : p.role === 'admin' ? (
                        <DropdownMenuItem
                          onClick={() => void changeRole(p, 'member')}
                        >
                          {m('removeAdmin')}
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setRemoving(p)}
                      >
                        {m('remove')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {addOpen && (
        <AddMembersDialog
          groupId={groupId}
          onClose={() => setAddOpen(false)}
          onAdded={() => void reload()}
          onInvite={() => {
            setAddOpen(false);
            onTabChange?.('invite');
          }}
        />
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={m('removeTitle', { name: removing ? nameOf(removing) : '' })}
        description={m('removeBody', { group: detail.group.name })}
        cancelLabel={m('cancel')}
        confirmLabel={m('removeConfirm')}
        onConfirm={() => removing && void remove(removing)}
        destructive
      />
    </div>
  );
}

function AddMembersDialog({
  groupId,
  onClose,
  onAdded,
  onInvite,
}: {
  groupId: string;
  onClose: () => void;
  onAdded: () => void;
  onInvite: () => void;
}) {
  const t = useTranslations('Groups.page');
  const m = useTranslations('Groups.page.membersTab');
  const { accountId } = useAuth();
  const [contacts, setContacts] = useState<PickedContact[]>([]);
  const [typedText, setTypedText] = useState('');
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<AddMembersSummary | null>(null);

  const typed = useMemo(() => parsePhoneList(typedText), [typedText]);
  const merged = useMemo(
    () => mergeMembers(contacts, typed),
    [contacts, typed]
  );
  const count = merged.members.length;
  const canSubmit = count > 0 && count <= GROUP_MEMBERS_PER_OPERATION && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/whatsapp/groups/${groupId}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phones: merged.members.filter((x) => !x.contactId).map((x) => x.waId),
          contactIds: merged.members
            .map((x) => x.contactId)
            .filter((x): x is string => !!x),
        }),
      });
      const json = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        const code = (json as { code?: string } | null)?.code;
        toast.error(t(`reasons.${reasonKey(code)}`));
        return;
      }
      const s = summarizeAddMembers(json);
      setSummary(s);
      if (s.added.length > 0) {
        toast.success(m('toastAdded', { count: s.added.length }));
        onAdded();
      }
    } catch {
      toast.error(t('reasons.unknown'));
    } finally {
      setBusy(false);
    }
  };

  const list = (items: string[]) => (
    <ul className="space-y-0.5">
      {items.map((w) => (
        <li key={w} className="truncate">
          {formatWaId(w)}
        </li>
      ))}
    </ul>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m('addTitle')}</DialogTitle>
          <DialogDescription>{m('addDescription')}</DialogDescription>
        </DialogHeader>
        {summary ? (
          <div className="space-y-4 text-sm">
            {summary.added.length === 0 ? (
              <p className="text-muted-foreground">{m('resultNone')}</p>
            ) : (
              <section className="space-y-1">
                <h3 className="text-wa-green font-semibold">
                  {m('resultAdded', { count: summary.added.length })}
                </h3>
                <div className="text-muted-foreground">
                  {list(summary.added)}
                </div>
              </section>
            )}
            {summary.needInvite.length > 0 && (
              <section className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900 [[data-mode=dark]_&]:border-amber-900 [[data-mode=dark]_&]:bg-amber-950 [[data-mode=dark]_&]:text-amber-200">
                <h3 className="font-semibold">
                  {m('resultNeedInvite', { count: summary.needInvite.length })}
                </h3>
                {list(summary.needInvite)}
                <p className="text-xs">{m('resultNeedInviteNote')}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onInvite}
                >
                  {m('openInvite')}
                </Button>
              </section>
            )}
            {summary.skipped.length > 0 && (
              <section className="space-y-1">
                <h3 className="font-semibold">
                  {m('resultSkipped', { count: summary.skipped.length })}
                </h3>
                <div className="text-muted-foreground">
                  {list(summary.skipped)}
                </div>
                <p className="text-muted-foreground text-xs">
                  {m('resultSkippedNote')}
                </p>
              </section>
            )}
            {summary.invalid.length > 0 && (
              <section className="text-destructive space-y-1">
                <h3 className="font-semibold">
                  {m('resultInvalid', { count: summary.invalid.length })}
                </h3>
                {list(summary.invalid)}
              </section>
            )}
            {summary.error && (
              <p className="text-destructive text-xs">
                {m('stoppedEarly', {
                  reason: t(`reasons.${summary.error}`),
                })}
              </p>
            )}
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                {m('done')}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <MemberPicker
              accountId={accountId}
              contacts={contacts}
              typedText={typedText}
              onContactsChange={setContacts}
              onTypedTextChange={setTypedText}
              merged={merged}
              typedInvalid={typed.filter((x) => !x.waId)}
            />
            <p className="text-muted-foreground text-xs">
              {m('antiBan', {
                batch: GROUP_ADD_POLICY.batchSize,
                seconds: GROUP_ADD_POLICY.pauseMs / 1000,
                max: GROUP_ADD_POLICY.maxPerOperation,
              })}
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {m('cancel')}
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                {busy ? m('adding') : m('addSubmit')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
