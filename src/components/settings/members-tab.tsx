'use client';

// ============================================================
// MembersTab — Settings → Members
//
// Two stacked sections:
//   1. Roster   — every member of the account. Admin+ can change a
//                 teammate's role inline, edit the name and login
//                 email (migration 167, `canEditDetailsOf`) or set the
//                 password (migration 140, `canChangePasswordOf`) of
//                 someone below them,
//                 deactivate / reactivate them (migration 069), and
//                 remove them. Owner row is non-editable everywhere
//                 (transfer is its own separate flow, deferred to a
//                 later PR).
//   2. Pending  — outstanding invite links. Admin+ can revoke. The
//                 plaintext URL is gone after the create dialog
//                 closes, so we surface a "revoke + new link" hint
//                 rather than pretending we can resurface it.
//
// Role-gating
//   The section is owner / admin only (`minRole: 'admin'` in
//   settings-sections.ts; migration 175 took it back from team leaders,
//   who had it from 099), so everything here is for an admin: add a
//   person, invite by link, the roster and its role / deactivate /
//   remove controls. The routes, the RPCs (add_workspace_member,
//   set_member_role, remove_account_member) and RLS are the
//   enforcement point.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { MEMBERS_CACHE_KEY, invalidateCached } from '@/lib/client-cache';
import {
  AlertTriangle,
  Headphones,
  KeyRound,
  Loader2,
  Landmark,
  Smartphone,
  Mail,
  MailX,
  Plus,
  Search,
  Trash2,
  X,
  UserCheck,
  UserPen,
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
import { Input } from '@/components/ui/input';
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
import {
  DEPARTMENTS,
  toDepartment,
  type Department,
} from '@/lib/auth/departments';
import { useAuth } from '@/hooks/use-auth';
import { usePresence } from '@/hooks/use-presence';
import {
  ASSIGNABLE_ROLES,
  canChangePasswordOf,
  canEditDetailsOf,
  canHavePersonalWhatsapp,
  canManageMembers,
  canViewAllCalls,
  isBankGuest,
  type AccountRole,
  type AssignableRole,
} from '@/lib/auth/roles';
import { presenceLabel, summarize } from '@/lib/presence';
import {
  PRESENCE_DOT_CLASS,
  PresenceDot,
} from '@/components/presence/presence-dot';
import {
  canHoldCoordinatorBanks,
  banksByUser,
  phonesByUser,
} from '@/lib/coordinators/ui';
import { CoordinatorBanksDialog } from './coordinator-banks-dialog';
import { CreateMemberDialog } from './create-member-dialog';
import { InviteMemberDialog } from './invite-member-dialog';
import { MemberDetailsDialog } from './member-details-dialog';
import { MemberPasswordDialog } from './member-password-dialog';
import { SettingsPanelHead } from './settings-panel-head';
import { filterMembers, inactiveLast } from './member-search';
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
  /** Migration 190: allowed to connect a personal WhatsApp number. */
  may_connect_personal_whatsapp?: boolean;
  /** Their personal number, once connected. */
  personal_number?: { id: string; phone: string } | null;
  /** Migration 198: allowed to review every call; absent before 198. */
  may_review_all_calls?: boolean;
  /** Migration 192; sales when absent. */
  department?: Department;
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
  const tDept = useTranslations('Settings.departments');
  const tPeople = useTranslations('Groups.create');
  const { user, accountRole } = useAuth();
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
  const [coordPhones, setCoordPhones] = useState<Map<string, string>>(
    new Map()
  );
  const [editingBanks, setEditingBanks] = useState<Member | null>(null);
  const [passwordMember, setPasswordMember] = useState<Member | null>(null);
  const [detailsMember, setDetailsMember] = useState<Member | null>(null);
  const [memberQuery, setMemberQuery] = useState('');
  const shownMembers = useMemo(
    () =>
      inactiveLast(
        filterMembers(members, memberQuery, (r) => tRoles(r as AccountRole))
      ),
    [members, memberQuery, tRoles]
  );
  const [pendingMemberAction, setPendingMemberAction] = useState<string | null>(
    null
  );

  const loadEverything = useCallback(async () => {
    try {
      const [mres, ires] = await Promise.all([
        fetch('/api/account/members', { cache: 'no-store' }),
        fetch('/api/account/invitations', { cache: 'no-store' }),
      ]);

      if (!mres.ok) {
        const payload = await mres.json().catch(() => ({}));
        toast.error(payload.error || 'Failed to load members');
        return;
      }
      const mdata = (await mres.json()) as { members: Member[] };
      setMembers(mdata.members);

      // Coordinator badges; a failure only costs the badges.
      const cres = await fetch('/api/coordinators', { cache: 'no-store' });
      if (cres.ok) {
        const cdata = (await cres.json()) as {
          coordinators: Parameters<typeof banksByUser>[0];
        };
        setCoordBanks(banksByUser(cdata.coordinators));
        setCoordPhones(phonesByUser(cdata.coordinators));
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
  }, []);

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

  // Move a member to a department (migration 192). The inbox a chat
  // belongs to follows the department in SQL, so just reload.
  async function handleSetDepartment(member: Member, department: Department) {
    setPendingMemberAction(member.user_id);
    try {
      const res = await fetch(`/api/account/members/${member.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ department }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || tDept('memberFailed'));
        return;
      }
      toast.success(
        tDept('memberChanged', {
          name: member.full_name || t('unnamed'),
          department: tDept(`names.${department}`),
        })
      );
      await loadEverything();
    } catch (err) {
      console.error('[MembersTab] department error:', err);
      toast.error('Could not reach the server');
    } finally {
      setPendingMemberAction(null);
    }
  }

  // Allow or withdraw a member's own WhatsApp (migration 190). The server
  // refuses a withdrawal while their number is still connected.
  async function handleSetPersonalWhatsapp(member: Member, allow: boolean) {
    setPendingMemberAction(member.user_id);
    try {
      const res = await fetch(`/api/account/members/${member.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personalWhatsapp: allow }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        if (payload.error === 'personal_number_exists') {
          toast.error(t('personal.numberExists'));
        } else if (payload.error === 'not_eligible') {
          toast.error(t('personal.notEligible'));
        } else {
          toast.error(payload.error || t('personal.failed'));
        }
        return;
      }
      const name = member.full_name || t('unnamed');
      toast.success(
        allow
          ? t('personal.allowedToast', { name })
          : t('personal.removedToast', { name })
      );
      await loadEverything();
    } catch (err) {
      console.error('[MembersTab] personal whatsapp error:', err);
      toast.error('Could not reach the server');
    } finally {
      setPendingMemberAction(null);
    }
  }

  // Allow or withdraw reviewing every call (migration 198): a staff
  // member below admin who then sees calls, recordings and the Call
  // report as an admin does. Owners and admins see every call anyway.
  async function handleSetReviewAllCalls(member: Member, allow: boolean) {
    setPendingMemberAction(member.user_id);
    try {
      const res = await fetch(`/api/account/members/${member.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewAllCalls: allow }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(
          res.status === 422
            ? t('reviewCalls.notEligible')
            : payload.error || t('reviewCalls.failed')
        );
        return;
      }
      const name = member.full_name || t('unnamed');
      toast.success(
        allow
          ? t('reviewCalls.allowedToast', { name })
          : t('reviewCalls.removedToast', { name })
      );
      await loadEverything();
    } catch (err) {
      console.error('[MembersTab] review all calls error:', err);
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
                  login on another account. */}
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              {t('createMember')}
            </Button>
            <Button variant="outline" onClick={() => setInviteOpen(true)}>
              {t('inviteMember')}
            </Button>
          </div>
        }
      />

      {/* Live presence summary across the roster. Updates without a
          full refresh as heartbeats and the local re-derive tick land. */}
      {members.length > 0 &&
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
              <span className="text-muted-foreground">
                · {t('memberCount', { count: members.length })}
                {inactiveCount > 0 &&
                  ` · ${t('inactiveCount', { count: inactiveCount })}`}
              </span>
            </div>
          );
        })()}

      {/* Roster, with a search over name, email, role and bank code. */}
      {members.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="relative w-full sm:max-w-xs">
            <Search
              className="text-muted-foreground pointer-events-none absolute top-1/2 start-2.5 size-4 -translate-y-1/2"
              aria-hidden
            />
            <Input
              type="text"
              enterKeyHint="search"
              value={memberQuery}
              onChange={(e) => setMemberQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setMemberQuery('');
              }}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchLabel')}
              className="pe-8 ps-8"
            />
            {memberQuery && (
              <button
                type="button"
                onClick={() => setMemberQuery('')}
                aria-label={t('searchClear')}
                className="text-muted-foreground hover:text-foreground absolute top-1/2 end-2 -translate-y-1/2 rounded p-0.5"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            )}
          </div>
          {memberQuery.trim() && (
            <span className="text-muted-foreground text-xs" aria-live="polite">
              {t('searchCount', {
                shown: shownMembers.length,
                total: members.length,
              })}
            </span>
          )}
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {shownMembers.length === 0 && memberQuery.trim() ? (
            <p className="text-muted-foreground px-4 py-8 text-center text-sm">
              {t('searchNoMatch', { query: memberQuery.trim() })}
            </p>
          ) : null}
          <ul className="divide-border divide-y">
            {shownMembers.map((member) => {
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
                          <Badge className="bg-muted text-muted-foreground border-border text-xs tracking-wide uppercase">
                            {t('you')}
                          </Badge>
                        )}
                        {(coordBanks.get(member.user_id)?.length ?? 0) > 0 && (
                          <Badge className="bg-primary/10 text-primary border-primary/30 text-xs tracking-wide uppercase">
                            {tCoord('badge')} ·{' '}
                            {coordBanks.get(member.user_id)!.join(', ')}
                          </Badge>
                        )}
                        {member.may_connect_personal_whatsapp && (
                          <Badge className="bg-primary/10 text-primary border-primary/30 text-xs tracking-wide uppercase">
                            {t('personal.badge')}
                            {member.personal_number
                              ? ` · ${member.personal_number.phone}`
                              : ''}
                          </Badge>
                        )}
                        {member.may_review_all_calls && (
                          <Badge className="bg-primary/10 text-primary border-primary/30 text-xs tracking-wide uppercase">
                            {t('reviewCalls.badge')}
                          </Badge>
                        )}
                        {toDepartment(member.department) !== 'sales' && (
                          <Badge className="bg-muted text-muted-foreground border-border text-xs tracking-wide uppercase">
                            {tDept(`names.${toDepartment(member.department)}`)}
                          </Badge>
                        )}
                        {isInactive && (
                          <Badge className="border-destructive/30 bg-destructive-soft text-destructive text-xs tracking-wide uppercase">
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
                  <div className="text-muted-foreground hidden text-end text-xs sm:block">
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
                    {!isOwnerRow && !isSelf && member.role !== 'bank_guest' ? (
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
                          className="border-border text-foreground w-32"
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

                    {member.role !== 'bank_guest' &&
                      accountRole &&
                      canManageMembers(accountRole) && (
                        <Select
                          value={toDepartment(member.department)}
                          onValueChange={(v) =>
                            v && handleSetDepartment(member, v as Department)
                          }
                        >
                          <SelectTrigger
                            className="border-border text-foreground w-28"
                            disabled={isBusy}
                            aria-label={tDept('memberLabel')}
                          >
                            <SelectValue>
                              {tDept(
                                `names.${toDepartment(member.department)}`
                              )}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {DEPARTMENTS.map((d) => (
                              <SelectItem key={d} value={d}>
                                {tDept(`names.${d}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
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

                    {!!accountRole &&
                      canManageMembers(accountRole) &&
                      canHavePersonalWhatsapp(member.role) &&
                      !isInactive && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="outline"
                                size="sm"
                                aria-label={
                                  member.may_connect_personal_whatsapp
                                    ? t('personal.remove')
                                    : t('personal.allow')
                                }
                                onClick={() =>
                                  handleSetPersonalWhatsapp(
                                    member,
                                    !member.may_connect_personal_whatsapp
                                  )
                                }
                                disabled={isBusy}
                              >
                                <Smartphone className="size-4" />
                              </Button>
                            }
                          />
                          <TooltipContent>
                            {member.may_connect_personal_whatsapp
                              ? t('personal.remove')
                              : t('personal.allow')}
                          </TooltipContent>
                        </Tooltip>
                      )}

                    {/* Review every call (migration 198): staff below
                        admin only, since admins already see every call. */}
                    {!!accountRole &&
                      canManageMembers(accountRole) &&
                      !isBankGuest(member.role) &&
                      !canViewAllCalls(member.role) &&
                      !isInactive && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="outline"
                                size="sm"
                                aria-label={
                                  member.may_review_all_calls
                                    ? t('reviewCalls.remove')
                                    : t('reviewCalls.allow')
                                }
                                onClick={() =>
                                  handleSetReviewAllCalls(
                                    member,
                                    !member.may_review_all_calls
                                  )
                                }
                                disabled={isBusy}
                              >
                                <Headphones className="size-4" />
                              </Button>
                            }
                          />
                          <TooltipContent>
                            {member.may_review_all_calls
                              ? t('reviewCalls.remove')
                              : t('reviewCalls.allow')}
                          </TooltipContent>
                        </Tooltip>
                      )}

                    {/* Edit their name and login email: the same people
                        as the password below (migration 167). */}
                    {!isSelf &&
                      !!accountRole &&
                      canEditDetailsOf(accountRole, member.role) && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="outline"
                                size="sm"
                                aria-label={t('details.button')}
                                onClick={() => setDetailsMember(member)}
                                disabled={isBusy}
                              >
                                <UserPen className="size-4" />
                              </Button>
                            }
                          />
                          <TooltipContent>{t('details.button')}</TooltipContent>
                        </Tooltip>
                      )}

                    {/* Set their password: someone below you in this
                        workspace. The database also checks every other
                        workspace their login opens (migration 140). */}
                    {!isSelf &&
                      !!accountRole &&
                      canChangePasswordOf(accountRole, member.role) && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="outline"
                                size="sm"
                                aria-label={t('password.button')}
                                onClick={() => setPasswordMember(member)}
                                disabled={isBusy}
                              >
                                <KeyRound className="size-4" />
                              </Button>
                            }
                          />
                          <TooltipContent>
                            {t('password.button')}
                          </TooltipContent>
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
                        aria-label={tPeople('removeMember', {
                          name: member.full_name || t('unnamed'),
                        })}
                        className="border-destructive/30 bg-destructive-soft text-destructive hover:border-destructive/50 hover:bg-destructive/15 hover:text-destructive"
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
                            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium ${inviteRoleMeta.className}`}
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
                        className="border-destructive/30 bg-destructive-soft text-destructive hover:border-destructive/50 hover:bg-destructive/15 hover:text-destructive"
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

      <MemberDetailsDialog
        member={
          detailsMember
            ? {
                user_id: detailsMember.user_id,
                full_name: detailsMember.full_name,
                email: detailsMember.email ?? '',
              }
            : null
        }
        onClose={() => setDetailsMember(null)}
        onSaved={(saved) => {
          // Patched in place so the roster doesn't flash a reload;
          // assignee pickers elsewhere read the cached member list.
          invalidateCached(MEMBERS_CACHE_KEY);
          setMembers((prev) =>
            prev.map((m) =>
              m.user_id === saved.user_id
                ? { ...m, full_name: saved.full_name, email: saved.email }
                : m
            )
          );
        }}
      />

      <MemberPasswordDialog
        member={
          passwordMember
            ? {
                user_id: passwordMember.user_id,
                name:
                  passwordMember.full_name ||
                  passwordMember.email ||
                  t('unnamed'),
              }
            : null
        }
        onClose={() => setPasswordMember(null)}
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
        savedPhone={
          editingBanks ? (coordPhones.get(editingBanks.user_id) ?? null) : null
        }
        onOpenChange={(open) => {
          if (!open) setEditingBanks(null);
        }}
        onSaved={(userId, banks, phone) => {
          setCoordBanks((prev) => {
            const next = new Map(prev);
            if (banks.length > 0) next.set(userId, banks);
            else next.delete(userId);
            return next;
          });
          setCoordPhones((prev) => {
            const next = new Map(prev);
            if (phone) next.set(userId, phone);
            else next.delete(userId);
            return next;
          });
        }}
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
              <UserX className="text-warning size-4" />
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
              <AlertTriangle className="text-warning size-4" />
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
