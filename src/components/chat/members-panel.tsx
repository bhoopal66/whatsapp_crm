'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  Check,
  LogOut,
  MoreHorizontal,
  ShieldCheck,
  ShieldOff,
  UserPlus,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { useAuth } from '@/hooks/use-auth';
import {
  addMembers,
  channelMembers,
  leaveChannel,
  setMemberRole,
  type ChannelMember,
  type ChatPerson,
} from '@/lib/chat';
import { filterPeople, togglePick } from '@/lib/chat/compose';
import {
  addRules,
  isGuestPerson,
  leaveBlock,
  roleChange,
  sortMembers,
  type ChannelCtx,
} from '@/lib/chat/membership';
import { addPickerRows, type PickRow } from '@/lib/chat/panels';
import {
  avatarTint,
  initialOf,
  presenceDot,
  roleLabelKey,
} from '@/lib/chat/view';
import { cn } from '@/lib/utils';

import { useChatWorkspaceContext } from './chat-context';
import { PresenceDot } from './presence-dot';

const GUEST_CHIP =
  'rounded-full bg-violet-100 px-1.5 text-[11px] font-semibold text-violet-700 [[data-mode=dark]_&]:bg-violet-500/20 [[data-mode=dark]_&]:text-violet-200';
const ADMIN_BADGE =
  'shrink-0 rounded-full bg-emerald-50 px-1.5 text-[11px] font-semibold text-[#0E7C5A] [[data-mode=dark]_&]:bg-emerald-500/15 [[data-mode=dark]_&]:text-emerald-300';
const ICON_BUTTON =
  'hover:bg-muted flex size-7 shrink-0 items-center justify-center rounded-md';
const BLOCK_KEY = {
  guestTeam: 'members.blockGuestTeam',
  guestRole: 'members.blockGuestRole',
  staffRole: 'members.blockStaffRole',
} as const;

export interface MembersPanelProps {
  channelId: string;
  onClose: () => void;
  /** The viewer left the channel. */
  onLeft: () => void;
}

function Avatar({ person, userId }: { person?: ChatPerson; userId: string }) {
  return (
    <span
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold',
        avatarTint(userId)
      )}
    >
      {initialOf(person?.fullName)}
    </span>
  );
}

/**
 * The right column (a full-screen sheet below lg): who is in the
 * channel and, where the rules of lib/chat/membership allow, adding
 * people, changing roles and leaving. The members are re-read whenever
 * the workspace reloads its channel list, which it does on every
 * realtime membership change and after each change made here.
 */
export function MembersPanel({
  channelId,
  onClose,
  onLeft,
}: MembersPanelProps) {
  const t = useTranslations('Chat');
  const tRole = useTranslations('Sidebar');
  const ws = useChatWorkspaceContext();
  const { sb, fail, reloadChannels, people, peopleById, userId, channels } = ws;
  const { accountRole } = useAuth();
  const channel = channels?.find((c) => c.id === channelId) ?? null;
  const [members, setMembers] = useState<ChannelMember[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // Presence dots go stale by time alone, so the clock ticks.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let off = false;
    channelMembers(sb, channelId)
      .then((list) => !off && setMembers(list))
      .catch((err) => !off && fail(err));
    return () => {
      off = true;
    };
    // `channels` changes on every reload: the re-read trigger.
  }, [sb, channelId, fail, channels]);

  const me = userId?.toLowerCase() ?? '';
  const myRole = members
    ? (members.find((m) => m.userId.toLowerCase() === me)?.role ?? null)
    : (channel?.membership?.role ?? null);
  const ctx: ChannelCtx | null = channel
    ? {
        kind: channel.kind,
        archived: !!channel.archivedAt,
        myRole,
        accountRole,
      }
    : null;
  const roster = { members: members ?? [], peopleById };
  const rules = ctx ? addRules(ctx) : null;
  const sorted = useMemo(
    () => (members ? sortMembers(members, peopleById) : []),
    [members, peopleById]
  );
  const pickRows =
    adding && rules && channel
      ? addPickerRows(people, members ?? [], rules, channel.kind)
      : [];
  const nameOf = (id: string) =>
    peopleById.get(id.toLowerCase())?.fullName ?? t('unknownPerson');

  const changeRole = async (m: ChannelMember, to: 'admin' | 'member') => {
    try {
      await setMemberRole(sb, { channelId, userId: m.userId, role: to });
      toast.success(
        t(to === 'admin' ? 'members.madeAdmin' : 'members.madeMember', {
          name: nameOf(m.userId),
        })
      );
      void reloadChannels();
    } catch (err) {
      fail(err);
    }
  };
  const leave = async () => {
    setLeaving(false);
    try {
      await leaveChannel(sb, channelId);
      toast.success(t('members.left'));
      void reloadChannels();
      onLeft();
    } catch (err) {
      fail(err);
    }
  };

  const row = (m: ChannelMember) => {
    const person = peopleById.get(m.userId.toLowerCase());
    const mine = m.userId.toLowerCase() === me;
    const guest = m.role === 'guest' || isGuestPerson(person);
    const roleKey = roleLabelKey(person?.role);
    const change = ctx ? roleChange(m, { ...ctx, ...roster }) : null;
    const leaveWhy =
      mine && ctx
        ? leaveBlock({ kind: ctx.kind, myRole, userId: me, ...roster })
        : 'notMember';
    const name = person?.fullName ?? t('unknownPerson');
    return (
      <li key={m.userId} className="flex items-center gap-3 px-4 py-2">
        <span className="relative shrink-0">
          <Avatar person={person} userId={m.userId} />
          <PresenceDot
            state={presenceDot(person, now)}
            className="border-muted-foreground/60 ring-background absolute -right-0.5 -bottom-0.5 ring-2"
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm">
            <span className="truncate font-semibold">{name}</span>
            {mine && (
              <span className="text-muted-foreground shrink-0 text-xs">
                {t('members.you')}
              </span>
            )}
            {m.role === 'admin' && (
              <span className={ADMIN_BADGE}>{t('members.admin')}</span>
            )}
          </p>
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
            {guest && <span className={GUEST_CHIP}>{t('members.guest')}</span>}
            {guest ? person?.bankCode : roleKey ? tRole(roleKey) : null}
          </p>
        </div>
        {(change || leaveWhy !== 'notMember') && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t('members.menu', { name })}
              title={t('members.menu', { name })}
              className={ICON_BUTTON}
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              {change && (
                <DropdownMenuItem
                  disabled={!!change.block}
                  onClick={() => void changeRole(m, change.to)}
                >
                  {change.to === 'admin' ? (
                    <ShieldCheck aria-hidden />
                  ) : (
                    <ShieldOff aria-hidden />
                  )}
                  <span>
                    {t(
                      change.to === 'admin'
                        ? 'members.makeAdmin'
                        : 'members.makeMember'
                    )}
                    {change.block && (
                      <span className="block text-xs">
                        {t('errors.lastAdmin')}
                      </span>
                    )}
                  </span>
                </DropdownMenuItem>
              )}
              {leaveWhy !== 'notMember' && (
                <DropdownMenuItem
                  variant="destructive"
                  disabled={leaveWhy !== null}
                  onClick={() => setLeaving(true)}
                >
                  <LogOut aria-hidden />
                  <span>
                    {t('members.leave')}
                    {leaveWhy && (
                      <span className="block text-xs">
                        {t(`errors.${leaveWhy}`)}
                      </span>
                    )}
                  </span>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </li>
    );
  };

  return (
    <aside
      aria-label={t('members.title')}
      className="bg-background fixed inset-0 z-40 flex min-h-0 flex-col lg:static lg:z-auto lg:w-[360px] lg:shrink-0 lg:border-l"
    >
      <header className="flex items-start gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold">{t('members.title')}</h3>
          {members && (
            <p className="text-muted-foreground text-xs">
              {t('channel.members', { count: members.length })}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('members.close')}
          className="hover:bg-muted -mr-1 rounded p-1"
        >
          <X className="size-4" />
        </button>
      </header>
      {adding ? (
        <AddPeople
          channelId={channelId}
          rows={pickRows}
          onBack={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            void reloadChannels();
          }}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto py-2">
          {rules && !rules.block && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="hover:bg-muted/50 flex w-full items-center gap-3 px-4 py-2 text-sm font-semibold"
            >
              <span className="bg-muted flex size-9 items-center justify-center rounded-lg">
                <UserPlus className="size-4" aria-hidden />
              </span>
              {t('members.add')}
            </button>
          )}
          {members === null ? (
            <p className="text-muted-foreground p-6 text-center text-sm">
              {t('members.loading')}
            </p>
          ) : (
            <ul>{sorted.map(row)}</ul>
          )}
        </div>
      )}
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title={t('members.leaveTitle')}
        description={t('members.leaveBody')}
        cancelLabel={t('members.cancel')}
        confirmLabel={t('members.leaveConfirm')}
        onConfirm={() => void leave()}
        destructive
      />
    </aside>
  );
}

/** The Add-people picker: those the rules allow, then the rest with why not. */
function AddPeople({
  channelId,
  rows,
  onBack,
  onAdded,
}: {
  channelId: string;
  rows: PickRow[];
  onBack: () => void;
  onAdded: () => void;
}) {
  const t = useTranslations('Chat');
  const tRole = useTranslations('Sidebar');
  const { sb, fail } = useChatWorkspaceContext();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const keep = new Set(
    filterPeople(
      rows.map((r) => r.person),
      q
    ).map((p) => p.userId)
  );
  const shown = rows.filter((r) => keep.has(r.person.userId));

  const add = async () => {
    setBusy(true);
    try {
      const n = await addMembers(sb, channelId, picked);
      toast.success(t('members.added', { count: n }));
      onAdded();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 pt-3">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('members.back')}
          className={ICON_BUTTON}
        >
          <ArrowLeft className="size-4" />
        </button>
        <p className="text-sm font-semibold">{t('members.add')}</p>
      </div>
      <div className="px-4 py-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('members.search')}
          aria-label={t('members.search')}
        />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {shown.map(({ person, block }) => {
          const on = picked.includes(person.userId);
          const roleKey = roleLabelKey(person.role);
          const name = person.fullName ?? t('unknownPerson');
          return (
            <li key={person.userId}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                aria-label={t('members.pick', { name })}
                disabled={!!block}
                onClick={() => setPicked((p) => togglePick(p, person.userId))}
                className="hover:bg-muted/50 flex w-full items-center gap-3 px-4 py-2 text-left disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
              >
                <Avatar person={person} userId={person.userId} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {name}
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    {block
                      ? t(BLOCK_KEY[block])
                      : isGuestPerson(person)
                        ? [t('members.guest'), person.bankCode]
                            .filter(Boolean)
                            .join(' · ')
                        : roleKey
                          ? tRole(roleKey)
                          : ''}
                  </span>
                </span>
                {!block && (
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded border',
                      on && 'border-[#0E7C5A] bg-[#0E7C5A] text-white'
                    )}
                  >
                    {on && <Check className="size-3.5" />}
                  </span>
                )}
              </button>
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="text-muted-foreground p-6 text-center text-sm">
            {q.trim()
              ? t('members.noMatch', { q: q.trim() })
              : t('members.nobody')}
          </li>
        )}
      </ul>
      <div className="flex justify-end border-t px-4 py-3">
        <Button
          type="button"
          onClick={() => void add()}
          disabled={busy || picked.length === 0}
        >
          {t('members.addPicked', { count: picked.length })}
        </Button>
      </div>
    </div>
  );
}
