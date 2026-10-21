'use client';

// ============================================================
// Settings -> Numbers & access.
//
// One screen for every connected WhatsApp number: what it is called,
// which one is the default, who works it, and — for a second or third
// Whapi number — connecting it in the first place (migration 060).
//
// "Who works it" is the allocation list. A number with nobody on it is
// shared, exactly as before 060. A number with people on it becomes
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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  Check,
  Loader2,
  MessagesSquare,
  Pencil,
  Phone,
  Plus,
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
} from '@/lib/whatsapp/channel-management';
import {
  effectiveAccess,
  savedAccess,
  teamPeople,
  type TeamRoster,
} from '@/lib/whatsapp/team-allocation';
import { SettingsPanelHead } from './settings-panel-head';
import { staffOnly } from '@/lib/account/members';
import type { AccountMember } from '@/types';

interface NumberRow {
  id: string;
  provider: 'whapi' | 'meta';
  label: string | null;
  phone_number_id: string;
  waba_id: string | null;
  is_primary: boolean;
  status: string;
  registered_at: string | null;
  /** People ticked by hand. */
  member_ids: string[];
  /** Teams allocated to the number. */
  team_ids: string[];
  /** People who have the number through one of those teams. */
  team_member_ids: string[];
  conversation_count: number;
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

  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addToken, setAddToken] = useState('');
  const [addChannelId, setAddChannelId] = useState('');
  const [adding, setAdding] = useState(false);

  const [removing, setRemoving] = useState<NumberRow | null>(null);
  const [health, setHealth] = useState<Record<string, NumberHealth>>({});
  // The member roster is what the access dialog edits. If it failed to
  // load, an empty checklist saved back would un-allocate everyone —
  // so access editing is disabled rather than risked.
  const [membersLoaded, setMembersLoaded] = useState(false);
  // Same rule for teams: without the team list the dialog cannot show
  // or save team allocations, so it leaves them untouched.
  const [teams, setTeams] = useState<TeamRoster[]>([]);
  const [teamsLoaded, setTeamsLoaded] = useState(false);

  const load = useCallback(async () => {
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
      setMembers(staffOnly(membersBody?.members ?? []));
      setMembersLoaded(membersRes.ok && Array.isArray(membersBody?.members));
      setTeams(teamsBody?.teams ?? []);
      setTeamsLoaded(teamsRes.ok && Array.isArray(teamsBody?.teams));
      void checkHealth(rows);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

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
  const memberIds = useMemo(
    () => new Set(members.map((m) => m.user_id)),
    [members]
  );
  const teamById = useMemo(
    () => new Map(teams.map((team) => [team.id, team])),
    [teams]
  );

  /** What the access dialog would save, recomputed on every tick. */
  const draftAccess = useMemo(
    () => effectiveAccess(accessDraft, accessTeamsDraft, teams, memberIds),
    [accessDraft, accessTeamsDraft, teams, memberIds]
  );

  async function patchNumber(
    row: NumberRow,
    patch: {
      label?: string;
      member_ids?: string[];
      team_ids?: string[];
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

  function openAccess(row: NumberRow) {
    setAccessFor(row);
    setAccessDraft(row.member_ids);
    setAccessTeamsDraft(row.team_ids);
    setAccessSearch('');
  }

  async function saveAccess() {
    if (!accessFor) return;
    const access = draftAccess;
    // Direct ticks and teams go separately: the server keeps a team's
    // people apart from the hand-ticked ones. Teams are only sent when
    // the team list loaded — otherwise this would clear them.
    const saved = await patchNumber(
      accessFor,
      teamsLoaded
        ? { member_ids: accessDraft, team_ids: accessTeamsDraft }
        : { member_ids: accessDraft },
      teamsLoaded ? { team_member_ids: [...access.viaTeams.keys()] } : {}
    );
    if (saved) {
      toast.success(
        access.shared
          ? t('accessShared', { name: channelDisplayName(accessFor) })
          : t('accessSaved', {
              name: channelDisplayName(accessFor),
              count: access.people.length,
            })
      );
      setAccessFor(null);
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

  async function handleRemove(row: NumberRow) {
    setBusyId(row.id);
    try {
      const url =
        row.provider === 'meta'
          ? '/api/whatsapp/config/meta'
          : `/api/whatsapp/config?config_id=${encodeURIComponent(row.id)}`;
      const res = await fetch(url, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body?.error || t('removeFailed'));
        return;
      }
      toast.success(t('removed', { name: channelDisplayName(row) }));
      setRemoving(null);
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
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="size-4" />
            {t('addNumber')}
          </Button>
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
            const access = savedAccess(row);
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
                          className="border-border bg-muted text-foreground h-8"
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
                      </div>
                    )}

                    <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                      {(
                        row.provider === 'whapi'
                          ? row.waba_id
                          : rowHealth?.phone
                      ) ? (
                        <span className="font-mono">
                          {row.provider === 'whapi'
                            ? row.waba_id
                            : rowHealth?.phone}
                        </span>
                      ) : null}
                      <Badge variant="outline">
                        {row.provider === 'meta'
                          ? t('providerMeta')
                          : t('providerWhapi')}
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
                      {row.is_primary ? (
                        <Badge className="gap-1">
                          <Star className="size-3" />
                          {t('default')}
                        </Badge>
                      ) : null}
                      <span className="inline-flex items-center gap-1">
                        <MessagesSquare className="size-3" />
                        {t('chatCount', { count: row.conversation_count })}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    {busyId === row.id && (
                      <Loader2 className="text-muted-foreground size-4 animate-spin" />
                    )}
                    {!row.is_primary && (
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
                    <Button
                      variant="ghost"
                      size="icon"
                      title={t('connectionSettings')}
                      aria-label={t('connectionSettings')}
                      onClick={() => openConnectionSettings(row)}
                    >
                      <Settings2 className="size-4" />
                    </Button>
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
                        : rowHealth?.message || t('notLive')}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7"
                      onClick={() => openConnectionSettings(row)}
                    >
                      {t('fixInWhatsApp')}
                    </Button>
                  </div>
                )}

                <div className="border-border bg-muted/30 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2.5">
                  <div className="min-w-0 text-sm">
                    <p className="text-foreground font-medium">
                      {access.shared
                        ? t('sharedTitle')
                        : t('allocatedTitle', { count: access.people.length })}
                    </p>
                    {teamNames.length > 0 && (
                      <p className="text-muted-foreground mt-0.5 truncate text-xs">
                        {t('teamsLine', { names: teamNames.join(', ') })}
                      </p>
                    )}
                    <p
                      className={
                        access.teamsEmpty && access.shared
                          ? 'text-warning mt-0.5 text-xs'
                          : 'text-muted-foreground mt-0.5 truncate text-xs'
                      }
                    >
                      {access.shared
                        ? access.teamsEmpty
                          ? t('teamsEmptyShared')
                          : t('sharedBody')
                        : access.people.map(nameOf).join(', ')}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openAccess(row)}
                    disabled={busyId !== null || !membersLoaded}
                    title={membersLoaded ? undefined : t('membersUnavailable')}
                  >
                    <Users className="size-4" />
                    {t('manageAccess')}
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Who works this number */}
      <Dialog
        open={accessFor !== null}
        onOpenChange={(o) => !o && setAccessFor(null)}
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
                      memberIds.has(id)
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
            <p className="text-muted-foreground text-xs">
              {t('teamsUnavailable')}
            </p>
          )}

          <Label>{t('peopleHeading')}</Label>
          <Input
            value={accessSearch}
            onChange={(e) => setAccessSearch(e.target.value)}
            placeholder={t('searchMembers')}
            aria-label={t('searchMembers')}
            className="border-border bg-muted text-foreground"
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
                        <span className="text-muted-foreground ml-1.5 text-xs">
                          {t('viaTeam', { names: viaTeams.join(', ') })}
                        </span>
                      ) : null}
                      {others.length > 0 ? (
                        <span className="text-muted-foreground ml-1.5 text-xs">
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

          {draftAccess.teamsEmpty && (
            <p className="border-warning/30 bg-warning-soft text-warning rounded-md border px-3 py-2 text-xs">
              {draftAccess.shared
                ? t('draftTeamsEmptyShared')
                : t('draftTeamsEmpty')}
            </p>
          )}
          {!(draftAccess.teamsEmpty && draftAccess.shared) && (
            <p className="text-muted-foreground text-xs">
              {draftAccess.shared
                ? t('draftShared')
                : t('draftAllocated', { count: draftAccess.people.length })}
            </p>
          )}

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
            <Button variant="ghost" onClick={() => setAccessFor(null)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={() => void saveAccess()}
              disabled={busyId !== null}
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
                className="border-border bg-muted text-foreground"
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
                className="border-border bg-muted text-foreground font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-number-channel">{t('channelIdLabel')}</Label>
              <Input
                id="new-number-channel"
                value={addChannelId}
                onChange={(e) => setAddChannelId(e.target.value)}
                placeholder={t('channelIdPlaceholder')}
                className="border-border bg-muted text-foreground font-mono"
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

      {/* Disconnect */}
      <Dialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
      >
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('removeTitle', {
                name: removing ? channelDisplayName(removing) : '',
              })}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {removing?.provider === 'meta'
                ? t('removeBodyMeta')
                : t('removeBody')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={() => removing && void handleRemove(removing)}
              disabled={busyId !== null}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
