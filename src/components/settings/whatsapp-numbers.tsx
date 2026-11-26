'use client';

// ============================================================
// Settings -> Numbers & access.
//
// One screen for every connected WhatsApp number: what it is called,
// which one is the default, who works it, and — for a second or third
// Whapi number — connecting it in the first place (migration 060).
//
// "Who works it" is the allocation list. A number nobody was ever put on
// is shared, exactly as before 060; one whose people all left is for
// owners and admins until both lists are saved empty (314). A number with people on it becomes
// the numbers they send from, and their new chats start from it.
// Allocation grants no visibility (migration 072): they still see only
// their own and assigned chats (leaders also their team's); admins see
// everything. All of that is enforced in the database; this screen only
// decides what to write.
//
// People reach a number two ways (migration 071): ticked by hand, or
// through a team allocated to it — every member and the leader, kept
// in step with the team by the database. The dialog edits the two
// lists separately and saves them separately, so taking a team off a
// number never removes someone ticked by hand.
//
// Credentials and webhook health stay on the WhatsApp section, which
// owns the provider-specific checks — each card links there.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  Check,
  Loader2,
  MessagesSquare,
  Pencil,
  Phone,
  Plus,
  QrCode,
  Settings2,
  Star,
  Trash2,
  Users,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { invalidateCached } from '@/lib/client-cache';
import {
  MAX_CHANNEL_LABEL_LEN,
  channelDisplayName,
  isLinkedDeviceNumber,
  providerLabel,
} from '@/lib/whatsapp/channel-management';
import { isLinkedStatus } from '@/lib/whatsapp/openwa-connect';
import { OpenWAConnectDialog } from './openwa-connect-dialog';
import {
  effectiveAccess,
  savedAccess,
  teamPeople,
  type TeamRoster,
} from '@/lib/whatsapp/team-allocation';
import { ChangedNotice } from './changed-notice';
import { SettingsPanelHead } from './settings-panel-head';
import { staffOnly } from '@/lib/account/members';
import type { AccountMember } from '@/types';

interface NumberRow {
  id: string;
  provider: 'whapi' | 'meta' | 'openwa';
  label: string | null;
  phone_number_id: string;
  waba_id: string | null;
  is_primary: boolean;
  is_personal?: boolean;
  user_id?: string | null;
  status: string;
  registered_at: string | null;
  /** People ticked by hand. */
  member_ids: string[];
  /** Teams allocated to the number. */
  team_ids: string[];
  /** Limited by an admin (314). */
  access_restricted?: boolean;
  /** People who have the number through one of those teams. */
  team_member_ids: string[];
  /** Null when it could not be counted. */
  conversation_count: number | null;
}

/**
 * Live health of one number, from the same check the WhatsApp section
 * runs (`GET /api/whatsapp/config[/meta]`). The row's stored `status`
 * is only written when the number is saved, so on its own it can say
 * "Connected" for a phone that was logged out last week — and the two
 * screens would contradict each other.
 */
interface NumberHealth {
  /** null while the check is in flight. */
  live: boolean | null;
  message?: string;
  /** Meta: the display number, which the row itself does not store. */
  phone?: string | null;
}

/**
 * Browser caches that describe which numbers exist or who is on them
 * (inbox banner, contact screen captions). Dropped after every write
 * here so the change shows without a reload.
 */
function invalidateNumberCaches() {
  invalidateCached('whatsapp-channels:');
  invalidateCached('whatsapp-status:');
  invalidateCached('whatsapp-allocations:');
}

export function WhatsAppNumbers() {
  const t = useTranslations('Settings.numbers');
  const tRoles = useTranslations('Settings.roles');

  const [numbers, setNumbers] = useState<NumberRow[]>([]);
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const [accessFor, setAccessFor] = useState<NumberRow | null>(null);
  const [accessDraft, setAccessDraft] = useState<string[]>([]);
  const [accessTeamsDraft, setAccessTeamsDraft] = useState<string[]>([]);
  const [accessSearch, setAccessSearch] = useState('');
  // Another admin saved meanwhile: what is stored now, null when it could
  // not be read. The draft stays and Save waits for Reload.
  const [accessChanged, setAccessChanged] = useState<{
    stored: NumberRow | null;
  } | null>(null);
  const [rereading, setRereading] = useState(false);
  // The number whose dialog is open, for a save that ends after it closed.
  const openAccessId = useRef<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addToken, setAddToken] = useState('');
  const [addChannelId, setAddChannelId] = useState('');
  const [adding, setAdding] = useState(false);
  const [openwaOpen, setOpenwaOpen] = useState(false);
  // "Scan again" on an OpenWA number whose phone was logged out.
  const [rescanId, setRescanId] = useState<string | null>(null);

  const [removing, setRemoving] = useState<NumberRow | null>(null);
  // Set after the server answered 409 messages_waiting: the dialog then
  // asks once more, with this count.
  const [waitingCount, setWaitingCount] = useState<number | null>(null);
  const [health, setHealth] = useState<Record<string, NumberHealth>>({});
  // The member roster is what the access dialog edits. If it failed to
  // load, an empty checklist saved back would un-allocate everyone —
  // so access editing is disabled rather than risked.
  const [membersLoaded, setMembersLoaded] = useState(false);
  // Same rule for teams: without the team list the dialog cannot show
  // or save team allocations, so it leaves them untouched.
  const [teams, setTeams] = useState<TeamRoster[]>([]);
  const [teamsLoaded, setTeamsLoaded] = useState(false);

  const load = useCallback(
    async (
      quiet = false
    ): Promise<{ rows: NumberRow[]; complete: boolean } | null> => {
      try {
        const [numbersRes, membersRes, teamsRes] = await Promise.all([
          fetch('/api/whatsapp/channels', { cache: 'no-store' }),
          fetch('/api/account/members', { cache: 'no-store' }),
          fetch('/api/account/teams', { cache: 'no-store' }),
        ]);
        const numbersBody = await numbersRes.json().catch(() => ({}));
        const membersBody = await membersRes.json().catch(() => ({}));
        const teamsBody = await teamsRes.json().catch(() => ({}));
        if (!numbersRes.ok)
          throw new Error(numbersBody?.error || t('loadFailed'));
        const rows: NumberRow[] = numbersBody.channels ?? [];
        setNumbers(rows);
        // A failed re-read keeps the last good list: an open dialog edits it.
        const membersOk = membersRes.ok && Array.isArray(membersBody?.members);
        if (membersOk) {
          setMembers(staffOnly(membersBody.members));
          setMembersLoaded(true);
        }
        const teamsOk = teamsRes.ok && Array.isArray(teamsBody?.teams);
        if (teamsOk) {
          setTeams(teamsBody.teams);
          setTeamsLoaded(true);
        }
        void checkHealth(rows);
        return { rows, complete: membersOk && teamsOk };
      } catch (err) {
        if (!quiet)
          toast.error(err instanceof Error ? err.message : t('loadFailed'));
        return null;
      } finally {
        setLoading(false);
      }
    },
    [t]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Settings → WhatsApp links here with `?add=1` to connect another
  // number, so the admin lands in the dialog rather than hunting for
  // the button. The flag is dropped straight away so a reload or a
  // later visit does not reopen it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('add') !== '1') return;
    setAddOpen(true);
    params.delete('add');
    window.history.replaceState(null, '', `/settings?${params.toString()}`);
  }, []);

  /** Live-check every number in parallel; each row fills in as it answers. */
  async function checkHealth(rows: NumberRow[]) {
    setHealth(Object.fromEntries(rows.map((r) => [r.id, { live: null }])));
    await Promise.all(
      rows.map(async (row) => {
        let result: NumberHealth;
        try {
          if (row.provider === 'openwa') {
            // The Whapi health route would read an OpenWA row as a
            // Whapi channel; its own status route asks the gateway.
            // No answer (gateway down, 5xx) is unknown, not "logged
            // out": only OpenWA's own word may offer Scan again.
            const body = await fetch(
              `/api/whatsapp/config/openwa/${encodeURIComponent(row.id)}/status`,
              { cache: 'no-store' }
            )
              .then((r) => r.json())
              .catch(() => null);
            setHealth((prev) => ({
              ...prev,
              [row.id]: {
                live:
                  typeof body?.status === 'string'
                    ? isLinkedStatus(body.status)
                    : null,
                phone: body?.phone ?? null,
              },
            }));
            return;
          }
          const url =
            row.provider === 'meta'
              ? '/api/whatsapp/config/meta'
              : `/api/whatsapp/config?config_id=${encodeURIComponent(row.id)}`;
          const body = await fetch(url, { cache: 'no-store' }).then((r) =>
            r.json()
          );
          result =
            row.provider === 'meta'
              ? {
                  live: !!body?.connected && body?.status !== 'disconnected',
                  phone: body?.display_phone_number ?? null,
                }
              : { live: !!body?.connected, message: body?.message };
        } catch {
          result = { live: false };
        }
        setHealth((prev) => ({ ...prev, [row.id]: result }));
      })
    );
  }

  const memberById = useMemo(
    () => new Map(members.map((m) => [m.user_id, m])),
    [members]
  );
  const nameOf = useCallback(
    (userId: string) => {
      const m = memberById.get(userId);
      return m?.full_name || m?.email || t('unknownMember');
    },
    [memberById, t]
  );
  /** A person who left or is deactivated cannot use a number. */
  const liveIds = useMemo(
    () =>
      new Set(members.filter((m) => !m.deactivated_at).map((m) => m.user_id)),
    [members]
  );
  const isLiveMember = useCallback(
    (userId: string) => !membersLoaded || liveIds.has(userId),
    [membersLoaded, liveIds]
  );
  const teamById = useMemo(
    () => new Map(teams.map((team) => [team.id, team])),
    [teams]
  );

  /** What the access dialog would save, recomputed on every tick. */
  const draftAccess = useMemo(
    () =>
      teamsLoaded
        ? effectiveAccess(accessDraft, accessTeamsDraft, teams, liveIds)
        : {
            // The teams stay as they are stored.
            ...savedAccess(
              {
                member_ids: accessDraft,
                team_ids: accessFor?.team_ids ?? [],
                team_member_ids: accessFor?.team_member_ids ?? [],
              },
              isLiveMember
            ),
            viaTeams: new Map<string, string[]>(),
          },
    [
      accessDraft,
      accessTeamsDraft,
      teams,
      teamsLoaded,
      liveIds,
      accessFor,
      isLiveMember,
    ]
  );
  // An empty people list on its own leaves the number to its teams or to
  // admins, never to everyone (314): not saved without seeing the teams.
  const emptyWithoutTeams = !teamsLoaded && accessDraft.length === 0;

  async function patchNumber(
    row: NumberRow,
    patch: {
      label?: string;
      member_ids?: string[];
      team_ids?: string[];
      expected_member_ids?: string[];
      expected_team_ids?: string[];
      is_primary?: true;
    },
    /** Fields only the server derives, to show without a reload. */
    derived: Partial<NumberRow> = {}
  ): Promise<boolean> {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/whatsapp/channels/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body?.code === 'access_changed') {
        // Another admin saved meanwhile: the dialog keeps the draft and
        // says what is stored.
        invalidateNumberCaches();
        if (!(await readStoredAccess(row))) {
          toast.error(t('accessChanged', { name: channelDisplayName(row) }));
        }
        return false;
      }
      if (!res.ok) {
        toast.error(body?.error || t('saveFailed'));
        // Re-read rather than trust what the card held: the server may
        // have applied part of the patch, or someone else's change.
        void load();
        return false;
      }
      invalidateNumberCaches();
      setNumbers((prev) =>
        prev.map((n) => {
          if (patch.is_primary) {
            return { ...n, is_primary: n.id === row.id };
          }
          if (n.id !== row.id) return n;
          return {
            ...n,
            ...(patch.label !== undefined ? { label: patch.label } : {}),
            ...(patch.member_ids !== undefined
              ? { member_ids: patch.member_ids }
              : {}),
            ...(patch.team_ids !== undefined
              ? { team_ids: patch.team_ids }
              : {}),
            ...derived,
          };
        })
      );
      return true;
    } catch {
      toast.error(t('saveFailed'));
      void load();
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function saveRename(row: NumberRow) {
    // Same normalisation the server applies (normalizeChannelLabel), so
    // the name shown after saving is the name that was stored.
    const next = renameValue.trim().replace(/\s+/g, ' ');
    if (!next || next === row.label) {
      setRenamingId(null);
      return;
    }
    if (await patchNumber(row, { label: next })) {
      toast.success(t('renamed', { name: next }));
      setRenamingId(null);
    }
  }

  /** What is stored, into the open dialog; false when it was closed. */
  async function readStoredAccess(row: NumberRow): Promise<boolean> {
    setRereading(true);
    const loaded = await load(true);
    setRereading(false);
    if (openAccessId.current !== row.id) return false;
    const stored = loaded?.rows.find((n) => n.id === row.id);
    if (loaded && !stored) {
      toast.error(t('accessGone', { name: channelDisplayName(row) }));
      closeAccess();
      return true;
    }
    setAccessChanged({ stored: (loaded?.complete && stored) || null });
    return true;
  }

  /** The stored lists by name, for the notice. */
  function storedText(row: NumberRow): string {
    const people = row.member_ids.map(nameOf).join(', ');
    const teamNames = row.team_ids
      .map((id) => teamById.get(id)?.name)
      .filter(Boolean)
      .join(', ');
    const parts = [
      people && t('storedPeople', { names: people }),
      teamNames && t('storedTeams', { names: teamNames }),
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(' · ');
    return row.access_restricted ? t('adminsOnlyTitle') : t('sharedTitle');
  }

  function closeAccess() {
    openAccessId.current = null;
    setAccessFor(null);
    setAccessChanged(null);
  }

  function openAccess(row: NumberRow) {
    openAccessId.current = row.id;
    setAccessChanged(null);
    setAccessFor(row);
    setAccessDraft(row.member_ids);
    setAccessTeamsDraft(row.team_ids);
    setAccessSearch('');
  }

  async function saveAccess() {
    if (!accessFor || accessChanged || emptyWithoutTeams) return;
    const access = draftAccess;
    // Direct ticks and teams go separately: the server keeps a team's
    // people apart from the hand-ticked ones. Teams are only sent when
    // the team list loaded — otherwise this would clear them.
    const saved = await patchNumber(
      accessFor,
      teamsLoaded
        ? {
            member_ids: accessDraft,
            team_ids: accessTeamsDraft,
            expected_member_ids: accessFor.member_ids,
            expected_team_ids: accessFor.team_ids,
          }
        : {
            member_ids: accessDraft,
            expected_member_ids: accessFor.member_ids,
          },
      teamsLoaded
        ? {
            team_member_ids: [...access.viaTeams.keys()],
            access_restricted: !access.shared,
          }
        : {}
    );
    if (saved) {
      toast.success(
        access.shared
          ? t('accessShared', { name: channelDisplayName(accessFor) })
          : access.adminsOnly
            ? t('accessAdminsOnly', { name: channelDisplayName(accessFor) })
            : t('accessSaved', {
                name: channelDisplayName(accessFor),
                count: access.people.length,
              })
      );
      // Not the dialog of another number, opened while this one was saved.
      if (openAccessId.current === accessFor.id) closeAccess();
    }
  }

  async function handleAdd() {
    if (!addToken.trim() || adding) return;
    setAdding(true);
    try {
      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          create: true,
          label: addName.trim() || undefined,
          token: addToken.trim(),
          channel_id: addChannelId.trim() || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body?.error || t('addFailed'));
        return;
      }
      if (body.registration_error) {
        // Saved and sending, but nothing inbound will arrive until the
        // callback is registered — the one message the admin must act on.
        toast.error(t('addedNoWebhook', { error: body.registration_error }), {
          duration: 12000,
        });
      } else {
        toast.success(t('added'));
      }
      setAddOpen(false);
      setAddName('');
      setAddToken('');
      setAddChannelId('');
      invalidateNumberCaches();
      await load();
    } catch {
      toast.error(t('addFailed'));
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(row: NumberRow, force = false) {
    setBusyId(row.id);
    try {
      const base =
        row.provider === 'meta'
          ? '/api/whatsapp/config/meta'
          : row.provider === 'openwa'
            ? `/api/whatsapp/config/openwa/${encodeURIComponent(row.id)}`
            : `/api/whatsapp/config?config_id=${encodeURIComponent(row.id)}`;
      const url = force
        ? `${base}${base.includes('?') ? '&' : '?'}force=1`
        : base;
      const res = await fetch(url, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (
        res.status === 409 &&
        body?.code === 'messages_waiting' &&
        typeof body?.count === 'number'
      ) {
        setWaitingCount(body.count);
        return;
      }
      if (!res.ok) {
        toast.error(body?.error || t('removeFailed'));
        return;
      }
      if (row.provider === 'openwa' && body?.gatewayCleanup === 'incomplete') {
        // The row is gone, but the session may still run a browser and
        // hold a working key on the gateway; only the admin can end it.
        toast.warning(t('openwa.gatewayIncomplete'));
      } else {
        toast.success(t('removed', { name: channelDisplayName(row) }));
      }
      setRemoving(null);
      setWaitingCount(null);
      invalidateNumberCaches();
      await load();
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Jump to this number's credentials and webhook health in the
   * WhatsApp section. Same History-API switch the settings rail uses
   * (see settings/page.tsx) — a router navigation makes an RSC round
   * trip that can stall behind a tunnel, for a page that needs nothing
   * from the server.
   */
  function openConnectionSettings(row: NumberRow) {
    const params = new URLSearchParams(window.location.search);
    params.set('tab', 'whatsapp');
    if (row.provider === 'whapi') params.set('channel', row.id);
    else params.delete('channel');
    window.history.replaceState(null, '', `/settings?${params.toString()}`);
  }

  const filteredMembers = useMemo(() => {
    const q = accessSearch.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) =>
      `${m.full_name ?? ''} ${m.email ?? ''}`.toLowerCase().includes(q)
    );
  }, [members, accessSearch]);

  return (
    <div className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setOpenwaOpen(true)}>
              <QrCode className="size-4" />
              {t('openwa.connectButton')}
            </Button>
            <Button onClick={() => setAddOpen(true)}>
              <Plus className="size-4" />
              {t('addNumber')}
            </Button>
          </div>
        }
      />

      <Alert className="border-border bg-muted/40 mb-5">
        <Users className="size-4" />
        <AlertDescription className="text-muted-foreground space-y-1">
          <p>{t('howShared')}</p>
          <p>{t('howAllocated')}</p>
          <p>{t('howAdmins')}</p>
        </AlertDescription>
      </Alert>

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        </div>
      ) : numbers.length === 0 ? (
        <Card className="border-border bg-card p-8 text-center">
          <Phone className="text-muted-foreground mx-auto size-8" />
          <p className="text-foreground mt-3 text-sm font-medium">
            {t('emptyTitle')}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">{t('emptyBody')}</p>
        </Card>
      ) : (
        <div className="space-y-4">
          {numbers.map((row) => {
            const renaming = renamingId === row.id;
            const rowHealth = health[row.id];
            // A Whapi number whose callback never registered sends fine
            // and receives nothing — the one failure an admin cannot
            // see from the inbox. Fixed on the WhatsApp section.
            const inboundMissing =
              row.provider === 'whapi' && !row.registered_at;
            // OpenWA has no token panel in the WhatsApp section (that
            // section is Whapi's), so its rows get no link there; a lost
            // link is fixed by disconnecting and scanning again.
            const isOpenwa = row.provider === 'openwa';
            const shownPhone = isLinkedDeviceNumber(row.provider)
              ? row.waba_id || rowHealth?.phone
              : rowHealth?.phone;
            const isPersonal = row.is_personal === true;
            const access = savedAccess(row, isLiveMember);
            const teamNames = row.team_ids
              .map((id) => teamById.get(id)?.name)
              .filter((name): name is string => !!name);
            return (
              <Card key={row.id} className="border-border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    {renaming ? (
                      <div className="flex max-w-sm items-center gap-1.5">
                        <Input
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          maxLength={MAX_CHANNEL_LABEL_LEN}
                          autoFocus
                          aria-label={t('nameLabel')}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void saveRename(row);
                            }
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                          className="border-border text-foreground h-8"
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => void saveRename(row)}
                          title={t('saveName')}
                          aria-label={t('saveName')}
                        >
                          <Check className="size-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setRenamingId(null)}
                          title={t('cancel')}
                          aria-label={t('cancel')}
                        >
                          <X className="size-4" />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <h3 className="text-foreground truncate text-sm font-semibold">
                          {channelDisplayName(row)}
                        </h3>
                        {!isPersonal && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="text-muted-foreground size-7"
                            onClick={() => {
                              setRenamingId(row.id);
                              setRenameValue(row.label ?? '');
                            }}
                            title={t('rename')}
                            aria-label={t('rename')}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    )}

                    <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                      {shownPhone ? (
                        <span className="font-mono" dir="ltr">
                          {shownPhone}
                        </span>
                      ) : null}
                      <Badge variant="outline">
                        {row.provider === 'meta'
                          ? t('providerMeta')
                          : row.provider === 'whapi'
                            ? t('providerWhapi')
                            : providerLabel(row.provider)}
                      </Badge>
                      <Badge
                        variant="outline"
                        title={rowHealth?.message}
                        className={
                          rowHealth?.live == null
                            ? 'text-muted-foreground'
                            : rowHealth.live
                              ? 'border-success/30 bg-success-soft text-success'
                              : 'border-warning/30 bg-warning-soft text-warning'
                        }
                      >
                        {rowHealth?.live == null
                          ? t('checking')
                          : rowHealth.live
                            ? t('connected')
                            : t('disconnected')}
                      </Badge>
                      {isPersonal ? (
                        <Badge variant="secondary">
                          {t('personalLabel', {
                            name: row.user_id
                              ? nameOf(row.user_id)
                              : t('unknownMember'),
                          })}
                        </Badge>
                      ) : null}
                      {row.is_primary ? (
                        <Badge className="gap-1">
                          <Star className="size-3" />
                          {t('default')}
                        </Badge>
                      ) : null}
                      <span className="inline-flex items-center gap-1">
                        <MessagesSquare className="size-3" />
                        {row.conversation_count === null
                          ? t('chatCountUnknown')
                          : t('chatCount', { count: row.conversation_count })}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    {busyId === row.id && (
                      <Loader2 className="text-muted-foreground size-4 animate-spin" />
                    )}
                    {!row.is_primary && !isPersonal && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId !== null}
                        onClick={() =>
                          void patchNumber(row, { is_primary: true }).then(
                            (ok) =>
                              ok &&
                              toast.success(
                                t('madeDefault', {
                                  name: channelDisplayName(row),
                                })
                              )
                          )
                        }
                      >
                        <Star className="size-4" />
                        {t('makeDefault')}
                      </Button>
                    )}
                    {!isOpenwa && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title={t('connectionSettings')}
                        aria-label={t('connectionSettings')}
                        onClick={() => openConnectionSettings(row)}
                      >
                        <Settings2 className="size-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      title={t('remove')}
                      aria-label={t('remove')}
                      onClick={() => setRemoving(row)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>

                {(inboundMissing || rowHealth?.live === false) && (
                  <div className="border-warning/30 bg-warning-soft text-warning mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs">
                    <span className="min-w-0">
                      {inboundMissing
                        ? t('inboundMissing')
                        : isOpenwa
                          ? t('openwa.loggedOut')
                          : rowHealth?.message || t('notLive')}
                    </span>
                    {isOpenwa && !inboundMissing && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7"
                        onClick={() => setRescanId(row.id)}
                      >
                        <QrCode className="size-3.5" />
                        {t('openwa.scanAgain')}
                      </Button>
                    )}
                    {!isOpenwa && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7"
                        onClick={() => openConnectionSettings(row)}
                      >
                        {t('fixInWhatsApp')}
                      </Button>
                    )}
                  </div>
                )}

                {!isPersonal && (
                  <div className="border-border bg-muted/30 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2.5">
                    <div className="min-w-0 text-sm">
                      <p className="text-foreground font-medium">
                        {access.adminsOnly
                          ? t('adminsOnlyTitle')
                          : access.shared
                            ? t('sharedTitle')
                            : t('allocatedTitle', {
                                count: access.people.length,
                              })}
                      </p>
                      {teamNames.length > 0 && (
                        <p className="text-muted-foreground mt-0.5 truncate text-xs">
                          {t('teamsLine', { names: teamNames.join(', ') })}
                        </p>
                      )}
                      <p
                        className={
                          access.adminsOnly
                            ? 'text-warning mt-0.5 text-xs'
                            : 'text-muted-foreground mt-0.5 truncate text-xs'
                        }
                      >
                        {access.adminsOnly
                          ? access.teamsEmpty
                            ? t('teamsEmptyShared')
                            : t('adminsOnlyBody')
                          : access.shared
                            ? t('sharedBody')
                            : access.people.map(nameOf).join(', ')}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openAccess(row)}
                      disabled={busyId !== null || !membersLoaded}
                      title={
                        membersLoaded ? undefined : t('membersUnavailable')
                      }
                    >
                      <Users className="size-4" />
                      {t('manageAccess')}
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Who works this number */}
      <Dialog
        open={accessFor !== null}
        onOpenChange={(o) => !o && closeAccess()}
      >
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('accessTitle', {
                name: accessFor ? channelDisplayName(accessFor) : '',
              })}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('accessDesc')}
            </DialogDescription>
          </DialogHeader>

          {teamsLoaded ? (
            teams.length > 0 && (
              <div className="space-y-1.5">
                <Label>{t('teamsHeading')}</Label>
                <div className="border-border bg-muted/40 max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
                  {teams.map((team) => {
                    const count = teamPeople(team).filter((id) =>
                      liveIds.has(id)
                    ).length;
                    return (
                      <label
                        key={team.id}
                        className="text-foreground hover:bg-muted flex items-center gap-2 rounded px-1.5 py-1 text-sm"
                      >
                        <Checkbox
                          checked={accessTeamsDraft.includes(team.id)}
                          onCheckedChange={(next) =>
                            setAccessTeamsDraft((prev) =>
                              next === true
                                ? [...prev, team.id]
                                : prev.filter((x) => x !== team.id)
                            )
                          }
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {team.name}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-xs">
                          {t('teamPeopleCount', { count })}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )
          ) : (
            <div className="border-warning/30 bg-warning-soft text-warning flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs">
              <p>{t(emptyWithoutTeams ? 'teamsNeeded' : 'teamsUnavailable')}</p>
              <Button size="sm" variant="outline" onClick={() => void load()}>
                {t('retry')}
              </Button>
            </div>
          )}

          <Label>{t('peopleHeading')}</Label>
          <Input
            value={accessSearch}
            onChange={(e) => setAccessSearch(e.target.value)}
            placeholder={t('searchMembers')}
            aria-label={t('searchMembers')}
            className="border-border text-foreground"
          />

          <div className="border-border bg-muted/40 max-h-72 space-y-1 overflow-y-auto rounded-md border p-2">
            {filteredMembers.length === 0 ? (
              <p className="text-muted-foreground p-2 text-sm">
                {t('noMembers')}
              </p>
            ) : (
              filteredMembers.map((m) => {
                const viaTeams = draftAccess.viaTeams.get(m.user_id);
                // Reached through a ticked team: shown ticked and locked,
                // because unticking here could not take the number away.
                const checked = !!viaTeams || accessDraft.includes(m.user_id);
                const others = numbers.filter(
                  (n) =>
                    n.id !== accessFor?.id &&
                    savedAccess(n).people.includes(m.user_id)
                );
                return (
                  <label
                    key={m.user_id}
                    className="text-foreground hover:bg-muted flex items-center gap-2 rounded px-1.5 py-1 text-sm"
                  >
                    <Checkbox
                      checked={checked}
                      disabled={!!viaTeams}
                      // Locked by a ticked team: dimmed so it reads as
                      // not clickable next to the hand-ticked rows.
                      className="data-disabled:opacity-50"
                      onCheckedChange={(next) =>
                        setAccessDraft((prev) =>
                          next === true
                            ? [...prev, m.user_id]
                            : prev.filter((x) => x !== m.user_id)
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {m.full_name || m.email}
                      {viaTeams ? (
                        <span className="text-muted-foreground ms-1.5 text-xs">
                          {t('viaTeam', { names: viaTeams.join(', ') })}
                        </span>
                      ) : null}
                      {others.length > 0 ? (
                        <span className="text-muted-foreground ms-1.5 text-xs">
                          {t('alsoOn', {
                            names: others.map(channelDisplayName).join(', '),
                          })}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs capitalize">
                      {tRoles(m.role)}
                    </span>
                  </label>
                );
              })
            )}
          </div>

          {draftAccess.adminsOnly && !draftAccess.teamsEmpty && (
            <p className="border-warning/30 bg-warning-soft text-warning rounded-md border px-3 py-2 text-xs">
              {t('draftAdminsOnly')}
            </p>
          )}
          {draftAccess.teamsEmpty && (
            <p className="border-warning/30 bg-warning-soft text-warning rounded-md border px-3 py-2 text-xs">
              {draftAccess.adminsOnly
                ? t('draftTeamsEmptyShared')
                : t('draftTeamsEmpty')}
            </p>
          )}
          {!draftAccess.adminsOnly && !emptyWithoutTeams && (
            <p className="text-muted-foreground text-xs">
              {draftAccess.shared
                ? t('draftShared')
                : t('draftAllocated', { count: draftAccess.people.length })}
            </p>
          )}

          {accessChanged && accessFor ? (
            <ChangedNotice
              text={
                accessChanged.stored
                  ? t('accessChangedStored', {
                      stored: storedText(accessChanged.stored),
                    })
                  : t('accessChangedUnread')
              }
              busy={rereading}
              label={accessChanged.stored ? undefined : t('retry')}
              onReload={async () => {
                if (accessChanged.stored) openAccess(accessChanged.stored);
                else await readStoredAccess(accessFor);
              }}
            />
          ) : null}

          <DialogFooter>
            {(accessDraft.length > 0 || accessTeamsDraft.length > 0) && (
              <Button
                variant="ghost"
                onClick={() => {
                  setAccessDraft([]);
                  setAccessTeamsDraft([]);
                }}
              >
                {t('clearAll')}
              </Button>
            )}
            <Button variant="ghost" onClick={closeAccess}>
              {t('cancel')}
            </Button>
            <Button
              onClick={() => void saveAccess()}
              disabled={
                busyId !== null || accessChanged !== null || emptyWithoutTeams
              }
            >
              {busyId === accessFor?.id ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              {t('saveAccess')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Connect another Whapi number */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('addTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('addDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-number-name">{t('nameLabel')}</Label>
              <Input
                id="new-number-name"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                maxLength={MAX_CHANNEL_LABEL_LEN}
                placeholder={t('namePlaceholder')}
                className="border-border text-foreground"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-number-token">{t('tokenLabel')}</Label>
              <Input
                id="new-number-token"
                type="password"
                autoComplete="off"
                value={addToken}
                onChange={(e) => setAddToken(e.target.value)}
                placeholder={t('tokenPlaceholder')}
                className="border-border text-foreground font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-number-channel">{t('channelIdLabel')}</Label>
              <Input
                id="new-number-channel"
                value={addChannelId}
                onChange={(e) => setAddChannelId(e.target.value)}
                placeholder={t('channelIdPlaceholder')}
                className="border-border text-foreground font-mono"
              />
              <p className="text-muted-foreground text-xs">
                {t('channelIdHint')}
              </p>
            </div>
            <p className="text-muted-foreground text-xs">{t('addAfterHint')}</p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={() => void handleAdd()}
              disabled={!addToken.trim() || adding}
            >
              {adding ? <Loader2 className="size-4 animate-spin" /> : null}
              {adding ? t('connecting') : t('connect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OpenWAConnectDialog
        open={openwaOpen}
        onOpenChange={setOpenwaOpen}
        onConnected={() => {
          invalidateNumberCaches();
          void load();
        }}
      />

      <OpenWAConnectDialog
        open={rescanId !== null}
        onOpenChange={(o) => !o && setRescanId(null)}
        relinkConfigId={rescanId}
        onConnected={() => {
          invalidateNumberCaches();
          void load();
        }}
      />

      {/* Disconnect */}
      <Dialog
        open={removing !== null}
        onOpenChange={(o) => {
          if (o) return;
          setRemoving(null);
          setWaitingCount(null);
        }}
      >
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('removeTitle', {
                name: removing ? channelDisplayName(removing) : '',
              })}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {waitingCount !== null
                ? t('waitingBody', { count: waitingCount })
                : removing?.provider === 'meta'
                  ? t('removeBodyMeta')
                  : removing?.provider === 'openwa'
                    ? t('openwa.removeBody')
                    : t('removeBody')}
            </DialogDescription>
            {removing ? (
              <p className="text-muted-foreground text-sm">
                {removing.conversation_count === null
                  ? t('removeChatsUnknown')
                  : t('chatCount', { count: removing.conversation_count })}
              </p>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              autoFocus
              onClick={() => {
                setRemoving(null);
                setWaitingCount(null);
              }}
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={() =>
                removing && void handleRemove(removing, waitingCount !== null)
              }
              disabled={busyId !== null}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {waitingCount !== null ? t('removeAnyway') : t('remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
