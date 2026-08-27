'use client';

// ============================================================
// Settings -> Teams.
//
// Admins group agents into teams and appoint a leader for each. That
// appointment is what gives a team_leader their reach: the Team inbox
// and Team contacts views, and the ability to move a chat between the
// people they lead. Everything is enforced in the database
// (migration 044) — this screen only decides what to write.
//
// A person belongs to at most one team, so the member checkboxes below
// show who is already spoken for rather than letting an admin build a
// selection the database will reject.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2, Plus, Trash2, UsersRound } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SettingsPanelHead } from './settings-panel-head';
import type { AccountMember } from '@/types';

interface Team {
  id: string;
  name: string;
  leader_user_id: string | null;
  member_ids: string[];
}

/** Sentinel for "no leader" — a Select cannot carry an empty value. */
const NO_LEADER = '__none__';

export function TeamsTab() {
  const t = useTranslations('Settings.teams');

  const [teams, setTeams] = useState<Team[]>([]);
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Team | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [teamsRes, membersRes] = await Promise.all([
      fetch('/api/account/teams', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/account/members', { cache: 'no-store' }).then((r) => r.json()),
    ]);
    setTeams(teamsRes?.teams ?? []);
    setMembers(membersRes?.members ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const nameOf = (userId: string | null) => {
    if (!userId) return null;
    const m = members.find((x) => x.user_id === userId);
    return m?.full_name || m?.email || t('unknownMember');
  };

  /** Which OTHER team already holds this person, if any. */
  const otherTeamOf = (userId: string, exceptTeamId: string) =>
    teams.find((x) => x.id !== exceptTeamId && x.member_ids.includes(userId));

  async function patchTeam(team: Team, patch: Partial<Team>) {
    setSavingId(team.id);
    // Optimistic: these are checkbox and dropdown edits, and waiting
    // for a round trip before the control moves feels broken.
    const previous = teams;
    setTeams((prev) => prev.map((x) => (x.id === team.id ? { ...x, ...patch } : x)));
    try {
      const res = await fetch(`/api/account/teams/${team.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTeams(previous);
        toast.error(payload?.error || t('saveFailed'));
      }
    } catch {
      setTeams(previous);
      toast.error(t('saveFailed'));
    } finally {
      setSavingId(null);
    }
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const res = await fetch('/api/account/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload?.error || t('createFailed'));
        return;
      }
      setTeams((prev) => [...prev, payload.team as Team]);
      setNewName('');
      setCreateOpen(false);
      toast.success(t('created', { name }));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(team: Team) {
    const res = await fetch(`/api/account/teams/${team.id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error(t('deleteFailed'));
      return;
    }
    setTeams((prev) => prev.filter((x) => x.id !== team.id));
    setDeleting(null);
    toast.success(t('deleted', { name: team.name }));
  }

  return (
    <div className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            {t('newTeam')}
          </Button>
        }
      />

      {loading ? (
        <div className="mt-6 flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : teams.length === 0 ? (
        <Card className="mt-6 border-border bg-card p-8 text-center">
          <UsersRound className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium text-foreground">{t('emptyTitle')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('emptyBody')}</p>
        </Card>
      ) : (
        <div className="mt-6 space-y-4">
          {teams.map((team) => (
            <Card key={team.id} className="border-border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-foreground">
                    {team.name}
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {team.leader_user_id
                      ? t('ledBy', { name: nameOf(team.leader_user_id) ?? '' })
                      : t('noLeader')}
                    {' · '}
                    {t('memberCount', { count: team.member_ids.length })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {savingId === team.id && (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setDeleting(team)}
                    title={t('deleteTeam')}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-muted-foreground">{t('leaderLabel')}</Label>
                  <Select
                    value={team.leader_user_id ?? NO_LEADER}
                    onValueChange={(v) =>
                      patchTeam(team, {
                        leader_user_id: v === NO_LEADER ? null : v,
                      })
                    }
                  >
                    <SelectTrigger className="w-full border-border bg-muted text-foreground">
                      <SelectValue>
                        {nameOf(team.leader_user_id) ?? t('noLeader')}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_LEADER}>{t('noLeader')}</SelectItem>
                      {members.map((m) => (
                        <SelectItem key={m.user_id} value={m.user_id}>
                          {m.full_name || m.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{t('leaderHint')}</p>
                </div>

                <div className="space-y-2">
                  <Label className="text-muted-foreground">{t('membersLabel')}</Label>
                  <div className="max-h-44 space-y-1.5 overflow-y-auto rounded-md border border-border bg-muted/40 p-2">
                    {members.map((m) => {
                      const claimed = otherTeamOf(m.user_id, team.id);
                      const checked = team.member_ids.includes(m.user_id);
                      return (
                        <label
                          key={m.user_id}
                          className="flex items-center gap-2 text-sm text-foreground"
                        >
                          <Checkbox
                            checked={checked}
                            disabled={!!claimed}
                            onCheckedChange={(next) => {
                              const ids = next === true
                                ? [...team.member_ids, m.user_id]
                                : team.member_ids.filter((x) => x !== m.user_id);
                              patchTeam(team, { member_ids: ids });
                            }}
                          />
                          <span className="truncate">{m.full_name || m.email}</span>
                          {claimed && (
                            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                              {t('inTeam', { name: claimed.name })}
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('newTeam')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('newTeamDesc')}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('namePlaceholder')}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleCreate();
              }
            }}
            className="border-border bg-muted text-foreground"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              {t('cancel')}
            </Button>
            <Button onClick={() => void handleCreate()} disabled={!newName.trim() || creating}>
              {creating ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('deleteTitle', { name: deleting?.name ?? '' })}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('deleteBody')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={() => deleting && void handleDelete(deleting)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('deleteTeam')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
