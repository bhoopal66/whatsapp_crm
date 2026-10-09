'use client';

// ============================================================
// Settings -> Teams.
//
// Admins group agents into teams and appoint a leader for each. The
// numbers a team works are shown here but allocated in Numbers and
// access, which owns them. The leader appointment is what
// gives a team_leader their reach: the Team inbox and Team contacts
// views, and the ability to move a chat between the people they lead
// (migration 044). A number allocated to a team is worked by everyone
// in it plus its leader — joining or leaving the team grants or revokes
// that automatically. Everything is enforced in the database; this
// screen only decides what to write.
//
// Edits happen in a sheet and are saved as ONE PATCH of the changed
// fields (lib/teams/teams.ts). The route replaces the member list
// wholesale, so an unchanged list is never sent, and the number list
// is never sent at all.
// ============================================================

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
  UsersRound,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TEAM_ROSTER_CACHE_PREFIX, invalidateCached } from '@/lib/client-cache';
import {
  TEAM_NAME_MAX,
  displayName,
  summarizeTeams,
  teamNameProblem,
  unassignedMembers,
  type Team,
  type TeamPatch,
} from '@/lib/teams/teams';
import {
  useAccountNumbers,
  type AccountNumber,
} from '@/hooks/use-whatsapp-numbers';
import type { AccountMember } from '@/types';
import { SettingsPanelHead } from './settings-panel-head';
import {
  AvatarStack,
  MemberAvatar,
  NumberChip,
  RoleChip,
} from './teams/people';
import { TeamEditorSheet } from './teams/team-editor-sheet';

/** Team membership and number allocation feed several caches. */
function invalidateTeamCaches() {
  // The inbox caches each leader's roster.
  invalidateCached(TEAM_ROSTER_CACHE_PREFIX);
  // Allocations through a team change who works which number.
  invalidateCached('whatsapp-allocations:');
  invalidateCached('whatsapp-channels:');
}

async function readError(res: Response): Promise<string | null> {
  const payload = await res.json().catch(() => ({}));
  return typeof payload?.error === 'string' ? payload.error : null;
}

export function TeamsTab() {
  const t = useTranslations('Settings.teams');

  const [teams, setTeams] = useState<Team[]>([]);
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  // Bumped after a save so the number list re-reads past the cache.
  const [numbersKey, setNumbersKey] = useState(0);
  const numbers = useAccountNumbers(true, numbersKey);

  const [editing, setEditing] = useState<Team | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Team | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setState('loading');
    try {
      const [teamsRes, membersRes] = await Promise.all([
        fetch('/api/account/teams', { cache: 'no-store' }),
        fetch('/api/account/members', { cache: 'no-store' }),
      ]);
      if (!teamsRes.ok || !membersRes.ok) throw new Error('load failed');
      const teamsBody = await teamsRes.json();
      const membersBody = await membersRes.json();
      setTeams(
        ((teamsBody?.teams ?? []) as Team[]).map((x) => ({
          ...x,
          member_ids: x.member_ids ?? [],
          channel_ids: x.channel_ids ?? [],
        }))
      );
      setMembers((membersBody?.members ?? []) as AccountMember[]);
      setState('ready');
    } catch {
      if (!quiet) setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byId = useMemo(
    () => new Map(members.map((m) => [m.user_id, m])),
    [members]
  );
  const numberById = useMemo(
    () => new Map((numbers ?? []).map((n) => [n.id, n])),
    [numbers]
  );
  const summary = useMemo(
    () => summarizeTeams(teams, members),
    [teams, members]
  );
  const unassigned = useMemo(
    () => unassignedMembers(teams, members),
    [teams, members]
  );

  async function handleCreate() {
    const name = newName.trim();
    if (teamNameProblem(name) || creating) return;
    setCreating(true);
    try {
      const res = await fetch('/api/account/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        toast.error((await readError(res)) || t('createFailed'));
        return;
      }
      const payload = await res.json().catch(() => ({}));
      const team = payload.team as Team;
      const created: Team = {
        ...team,
        member_ids: team.member_ids ?? [],
        channel_ids: team.channel_ids ?? [],
      };
      setTeams((prev) => [...prev, created]);
      setNewName('');
      setCreateOpen(false);
      toast.success(t('created', { name }));
      // Straight on to leader, members and numbers.
      setEditing(created);
    } catch {
      toast.error(t('createFailed'));
    } finally {
      setCreating(false);
    }
  }

  async function handleSave(team: Team, patch: TeamPatch): Promise<boolean> {
    try {
      const res = await fetch(`/api/account/teams/${team.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        toast.error((await readError(res)) || t('saveFailed'));
        // The save is one transaction, so nothing changed — but another
        // admin may have; re-read so the overview tells the truth.
        void load(true);
        return false;
      }
      const updated = { ...team, ...patch };
      setTeams((prev) => prev.map((x) => (x.id === team.id ? updated : x)));
      invalidateTeamCaches();
      setNumbersKey((k) => k + 1);
      setEditing(null);
      toast.success(t('saved', { name: updated.name }));
      return true;
    } catch {
      toast.error(t('saveFailed'));
      return false;
    }
  }

  async function handleDelete(team: Team) {
    setDeletingBusy(true);
    try {
      const res = await fetch(`/api/account/teams/${team.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        toast.error((await readError(res)) || t('deleteFailed'));
        return;
      }
      setTeams((prev) => prev.filter((x) => x.id !== team.id));
      setDeleting(null);
      invalidateTeamCaches();
      setNumbersKey((k) => k + 1);
      toast.success(t('deleted', { name: team.name }));
    } catch {
      toast.error(t('deleteFailed'));
    } finally {
      setDeletingBusy(false);
    }
  }

  const createProblem = newName ? teamNameProblem(newName) : 'required';

  return (
    <div className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          state === 'ready' && teams.length > 0 ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              {t('newTeam')}
            </Button>
          ) : null
        }
      />

      {state === 'loading' ? (
        <TeamsSkeleton />
      ) : state === 'error' ? (
        <Card className="items-center gap-0 px-6 py-10 text-center">
          <span className="bg-destructive/10 text-destructive flex size-10 items-center justify-center rounded-full">
            <AlertTriangle className="size-5" />
          </span>
          <p className="text-foreground mt-3 text-sm font-medium">
            {t('loadFailedTitle')}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('loadFailedBody')}
          </p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => void load()}
          >
            <RotateCw className="size-4" />
            {t('retry')}
          </Button>
        </Card>
      ) : teams.length === 0 ? (
        <Card className="items-center gap-0 border-dashed px-6 py-12 text-center">
          <span className="bg-primary/10 text-primary flex size-12 items-center justify-center rounded-full">
            <UsersRound className="size-6" />
          </span>
          <p className="text-foreground mt-4 text-base font-semibold">
            {t('emptyTitle')}
          </p>
          <p className="text-muted-foreground mt-1 max-w-md text-sm">
            {t('emptyBody')}
          </p>
          <Button className="mt-5" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            {t('emptyCta')}
          </Button>
        </Card>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            <Stat value={summary.teams} label={t('summaryTeams')} />
            <Stat value={summary.inTeams} label={t('summaryInTeams')} />
            <Stat
              value={summary.unassigned}
              label={t('summaryUnassigned')}
              attention={summary.unassigned > 0}
            />
          </div>

          <Card className="@container gap-0 overflow-hidden py-0">
            <div className="border-border bg-muted/40 text-muted-foreground hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1.1fr)_6.5rem_minmax(0,1.4fr)_2.25rem] gap-4 border-b px-4 py-2 text-xs font-medium @2xl:grid">
              <span>{t('colTeam')}</span>
              <span>{t('colLeader')}</span>
              <span>{t('colMembers')}</span>
              <span>{t('colNumbers')}</span>
              <span className="sr-only">{t('actions')}</span>
            </div>
            <ul className="divide-border divide-y">
              {teams.map((team) => (
                <TeamRow
                  key={team.id}
                  team={team}
                  byId={byId}
                  numberById={numberById}
                  numbersLoaded={numbers !== null}
                  onEdit={() => setEditing(team)}
                  onDelete={() => setDeleting(team)}
                />
              ))}
            </ul>
          </Card>

          {unassigned.length > 0 ? (
            <section>
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-foreground text-sm font-semibold">
                  {t('unassignedTitle')}
                </h3>
                <Badge variant="secondary">{unassigned.length}</Badge>
              </div>
              <p className="text-muted-foreground mb-3 text-xs">
                {t('unassignedHint')}
              </p>
              <Card className="gap-0 py-0">
                <ul className="divide-border divide-y">
                  {unassigned.map((m) => (
                    <li
                      key={m.user_id}
                      className="flex items-center gap-3 px-4 py-2.5"
                    >
                      <MemberAvatar member={m} />
                      <div className="min-w-0 flex-1">
                        <p className="text-foreground truncate text-sm font-medium">
                          {displayName(m)}
                        </p>
                        {m.email ? (
                          <p className="text-muted-foreground truncate text-xs">
                            {m.email}
                          </p>
                        ) : null}
                      </div>
                      <RoleChip role={m.role} />
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          ) : null}
        </div>
      )}

      <TeamEditorSheet
        team={editing}
        teams={teams}
        members={members}
        numbers={numbers}
        onClose={() => setEditing(null)}
        onSave={handleSave}
      />

      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) setNewName('');
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('newTeam')}</DialogTitle>
            <DialogDescription>{t('newTeamDesc')}</DialogDescription>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('namePlaceholder')}
            maxLength={TEAM_NAME_MAX}
            aria-label={t('nameLabel')}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleCreate();
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={() => void handleCreate()}
              disabled={createProblem !== null || creating}
            >
              {creating ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('createAndEdit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleting !== null}
        onOpenChange={(o) => !o && !deletingBusy && setDeleting(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="text-destructive size-4" />
              {t('deleteTitle', { name: deleting?.name ?? '' })}
            </DialogTitle>
            <DialogDescription>{t('deleteIntro')}</DialogDescription>
          </DialogHeader>
          <ul className="text-muted-foreground list-disc space-y-1.5 pl-5 text-sm">
            <li>
              {t('deleteMembers', {
                count: deleting?.member_ids.length ?? 0,
              })}
            </li>
            <li>{t('deleteNumbers')}</li>
            <li>{t('deleteKeeps')}</li>
          </ul>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleting(null)}
              disabled={deletingBusy}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleting && void handleDelete(deleting)}
              disabled={deletingBusy}
            >
              {deletingBusy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              {t('deleteTeam')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({
  value,
  label,
  attention = false,
}: {
  value: number;
  label: string;
  attention?: boolean;
}) {
  return (
    <Card className="gap-0 px-3 py-3 sm:px-4">
      <span
        className={`text-xl font-semibold tabular-nums sm:text-2xl ${
          attention ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'
        }`}
      >
        {value}
      </span>
      <span className="text-muted-foreground mt-0.5 text-xs leading-tight">
        {label}
      </span>
    </Card>
  );
}

function TeamRow({
  team,
  byId,
  numberById,
  numbersLoaded,
  onEdit,
  onDelete,
}: {
  team: Team;
  byId: Map<string, AccountMember>;
  numberById: Map<string, AccountNumber>;
  numbersLoaded: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('Settings.teams');
  const leader = team.leader_user_id ? byId.get(team.leader_user_id) : null;
  const people = team.member_ids
    .map((id) => byId.get(id))
    .filter((m): m is AccountMember => !!m);
  const allocated = team.channel_ids
    .map((id) => numberById.get(id))
    .filter((n): n is AccountNumber => !!n);
  const emptyButAllocated =
    team.channel_ids.length > 0 && people.length === 0 && !leader;

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-3 px-4 py-4 @2xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1.1fr)_6.5rem_minmax(0,1.4fr)_2.25rem] @2xl:items-center @2xl:gap-4">
      {/* Team */}
      <div className="flex min-w-0 items-center gap-3">
        <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold">
          {Array.from(team.name.trim())[0]?.toLocaleUpperCase() ?? '?'}
        </span>
        <div className="min-w-0">
          <button
            type="button"
            onClick={onEdit}
            title={team.name}
            className="text-foreground line-clamp-2 max-w-full text-left text-sm font-semibold break-words hover:underline"
          >
            {team.name}
          </button>
          <p className="text-muted-foreground text-xs">
            {t('memberCount', { count: team.member_ids.length })}
          </p>
        </div>
      </div>

      {/* Actions — top-right on narrow cards, last column on wide. */}
      <div className="col-start-2 row-start-1 self-start @2xl:col-start-5 @2xl:self-center">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('actionsFor', { name: team.name })}
              />
            }
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil />
              {t('edit')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 />
              {t('deleteTeam')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Leader */}
      <Field label={t('colLeader')}>
        {leader ? (
          <span className="flex min-w-0 items-center gap-2">
            <MemberAvatar member={leader} size="sm" />
            <span className="text-foreground line-clamp-2 text-sm break-words">
              {displayName(leader)}
            </span>
          </span>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            {t('noLeader')}
          </Badge>
        )}
      </Field>

      {/* Members */}
      <Field label={t('colMembers')}>
        {people.length > 0 ? (
          <AvatarStack members={people} />
        ) : (
          <span className="text-muted-foreground text-xs">
            {t('noMembers')}
          </span>
        )}
      </Field>

      {/* Numbers */}
      <Field label={t('colNumbers')}>
        {!numbersLoaded && team.channel_ids.length > 0 ? (
          <Loader2 className="text-muted-foreground size-3.5 animate-spin" />
        ) : allocated.length > 0 ? (
          <div className="flex w-full min-w-0 flex-wrap gap-1.5">
            {allocated.map((n) => (
              <NumberChip key={n.id} number={n} />
            ))}
            {emptyButAllocated ? (
              <span className="w-full text-xs text-amber-700 dark:text-amber-300">
                {t('emptyTeamSharedShort')}
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-muted-foreground text-xs">
            {t('noNumbers')}
          </span>
        )}
      </Field>
    </li>
  );
}

/**
 * A labelled cell: the label shows only where the column header doesn't.
 * Both sides sit in a 24px line box (the avatar's height) and align to
 * the top, so a wrapped value keeps its label beside its first line.
 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="col-span-2 flex min-w-0 items-start gap-3 @2xl:col-span-1 @2xl:block">
      <span className="text-muted-foreground flex min-h-6 w-32 shrink-0 items-center text-xs @2xl:hidden">
        {label}
      </span>
      <div className="flex min-h-6 min-w-0 flex-1 items-center">{children}</div>
    </div>
  );
}

function TeamsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {[0, 1, 2].map((i) => (
          <Card key={i} className="gap-2 px-4 py-3">
            <div className="bg-muted h-6 w-8 animate-pulse rounded" />
            <div className="bg-muted h-3 w-20 animate-pulse rounded" />
          </Card>
        ))}
      </div>
      <Card className="gap-0 py-0">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="border-border flex items-center gap-3 border-b px-4 py-4 last:border-0"
          >
            <div className="bg-muted size-9 animate-pulse rounded-lg" />
            <div className="flex-1 space-y-2">
              <div className="bg-muted h-3.5 w-32 animate-pulse rounded" />
              <div className="bg-muted h-3 w-20 animate-pulse rounded" />
            </div>
            <div className="bg-muted hidden h-6 w-24 animate-pulse rounded-full sm:block" />
            <div className="bg-muted hidden h-6 w-40 animate-pulse rounded md:block" />
          </div>
        ))}
      </Card>
    </div>
  );
}
