'use client';

// ============================================================
// MembersTab — Settings → Members
//
// Two stacked sections:
//   1. Roster   — every member of the account. Admin+ can change a
//                 teammate's role inline, deactivate / reactivate
//                 them (migration 069), and remove them. Owner row
//                 is non-editable everywhere (transfer is its own
//                 separate flow, deferred to a later PR).
//   2. Pending  — outstanding invite links. Admin+ can revoke. The
//                 plaintext URL is gone after the create dialog
//                 closes, so we surface a "revoke + new link" hint
//                 rather than pretending we can resurface it.
//
// Role-gating
//   The section opens to team leaders and up (`minRole: 'team_leader'`
//   in settings-sections.ts, migration 099). A team leader gets the
//   invite button, offering only the roles they may grant
//   (`grantableRoles`), and the links they made themselves. "Add
//   person", which creates a login with a password the adder chooses,
//   the roster and its role / deactivate / remove controls stay
//   admin-only (`canManageMembers`), as does GET /api/account/members
//   behind it. The routes, the RPCs (add_workspace_member,
//   set_member_role, remove_account_member) and 099's RLS are the
//   enforcement point.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MEMBERS_CACHE_KEY, invalidateCached } from '@/lib/client-cache';
import {
  AlertTriangle,
  Loader2,
  Landmark,
  Mail,
  MailX,
  Plus,
  Trash2,
  UserCheck,
  UserX,
  UsersRound,
} from 'lucide-react';

import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarImage,
} from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { usePresence } from '@/hooks/use-presence';
import {
  ASSIGNABLE_ROLES,
  canManageMembers,
  type AccountRole,
  type AssignableRole,
} from '@/lib/auth/roles';
import { presenceLabel, summarize } from '@/lib/presence';
import {
  PRESENCE_DOT_CLASS,
  PresenceDot,
} from '@/components/presence/presence-dot';
import { canHoldCoordinatorBanks, banksByUser } from '@/lib/coordinators/ui';
import { CoordinatorBanksDialog } from './coordinator-banks-dialog';
import { CreateMemberDialog } from './create-member-dialog';
import { InviteMemberDialog } from './invite-member-dialog';
import { SettingsPanelHead } from './settings-panel-head';
import { ROLE_META } from './role-meta';

interface Member {
  user_id: string;
  full_name: string;
  email: string | null;
  avatar_url: string | null;
  role: AccountRole;
  joined_at: string;
  deactivated_at: string | null;
  /** A bank guest's bank (migration 083); null on every other row. */
  bank_code?: string | null;
}

interface Invitation {
  id: string;
  role: AssignableRole;
  label: string | null;
  created_at: string;
  expires_at: string;
}

// Per-role chip metadata (icon / label / colour) lives in the shared
// ROLE_META module so this roster and the Overview identity chip can't
// drift. The colour scale runs amber (owner — scarce, immutable) →
// primary (admin) → muted (agent / viewer).

function fmtDate(iso: string): string {
  // Match the rest of the dashboard's locale-light formatting.
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function fmtExpiresIn(
  iso: string,
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return t('expired');
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return t('expiresInDays', { days });
  const hours = Math.max(1, Math.floor(ms / (60 * 60 * 1000)));
  return t('expiresInHours', { hours });
}

export function MembersTab() {
  const t = useTranslations('Settings.members');
  const tRoles = useTranslations('Settings.roles');
  const tCoord = useTranslations('Coordinators.members');
  const { user, accountRole } = useAuth();
  // Owner/admin: the roster too. A team leader only adds people (099).
  const managesRoster = !!accountRole && canManageMembers(accountRole);
  const { getPresence, getRow, now } = usePresence();

  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [removingMember, setRemovingMember] = useState<Member | null>(null);
  const [deactivatingMember, setDeactivatingMember] = useState<Member | null>(
    null
  );
  const [coordBanks, setCoordBanks] = useState<Map<string, string[]>>(
    new Map()
  );
  const [editingBanks, setEditingBanks] = useState<Member | null>(null);
  const [pendingMemberAction, setPendingMemberAction] = useState<string | null>(
    null
  );

  const loadEverything = useCallback(async () => {
    try {
      const [mres, ires] = await Promise.all([
        managesRoster
          ? fetch('/api/account/members', { cache: 'no-store' })
          : null,
        fetch('/api/account/invitations', { cache: 'no-store' }),
      ]);

      if (mres) {
        if (!mres.ok) {
          const payload = await mres.json().catch(() => ({}));
          toast.error(payload.error || 'Failed to load members');
          return;
        }
        const mdata = (await mres.json()) as { members: Member[] };
        setMembers(mdata.members);
      }

      if (mres) {
        // Coordinator badges; a failure only costs the badges.
        const cres = await fetch('/api/coordinators', { cache: 'no-store' });
        if (cres.ok) {
          const cdata = (await cres.json()) as {
            coordinators: Parameters<typeof banksByUser>[0];
          };
          setCoordBanks(banksByUser(cdata.coordinators));
        }
      }

      if (!ires.ok) {
        const payload = await ires.json().catch(() => ({}));
        toast.error(payload.error || 'Failed to load invitations');
        return;
      }
      const idata = (await ires.json()) as { invitations: Invitation[] };
      setInvitations(idata.invitations);
    } catch (err) {
      console.error('[MembersTab] load error:', err);
      toast.error('Could not reach the server');
    } finally {
      setLoading(false);
    }
  }, [managesRoster]);

  useEffect(() => {
    void loadEverything();
  }, [loadEverything]);

  async function handleRoleChange(member: Member, nextRole: AccountRole) {
    if (member.role === nextRole) return;
    // Optimistic update — flip the dropdown immediately so the UI
    // feels snappy. If the server PATCH fails we revert below so
    // the dropdown doesn't lie about the persisted state.
    const previousRole = member.role;
    setPendingMemberAction(member.user_id);
    setMembers((prev) =>
      prev.map((m) =>
        m.user_id === member.user_id ? { ...m, role: nextRole } : m
      )
    );
    try {
      const res = await fetch(`/api/account/members/${member.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: nextRole }),
      });
      if (!res.ok) {
        // Revert the optimistic flip. The toast on its own wasn't
        // enough — the dropdown was left showing the new role
        // forever, so the next interaction operated on a wrong
        // baseline (re-trying the same change would no-op via the
        // `member.role === nextRole` guard at the top).
        setMembers((prev) =>
          prev.map((m) =>
            m.user_id === member.user_id ? { ...m, role: previousRole } : m
          )
        );
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Failed to update role');
        return;
      }
      toast.success(
        t('updatedToast', {
          name: member.full_name || t('unnamed'),
          role: tRoles(nextRole),
        })
      );
    } catch (err) {
      // Same revert on network failure.
      setMembers((prev) =>
        prev.map((m) =>
          m.user_id === member.user_id ? { ...m, role: previousRole } : m
        )
      );
      console.error('[MembersTab] role change error:', err);
      toast.error('Could not reach the server');
    } finally {
      setPendingMemberAction(null);
    }
  }

  // Deactivate (after the confirm dialog) or reactivate (directly — it
  // only gives access back). Not optimistic: the server bans or unbans
  // the login as part of the same call, and the row should not claim a
  // state that failed to stick.
  async function handleSetActive(member: Member, active: boolean) {
    setPendingMemberAction(member.user_id);
    try {
      const res = await fetch(`/api/account/members/${member.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Failed to update member');
        return;
      }
      // Assignee pickers elsewhere hide deactivated members.
      invalidateCached(MEMBERS_CACHE_KEY);
      setMembers((prev) =>
        prev.map((m) =>
          m.user_id === member.user_id
            ? {
                ...m,
                deactivated_at: active
                  ? null
                  : (m.deactivated_at ?? new Date().toISOString()),
              }
            : m
        )
      );
      const name = member.full_name || t('unnamed');
      toast.success(
        active
          ? t('reactivatedToast', { name })
          : t('deactivatedToast', { name })
      );
      setDeactivatingMember(null);
    } catch (err) {
      console.error('[MembersTab] set active error:', err);
      toast.error('Could not reach the server');
    } finally {
      setPendingMemberAction(null);
    }
  }

  async function handleRemove() {
    if (!removingMember) return;
    setPendingMemberAction(removingMember.user_id);
    try {
      const res = await fetch(
        `/api/account/members/${removingMember.user_id}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Failed to remove member');
        return;
      }
      invalidateCached(MEMBERS_CACHE_KEY);
      toast.success(
        t('removedToast', { name: removingMember.full_name || t('unnamed') })
      );
      setMembers((prev) =>
        prev.filter((m) => m.user_id !== removingMember.user_id)
      );
      setRemovingMember(null);
    } catch (err) {
      console.error('[MembersTab] remove error:', err);
      toast.error('Could not reach the server');
    } finally {
      setPendingMemberAction(null);
    }
  }

  async function handleRevoke(invite: Invitation) {
    try {
      const res = await fetch(`/api/account/invitations/${invite.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Failed to revoke invitation');
        return;
      }
      toast.success(t('revokedToast'));
      setInvitations((prev) => prev.filter((i) => i.id !== invite.id));
    } catch (err) {
      console.error('[MembersTab] revoke error:', err);
      toast.error('Could not reach the server');
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <div className="flex flex-wrap gap-2">
            {/* Primary: self-service signup is gone, so creating the
                  login here is the only way a new person gets in. The
                  invite link remains for someone who ALREADY has a
                  login on another account. Owner / admin only: a team
                  leader invites by link (099). */}
            {managesRoster && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" />
                {t('createMember')}
              </Button>
            )}
            <Button variant="outline" onClick={() => setInviteOpen(true)}>
              {t('inviteMember')}
            </Button>
          </div>
        }
      />

      {!managesRoster && (
        <p className="text-muted-foreground text-sm">{t('leaderNote')}</p>
      )}

      {/* Live presence summary across the roster. Updates without a
          full refresh as heartbeats and the local re-derive tick land. */}
      {managesRoster &&
        members.length > 0 &&
        (() => {
          // Presence counts only people who can sign in; a deactivated
          // member would otherwise sit in "offline" forever.
          const activeMembers = members.filter((m) => !m.deactivated_at);
          const inactiveCount = members.length - activeMembers.length;
          const counts = summarize(
            activeMembers.map((m) => getPresence(m.user_id))
          );
          return (
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="inline-flex items-center gap-1.5">
                <PresenceDot status="online" />
                {counts.online} {t('online')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <PresenceDot status="away" />
                {counts.away} {t('away')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <PresenceDot status="offline" />
                {counts.offline} {t('offline')}
              </span>
              <span className="text-muted-foreground/70">
                · {t('memberCount', { count: members.length })}
                {inactiveCount > 0 &&
                  ` · ${t('inactiveCount', { count: inactiveCount })}`}
              </span>
            </div>
          );
        })()}

      {/* Roster */}
      {managesRoster && (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-border divide-y">
              {members.map((member) => {
                const roleMeta = ROLE_META[member.role];
                const RoleIcon = roleMeta.icon;
                const isSelf = member.user_id === user?.id;
                const isOwnerRow = member.role === 'owner';
                const isBusy = pendingMemberAction === member.user_id;
                const isInactive = !!member.deactivated_at;
                const presence = getPresence(member.user_id);
                const presenceRow = getRow(member.user_id);
                const presenceText = presenceLabel(
                  presence,
                  presenceRow?.last_seen_at ?? null,
                  now
                );

                return (
                  <li
                    key={member.user_id}
                    // Mobile: stack identity (avatar+name+email) above the
                    // role/remove actions so the role dropdown's fixed
                    // 128px width doesn't force the name into a 50-pixel
                    // truncation. Desktop (sm+): everything inline as
                    // before.
                    className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <div
                      className={`flex min-w-0 flex-1 items-center gap-4 ${isInactive ? 'opacity-60' : ''}`}
                    >
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Avatar className="size-9 shrink-0">
                              {member.avatar_url ? (
                                <AvatarImage
                                  src={member.avatar_url}
                                  alt={member.full_name || 'Member'}
                                />
                              ) : null}
                              <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                                {(member.full_name || member.email || 'U')
                                  .charAt(0)
                                  .toUpperCase()}
                              </AvatarFallback>
                              {/* role+label so screen readers announce
                                presence — the hover tooltip alone isn't
                                reachable by keyboard/AT on a non-focusable
                                avatar. */}
                              <AvatarBadge
                                role="img"
                                aria-label={presenceText}
                                className={PRESENCE_DOT_CLASS[presence]}
                              />
                            </Avatar>
                          }
                        />
                        <TooltipContent>{presenceText}</TooltipContent>
                      </Tooltip>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-foreground truncate text-sm font-medium">
                            {member.full_name || t('unnamed')}
                          </span>
                          {isSelf && (
                            <Badge className="bg-muted text-muted-foreground border-border text-[10px] tracking-wide uppercase">
                              {t('you')}
                            </Badge>
                          )}
                          {(coordBanks.get(member.user_id)?.length ?? 0) >
                            0 && (
                            <Badge className="bg-primary/10 text-primary border-primary/30 text-[10px] tracking-wide uppercase">
                              {tCoord('badge')} ·{' '}
                              {coordBanks.get(member.user_id)!.join(', ')}
                            </Badge>
                          )}
                          {isInactive && (
                            <Badge className="border-red-500/40 bg-red-500/10 text-[10px] tracking-wide text-red-400 uppercase">
                              {t('inactive')}
                            </Badge>
                          )}
                        </div>
                        {member.email && (
                          <p className="text-muted-foreground truncate text-xs">
                            {member.email}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Joined date stays desktop-only. The mobile row's
                      vertical density makes the joined date noise. */}
                    <div className="text-muted-foreground hidden text-right text-xs sm:block">
                      {member.deactivated_at
                        ? t('deactivatedOn', {
                            date: fmtDate(member.deactivated_at),
                          })
                        : t('joined', { date: fmtDate(member.joined_at) })}
                    </div>

                    {/* Actions cluster. On mobile this is its own row
                      below the identity block; on desktop it sits
                      inline. Items align to the start on mobile so the
                      role dropdown lines up under the avatar. */}
                    <div className="flex items-center gap-2 sm:gap-3">
                      {/* Role display / editor. Not on the owner row (owner
                        changes go through transfer) nor your own, and
                        not on a bank guest's: set_member_role refuses to
                        turn a guest into staff or back. */}
                      {!isOwnerRow &&
                      !isSelf &&
                      member.role !== 'bank_guest' ? (
                        <Select
                          value={member.role}
                          onValueChange={(v) =>
                            // Base UI Select can emit null on clear. We
                            // don't expose a clear affordance, so the
                            // guard is defensive — but the typed
                            // signature requires it.
                            v && handleRoleChange(member, v as AccountRole)
                          }
                        >
                          <SelectTrigger
                            className="bg-muted border-border text-foreground w-32"
                            disabled={isBusy}
                          >
                            <SelectValue>{tRoles(member.role)}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {ASSIGNABLE_ROLES.map((r) => (
                              <SelectItem key={r} value={r}>
                                {tRoles(r)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className="inline-flex items-center gap-2">
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ${roleMeta.className}`}
                          >
                            <RoleIcon className="size-3.5" />
                            {tRoles(member.role)}
                          </span>
                          {member.role === 'bank_guest' && member.bank_code ? (
                            <span className="text-muted-foreground text-xs">
                              {t('bankCode', { code: member.bank_code })}
                            </span>
                          ) : null}
                        </span>
                      )}

                      {canHoldCoordinatorBanks(member.role) && !isInactive && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="outline"
                                size="sm"
                                aria-label={tCoord('manage')}
                                onClick={() => setEditingBanks(member)}
                                disabled={isBusy}
                              >
                                <Landmark className="size-4" />
                              </Button>
                            }
                          />
                          <TooltipContent>{tCoord('manage')}</TooltipContent>
                        </Tooltip>
                      )}

                      {/* Deactivate / reactivate. Same gate as Remove: the
                        owner can't be deactivated (someone must be able
                        to turn people back on) and neither can you. */}
                      {!isOwnerRow && !isSelf && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="outline"
                                size="sm"
                                aria-label={
                                  isInactive ? t('reactivate') : t('deactivate')
                                }
                                onClick={() =>
                                  isInactive
                                    ? handleSetActive(member, true)
                                    : setDeactivatingMember(member)
                                }
                                disabled={isBusy}
                              >
                                {isBusy && !deactivatingMember ? (
                                  <Loader2 className="size-4 animate-spin" />
                                ) : isInactive ? (
                                  <UserCheck className="size-4" />
                                ) : (
                                  <UserX className="size-4" />
                                )}
                              </Button>
                            }
                          />
                          <TooltipContent>
                            {isInactive ? t('reactivate') : t('deactivate')}
                          </TooltipContent>
                        </Tooltip>
                      )}

                      {/* Remove. Admin+ only; never on the owner row;
                        never on yourself. Pre-polish styling was
                        neutral-default + red-on-hover — the
                        destructive intent was invisible until the
                        user moused over. Now red is the default
                        state with a darker shade on hover so the
                        affordance reads at-a-glance. */}
                      {!isOwnerRow && !isSelf && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setRemovingMember(member)}
                          disabled={isBusy}
                          className="border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Pending invitations */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <UsersRound className="text-muted-foreground size-4" />
          <h3 className="text-foreground text-sm font-semibold">
            {t('pendingInvitations')}
          </h3>
          <Badge className="bg-muted text-muted-foreground border-border">
            {invitations.length}
          </Badge>
        </div>
        {/* P10 — make the no-resend design explicit. Admins were
              confused why the pending list shows roles + expiry but
              no "copy link again" button. Stating the constraint up
              front (rather than letting the user discover it by
              looking for a button) keeps it from feeling like a bug. */}
        {invitations.length > 0 ? (
          <p className="text-muted-foreground mb-3 text-xs">
            {t('inviteHint')}
          </p>
        ) : null}

        {invitations.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-8 text-center">
              <Mail className="text-muted-foreground size-6" />
              <p className="text-muted-foreground mt-2 text-sm">
                {t('noPendingTitle')}
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                {t.rich('noPendingDesc', {
                  bold: (chunks) => <strong>{chunks}</strong>,
                })}
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <ul className="divide-border divide-y">
                {invitations.map((inv) => {
                  const inviteRoleMeta = ROLE_META[inv.role];
                  const InviteRoleIcon = inviteRoleMeta.icon;
                  return (
                    <li
                      key={inv.id}
                      className="flex items-center gap-4 px-4 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-foreground text-sm font-medium">
                            {inv.label || t('untitledInvite')}
                          </span>
                          <span
                            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${inviteRoleMeta.className}`}
                          >
                            <InviteRoleIcon className="size-3" />
                            {tRoles(inv.role)}
                          </span>
                        </div>
                        <p className="text-muted-foreground mt-0.5 text-xs">
                          {t('created', { date: fmtDate(inv.created_at) })} ·{' '}
                          {fmtExpiresIn(inv.expires_at, t)}
                        </p>
                      </div>

                      {/* Revoke: red default state, mirrors the
                          members-tab Remove button. Pre-polish version
                          read as a neutral secondary button until
                          hover. */}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRevoke(inv)}
                        className="border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
                      >
                        <MailX className="size-4" />
                        {t('revoke')}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>

      <CreateMemberDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={loadEverything}
      />

      <InviteMemberDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onCreated={loadEverything}
      />

      <CoordinatorBanksDialog
        member={
          editingBanks
            ? {
                user_id: editingBanks.user_id,
                name: editingBanks.full_name || t('unnamed'),
              }
            : null
        }
        saved={editingBanks ? (coordBanks.get(editingBanks.user_id) ?? []) : []}
        onOpenChange={(open) => {
          if (!open) setEditingBanks(null);
        }}
        onSaved={(userId, banks) =>
          setCoordBanks((prev) => {
            const next = new Map(prev);
            if (banks.length > 0) next.set(userId, banks);
            else next.delete(userId);
            return next;
          })
        }
      />

      <Dialog
        open={deactivatingMember !== null}
        onOpenChange={(open) => {
          if (!open) setDeactivatingMember(null);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground flex items-center gap-2">
              <UserX className="size-4 text-amber-400" />
              {t('deactivateDialogTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t.rich('deactivateDialogDesc', {
                name: deactivatingMember?.full_name || t('unnamed'),
                bold: (chunks: React.ReactNode) => <strong>{chunks}</strong>,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setDeactivatingMember(null)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={() =>
                deactivatingMember && handleSetActive(deactivatingMember, false)
              }
              disabled={!!pendingMemberAction}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {pendingMemberAction ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('deactivating')}
                </>
              ) : (
                t('deactivateBtn')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={removingMember !== null}
        onOpenChange={(open) => {
          if (!open) setRemovingMember(null);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-400" />
              {t('removeDialogTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t.rich('removeDialogDesc', {
                name: removingMember?.full_name || t('unnamed'),
                bold: (chunks: React.ReactNode) => <strong>{chunks}</strong>,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setRemovingMember(null)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleRemove}
              disabled={!!pendingMemberAction}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {pendingMemberAction ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('removing')}
                </>
              ) : (
                t('removeBtn')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
