'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { UserMinus } from 'lucide-react';
import { toast } from 'sonner';

import { useChatWorkspaceContext } from '@/components/chat/chat-context';
import { PeoplePicker } from '@/components/chat/dm-picker';
import type { RoomContext } from '@/components/deal-rooms/room-view';
import { CallButton } from '@/components/pbx/call-button';
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
import { hasMinRole } from '@/lib/auth/roles';
import { channelMembers } from '@/lib/chat/api';
import { offersParticipantCall } from '@/lib/deal-rooms/call';
import type { ChannelMember } from '@/lib/chat/types';
import {
  listedPeople,
  memberRow,
  type MemberBadge,
} from '@/lib/deal-rooms/members';
import {
  addPeopleCandidates,
  addPeopleErrorKey,
  addPeopleOptions,
  type AddPeopleKind,
} from '@/lib/deal-rooms/people-ui';
import type { StaffParticipant } from '@/lib/deal-rooms/reads';
import { ROOM_MEMBER_MAX } from '@/lib/deal-rooms/view';
import { cn } from '@/lib/utils';

/** POST a JSON body; `{ ok, body }` with the route's `error` on failure. */
async function post(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, body: json };
}

const BADGE_CLASS: Record<MemberBadge, string> = {
  consent:
    'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  guest:
    'bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300',
  pending:
    'bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200',
  invited: 'bg-muted text-muted-foreground',
  joined: 'bg-muted text-foreground',
  left: 'bg-muted text-muted-foreground',
  removed: 'bg-muted text-muted-foreground',
  rejected: 'bg-muted text-muted-foreground',
};

type Confirm =
  | { kind: 'remove'; id: string; name: string }
  | { kind: 'reset' }
  | { kind: 'close' }
  | { kind: 'cancel' };

/** The room's right column: members, requests, the link and its actions. */
export function DealRoomMembersPanel({ detail, reload }: RoomContext) {
  const t = useTranslations('Chat.rooms');
  const ws = useChatWorkspaceContext();
  const { account, workspaces, activeWorkspaceId, accountRole } = useAuth();
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [reason, setReason] = useState('');
  const [closeStep, setCloseStep] = useState<string | null>(null);
  const [adding, setAdding] = useState<AddPeopleKind | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [inRoom, setInRoom] = useState<readonly ChannelMember[]>([]);
  const { room, canManage } = detail;
  const base = `/api/deal-rooms/${room.id}`;
  const workspace =
    workspaces.find((w) => w.accountId === activeWorkspaceId)?.name ??
    account?.name ??
    '';
  const creator = room.createdBy
    ? ws.peopleById.get(room.createdBy.toLowerCase())?.fullName
    : null;
  const leader = !!accountRole && hasMinRole(accountRole, 'team_leader');
  const offer = addPeopleOptions({
    canManage,
    status: room.status,
    role: accountRole,
  });
  const open = room.status === 'open';
  const errorOf = (b: Record<string, unknown>) =>
    typeof b.error === 'string' ? b.error : t('actions.unknownError');

  const run = async (
    url: string,
    body: unknown,
    done: (b: Record<string, unknown>) => void,
    failed: (error: string, b: Record<string, unknown>) => void
  ) => {
    setBusy(true);
    try {
      const r = await post(url, body);
      if (r.ok) done(r.body);
      else failed(errorOf(r.body), r.body);
    } catch {
      failed(t('actions.unknownError'), {});
    } finally {
      setBusy(false);
      void reload();
    }
  };
  const startAdding = (kind: AddPeopleKind) => {
    setPicked([]);
    setInRoom([]);
    setAdding(kind);
    // Best-effort: who is already in the room's channel drops out of the
    // list; without it the server still skips them.
    channelMembers(ws.sb, room.channelId)
      .then(setInRoom)
      .catch(() => setInRoom([]));
  };
  const candidates = adding
    ? addPeopleCandidates(ws.people, inRoom, adding)
    : [];
  const addPeople = () => {
    if (!adding || picked.length === 0) return;
    void run(
      `${base}/people`,
      adding === 'staff' ? { staff: picked } : { guest: picked[0] },
      (b) => {
        setAdding(null);
        toast.success(t('people.added', { count: Number(b.added ?? 0) }));
        // The caller may have added themselves: their channel list too.
        void ws.reloadChannels();
      },
      (error, b) => {
        const code = addPeopleErrorKey(b.code);
        toast.error(
          code
            ? t(`people.error.${code}`, { bank: String(b.bank ?? '') })
            : t('people.failed', { error })
        );
      }
    );
  };
  const decideFailed = (error: string) =>
    toast.error(t('members.decideFailed', { error }));

  const fetchLink = async () => {
    try {
      const res = await fetch(`${base}/invite-link`, { cache: 'no-store' });
      const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || typeof b.inviteLink !== 'string')
        throw new Error(errorOf(b));
      setLink(b.inviteLink);
      return b.inviteLink;
    } catch (err) {
      toast.error(t('members.linkFailed', { error: (err as Error).message }));
      return null;
    }
  };
  const copy = async () => {
    const value = link ?? (await fetchLink());
    if (!value) return;
    await navigator.clipboard.writeText(value).catch(() => undefined);
    toast.success(t('members.copied'));
  };

  const confirmAction = () => {
    if (!confirm) return;
    if (confirm.kind === 'remove') {
      void run(
        `${base}/participants/${confirm.id}/remove`,
        undefined,
        () => toast.success(t('members.removed', { name: confirm.name })),
        (error) =>
          toast.error(t('members.removeFailed', { name: confirm.name, error }))
      );
      setConfirm(null);
    } else if (confirm.kind === 'reset') {
      void run(
        `${base}/invite-link/reset`,
        undefined,
        (b) => {
          setLink(typeof b.inviteLink === 'string' ? b.inviteLink : null);
          toast.success(t('actions.resetDone'));
        },
        (error) => toast.error(t('actions.resetFailed', { error }))
      );
      setConfirm(null);
    } else if (confirm.kind === 'cancel') {
      void run(
        `${base}/cancel`,
        { reason: reason.trim() || null },
        () => toast.success(t('actions.cancelRoomDone')),
        (error, b) =>
          toast.error(
            // The group arrived meanwhile and opened the room.
            b.code === 'room_not_creating'
              ? t('actions.cancelRoomTooLate')
              : t('actions.cancelRoomFailed', { error })
          )
      );
      setConfirm(null);
    } else {
      void run(
        `${base}/close`,
        { reason: reason.trim() || null },
        () => {
          setCloseStep(null);
          setConfirm(null);
          toast.success(t('actions.closed'));
        },
        (error, b) => {
          if (b.code === 'close_incomplete' && typeof b.step === 'string') {
            setCloseStep(b.step);
          } else {
            setConfirm(null);
            toast.error(t('actions.closeFailed', { error }));
          }
        }
      );
    }
  };

  const people = listedPeople(detail.participants);
  return (
    <aside className="bg-background flex w-full shrink-0 flex-col overflow-y-auto border-l p-4 text-sm lg:w-[320px]">
      <div className="flex items-baseline justify-between">
        <h3 className="font-semibold">{t('members.title')}</h3>
        <span className="text-muted-foreground text-xs">
          {t('members.count', {
            count: room.participantCount,
            max: ROOM_MEMBER_MAX,
          })}
        </span>
      </div>
      <ul className="mt-3 space-y-2">
        <li>
          <p className="font-semibold">{workspace}</p>
          <p className="text-muted-foreground text-xs">
            {creator
              ? t('members.business', { name: creator })
              : t('members.businessPlain')}
          </p>
        </li>
        {people.map((p) => {
          const row = memberRow(p, canManage && open);
          const roleText =
            row.role === 'bank'
              ? row.bank
                ? t('members.role.bank', { bank: row.bank })
                : t('members.role.bankUnknown')
              : t(`members.role.${row.role}`);
          return (
            <li key={p.id} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{p.displayName}</p>
                <p className="text-muted-foreground truncate text-xs">
                  {[roleText, row.phone].filter(Boolean).join(' · ')}
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {row.badges.map((b) => (
                    <span
                      key={b}
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-medium',
                        BADGE_CLASS[b]
                      )}
                    >
                      {t(`members.badge.${b}`)}
                    </span>
                  ))}
                </div>
              </div>
              {offersParticipantCall(accountRole, p, room.status) && (
                <CallButton participantId={p.id} size="xs" />
              )}
              {row.removable && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('members.menu', { name: p.displayName })}
                  title={t('members.remove')}
                  disabled={busy}
                  onClick={() =>
                    setConfirm({
                      kind: 'remove',
                      id: p.id,
                      name: p.displayName,
                    })
                  }
                >
                  <UserMinus className="size-4" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {canManage && (detail.joinRequests?.length ?? 0) > 0 && (
        <section className="mt-4">
          <h4 className="text-xs font-semibold uppercase">
            {t('members.requests')}
          </h4>
          {detail.joinRequests!.map((q) => (
            <div key={q.id} className="mt-2 flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs">
                {t('members.requestFrom', {
                  phone: q.waId ?? t('members.someone'),
                })}
              </span>
              {(['approve', 'reject'] as const).map((d) => (
                <Button
                  key={d}
                  size="sm"
                  variant={d === 'approve' ? 'default' : 'outline'}
                  disabled={busy}
                  onClick={() =>
                    void run(
                      `${base}/join-requests`,
                      d === 'approve'
                        ? { approve: [q.joinRequestId], reject: [] }
                        : { approve: [], reject: [q.joinRequestId] },
                      () => undefined,
                      decideFailed
                    )
                  }
                >
                  {t(`members.${d}`)}
                </Button>
              ))}
            </div>
          ))}
        </section>
      )}

      {canManage && (detail.pendingApprovals?.length ?? 0) > 0 && (
        <section className="mt-4">
          <h4 className="text-xs font-semibold uppercase">
            {t('members.pendingGuests')}
          </h4>
          {!leader && (
            <p className="text-muted-foreground mt-1 text-xs">
              {t('members.pendingHelp')}
            </p>
          )}
          {detail.pendingApprovals!.map((p: StaffParticipant) => (
            <div key={p.id} className="mt-2 flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs">
                {p.displayName} · {p.bankCode}
              </span>
              {leader &&
                (['approve', 'reject'] as const).map((d) => (
                  <Button
                    key={d}
                    size="sm"
                    variant={d === 'approve' ? 'default' : 'outline'}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        `/api/deal-room-participants/${p.id}/approve`,
                        { approve: d === 'approve' },
                        () => undefined,
                        decideFailed
                      )
                    }
                  >
                    {t(`members.${d}`)}
                  </Button>
                ))}
            </div>
          ))}
        </section>
      )}

      {canManage && (
        <section className="mt-4 space-y-2">
          <h4 className="text-xs font-semibold uppercase">
            {t('members.inviteLink')}
          </h4>
          <div className="flex gap-2">
            <input
              readOnly
              aria-label={t('members.inviteLink')}
              value={link ?? ''}
              placeholder={t('members.showLink')}
              onFocus={() => void (link ?? fetchLink())}
              className="bg-muted min-w-0 flex-1 rounded-md border px-2 py-1 text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => void copy()}
              disabled={!open}
            >
              {t('members.copy')}
            </Button>
          </div>
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked
              readOnly
              disabled
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">{t('members.approveEach')}</span>
              <span className="text-muted-foreground block">
                {t('members.approveEachHelp')}
              </span>
            </span>
          </label>
          <p className="text-muted-foreground text-xs">
            {t('members.linkHelp', { workspace })}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !open}
            onClick={() =>
              void run(
                `${base}/invites`,
                undefined,
                (b) =>
                  toast.success(
                    t('members.resent', {
                      sent: Number(b.sent ?? 0),
                      failed: Number(b.failed ?? 0),
                    })
                  ),
                (error) => toast.error(t('members.resendFailed', { error }))
              )
            }
          >
            {t('members.resend')}
          </Button>
        </section>
      )}

      {offer.staff && (
        <section className="mt-4 space-y-2">
          <h4 className="text-xs font-semibold uppercase">
            {t('people.title')}
          </h4>
          <p className="text-muted-foreground text-xs">{t('people.help')}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => startAdding('staff')}
            >
              {t('people.addStaff')}
            </Button>
            {offer.guest && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => startAdding('guest')}
              >
                {t('people.addGuest')}
              </Button>
            )}
          </div>
        </section>
      )}

      {canManage && room.status !== 'closed' && (
        <section className="mt-4 space-y-2 border-t pt-4">
          <h4 className="text-xs font-semibold uppercase">
            {t('actions.title')}
          </h4>
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            disabled={busy || !room.dealId}
            onClick={() =>
              void run(
                `${base}/transcript`,
                undefined,
                (b) =>
                  toast.success(
                    t('actions.transcriptSaved', { name: String(b.name ?? '') })
                  ),
                (error) => toast.error(t('actions.transcriptFailed', { error }))
              )
            }
          >
            {t('actions.transcript')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            disabled={busy || !open}
            onClick={() => setConfirm({ kind: 'reset' })}
          >
            {t('actions.reset')}
          </Button>
          {room.status === 'creating' ? (
            <Button
              size="sm"
              variant="outline"
              className="border-destructive text-destructive w-full"
              disabled={busy}
              onClick={() => setConfirm({ kind: 'cancel' })}
            >
              {t('actions.cancelRoom')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="border-destructive text-destructive w-full"
              disabled={busy}
              onClick={() => setConfirm({ kind: 'close' })}
            >
              {t('actions.close')}
            </Button>
          )}
        </section>
      )}

      <Dialog
        open={confirm !== null}
        onOpenChange={(o) => !o && !busy && setConfirm(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === 'remove'
                ? t('members.removeTitle', { name: confirm.name })
                : confirm?.kind === 'reset'
                  ? t('actions.resetTitle')
                  : confirm?.kind === 'cancel'
                    ? t('actions.cancelRoomTitle')
                    : t('actions.closeTitle')}
            </DialogTitle>
            <DialogDescription>
              {confirm?.kind === 'remove'
                ? t('members.removeBody')
                : confirm?.kind === 'reset'
                  ? t('actions.resetBody')
                  : confirm?.kind === 'cancel'
                    ? t('actions.cancelRoomBody')
                    : t('actions.closeBody')}
            </DialogDescription>
          </DialogHeader>
          {(confirm?.kind === 'close' || confirm?.kind === 'cancel') && (
            <>
              <textarea
                aria-label={t('actions.closeReason')}
                placeholder={t('actions.closeReason')}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="bg-card dark:bg-background min-h-16 rounded-md border px-2 py-1 text-sm"
              />
              {closeStep && (
                <p role="alert" className="text-destructive text-xs">
                  {t('actions.closeIncomplete', { step: closeStep })}
                </p>
              )}
            </>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={confirmAction}
            >
              {confirm?.kind === 'remove'
                ? t('members.remove')
                : confirm?.kind === 'reset'
                  ? t('actions.resetConfirm')
                  : confirm?.kind === 'cancel'
                    ? t('actions.cancelRoomConfirm')
                    : closeStep
                      ? t('actions.retry')
                      : t('actions.closeConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={adding !== null}
        onOpenChange={(o) => !o && !busy && setAdding(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {adding === 'guest'
                ? t('people.guestTitle')
                : t('people.staffTitle')}
            </DialogTitle>
            <DialogDescription>
              {adding === 'guest'
                ? t('people.guestBody')
                : t('people.staffBody')}
            </DialogDescription>
          </DialogHeader>
          <PeoplePicker
            candidates={candidates}
            picked={picked}
            onChange={setPicked}
            max={adding === 'guest' ? 1 : undefined}
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setAdding(null)}
            >
              {t('actions.cancel')}
            </Button>
            <Button disabled={busy || picked.length === 0} onClick={addPeople}>
              {t('people.add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
