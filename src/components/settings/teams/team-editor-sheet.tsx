'use client';

// The team editor: name, leader, members and WhatsApp numbers edited as
// one form and saved with ONE PATCH holding only the changed fields
// (`buildTeamPatch`). Nothing is written until Save, so an admin can
// try a selection and back out of it.

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Info, Loader2, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { canLeadTeam } from '@/lib/auth/roles';
import {
  TEAM_NAME_MAX,
  allocationStaysShared,
  buildTeamPatch,
  displayName,
  draftOf,
  isEmptyPatch,
  membershipElsewhere,
  pickableMembers,
  searchMembers,
  teamNameProblem,
  type Team,
  type TeamDraft,
  type TeamPatch,
} from '@/lib/teams/teams';
import { channelNameWithPhone } from '@/lib/whatsapp/channel-management';
import type { AccountNumber } from '@/hooks/use-whatsapp-numbers';
import type { AccountMember } from '@/types';
import { MemberAvatar, RoleChip } from './people';

/** Sentinel for "no leader" — a Select cannot carry an empty value. */
const NO_LEADER = '__none__';

export function TeamEditorSheet({
  team,
  teams,
  members,
  numbers,
  onClose,
  onSave,
}: {
  /** The team being edited; null keeps the sheet closed. */
  team: Team | null;
  teams: Team[];
  members: AccountMember[];
  numbers: AccountNumber[] | null;
  onClose: () => void;
  /** Resolves true when the save stuck (the sheet then closes). */
  onSave: (team: Team, patch: TeamPatch) => Promise<boolean>;
}) {
  // Keyed so reopening (or opening another team) starts from a fresh
  // draft rather than the last one.
  return team ? (
    <EditorBody
      key={team.id}
      team={team}
      teams={teams}
      members={members}
      numbers={numbers}
      onClose={onClose}
      onSave={onSave}
    />
  ) : null;
}

function EditorBody({
  team,
  teams,
  members,
  numbers,
  onClose,
  onSave,
}: {
  team: Team;
  teams: Team[];
  members: AccountMember[];
  numbers: AccountNumber[] | null;
  onClose: () => void;
  onSave: (team: Team, patch: TeamPatch) => Promise<boolean>;
}) {
  const t = useTranslations('Settings.teams');
  const [draft, setDraft] = useState<TeamDraft>(() => draftOf(team));
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const patch = useMemo(() => buildTeamPatch(team, draft), [team, draft]);
  const dirty = !isEmptyPatch(patch);
  const nameProblem = teamNameProblem(draft.name);

  const elsewhere = useMemo(
    () => membershipElsewhere(teams, team.id),
    [teams, team.id]
  );
  const byId = useMemo(
    () => new Map(members.map((m) => [m.user_id, m])),
    [members]
  );
  const leaderOptions = useMemo(
    () =>
      pickableMembers(
        members,
        draft.leader_user_id ? [draft.leader_user_id] : []
      ),
    [members, draft.leader_user_id]
  );
  const memberOptions = useMemo(
    () => searchMembers(pickableMembers(members, draft.member_ids), query),
    [members, draft.member_ids, query]
  );
  const leader = draft.leader_user_id ? byId.get(draft.leader_user_id) : null;

  function toggle(key: 'member_ids' | 'channel_ids', id: string, on: boolean) {
    setDraft((d) => ({
      ...d,
      [key]: on ? [...d[key], id] : d[key].filter((x) => x !== id),
    }));
  }

  function requestClose() {
    if (saving) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  }

  async function save() {
    if (!dirty || nameProblem || saving) return;
    setSaving(true);
    try {
      await onSave(team, patch);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {/* Escape, the close button and an outside click all go through
          the same dirty check as Cancel, so an edit is never dropped
          silently. */}
      <Sheet open onOpenChange={(open) => !open && requestClose()}>
        <SheetContent
          side="right"
          className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
        >
          <SheetHeader className="border-border border-b px-5 py-4 pr-12">
            <SheetTitle className="truncate text-base font-semibold">
              {t('editTitle', { name: team.name })}
            </SheetTitle>
            <SheetDescription>{t('editDesc')}</SheetDescription>
          </SheetHeader>

          <div className="flex-1 space-y-7 overflow-y-auto px-5 py-5">
            {/* Name */}
            <section className="space-y-2">
              <Label htmlFor="team-name">{t('nameLabel')}</Label>
              <Input
                id="team-name"
                value={draft.name}
                maxLength={TEAM_NAME_MAX}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, name: e.target.value }))
                }
                placeholder={t('namePlaceholder')}
                aria-invalid={nameProblem !== null}
              />
              {nameProblem ? (
                <p className="text-destructive text-xs">
                  {nameProblem === 'required'
                    ? t('nameRequired')
                    : t('nameTooLong', { max: TEAM_NAME_MAX })}
                </p>
              ) : null}
            </section>

            {/* Leader */}
            <section className="space-y-2">
              <Label>{t('leaderLabel')}</Label>
              <Select
                value={draft.leader_user_id ?? NO_LEADER}
                onValueChange={(v) =>
                  setDraft((d) => ({
                    ...d,
                    leader_user_id: !v || v === NO_LEADER ? null : String(v),
                  }))
                }
              >
                <SelectTrigger className="h-10 w-full">
                  <SelectValue>
                    {leader ? (
                      <span className="flex min-w-0 items-center gap-2">
                        <MemberAvatar member={leader} size="sm" />
                        <span className="truncate">{displayName(leader)}</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        {t('noLeader')}
                      </span>
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={NO_LEADER}>
                    <span className="text-muted-foreground">
                      {t('noLeader')}
                    </span>
                  </SelectItem>
                  {leaderOptions.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      <MemberAvatar member={m} size="sm" />
                      <span className="truncate">{displayName(m)}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">{t('leaderHint')}</p>
              {leader && !canLeadTeam(leader.role) ? (
                <p className="text-muted-foreground flex gap-1.5 text-xs">
                  <Info className="mt-px size-3.5 shrink-0" />
                  {t('leaderRoleHint', { name: displayName(leader) })}
                </p>
              ) : null}
            </section>

            {/* Members */}
            <section className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <Label>{t('membersLabel')}</Label>
                <span className="text-muted-foreground text-xs">
                  {t('selectedCount', { count: draft.member_ids.length })}
                </span>
              </div>
              <div className="relative">
                <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('searchMembers')}
                  aria-label={t('searchMembers')}
                  className="pl-8"
                />
              </div>
              <ul className="divide-border border-border max-h-80 divide-y overflow-y-auto rounded-lg border">
                {memberOptions.length === 0 ? (
                  <li className="text-muted-foreground px-3 py-6 text-center text-sm">
                    {t('noMatches')}
                  </li>
                ) : (
                  memberOptions.map((m) => {
                    const claimedBy = elsewhere.get(m.user_id);
                    const checked = draft.member_ids.includes(m.user_id);
                    const id = `team-member-${m.user_id}`;
                    return (
                      <li key={m.user_id}>
                        <label
                          htmlFor={id}
                          className={`flex items-center gap-3 px-3 py-2.5 ${
                            claimedBy
                              ? 'cursor-not-allowed opacity-60'
                              : 'hover:bg-muted/50 cursor-pointer'
                          }`}
                        >
                          <Checkbox
                            id={id}
                            checked={checked}
                            disabled={!!claimedBy}
                            onCheckedChange={(next) =>
                              toggle('member_ids', m.user_id, next === true)
                            }
                          />
                          <MemberAvatar member={m} />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="text-foreground truncate text-sm font-medium">
                                {displayName(m)}
                              </span>
                              {m.user_id === draft.leader_user_id ? (
                                <Badge
                                  variant="secondary"
                                  className="h-4 px-1.5 text-[10px]"
                                >
                                  {t('leaderBadge')}
                                </Badge>
                              ) : null}
                            </span>
                            <span className="text-muted-foreground block truncate text-xs">
                              {m.deactivated_at
                                ? t('deactivated')
                                : claimedBy
                                  ? t('inTeam', { name: claimedBy.name })
                                  : m.email}
                            </span>
                          </span>
                          <span className="hidden shrink-0 sm:inline-flex">
                            <RoleChip role={m.role} />
                          </span>
                        </label>
                      </li>
                    );
                  })
                )}
              </ul>
              <p className="text-muted-foreground text-xs">
                {t('oneTeamHint')}
              </p>
            </section>

            {/* WhatsApp numbers */}
            <section className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <Label>{t('numbersLabel')}</Label>
                <span className="text-muted-foreground text-xs">
                  {t('selectedCount', { count: draft.channel_ids.length })}
                </span>
              </div>
              <p className="text-muted-foreground text-xs">
                {t('numbersHint')}
              </p>
              {numbers === null ? (
                <div className="border-border flex justify-center rounded-lg border py-6">
                  <Loader2 className="text-muted-foreground size-4 animate-spin" />
                </div>
              ) : numbers.length === 0 ? (
                <p className="border-border text-muted-foreground rounded-lg border border-dashed px-3 py-6 text-center text-sm">
                  {t('noNumbersConnected')}
                </p>
              ) : (
                <ul className="divide-border border-border divide-y rounded-lg border">
                  {numbers.map((n) => {
                    const id = `team-number-${n.id}`;
                    return (
                      <li key={n.id}>
                        <label
                          htmlFor={id}
                          className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 px-3 py-2.5"
                        >
                          <Checkbox
                            id={id}
                            checked={draft.channel_ids.includes(n.id)}
                            onCheckedChange={(next) =>
                              toggle('channel_ids', n.id, next === true)
                            }
                          />
                          <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                            {channelNameWithPhone(n)}
                          </span>
                          <Badge variant="outline" className="shrink-0">
                            {n.provider === 'meta'
                              ? t('providerMeta')
                              : t('providerWhapi')}
                          </Badge>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              {allocationStaysShared(draft) ? (
                <div className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="mt-px size-3.5 shrink-0" />
                  <span>{t('emptyTeamShared')}</span>
                </div>
              ) : null}
              <p className="text-muted-foreground text-xs">
                {t('numbersIndividualHint')}
              </p>
            </section>
          </div>

          <SheetFooter className="border-border bg-muted/40 flex-row items-center justify-between gap-2 border-t px-5 py-3">
            <span className="text-muted-foreground truncate text-xs">
              {dirty ? t('unsavedChanges') : t('noChanges')}
            </span>
            <div className="flex shrink-0 gap-2">
              <Button
                variant="outline"
                onClick={requestClose}
                disabled={saving}
              >
                {t('cancel')}
              </Button>
              <Button
                onClick={() => void save()}
                disabled={!dirty || nameProblem !== null || saving}
              >
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {saving ? t('saving') : t('save')}
              </Button>
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('discardTitle')}</DialogTitle>
            <DialogDescription>{t('discardBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDiscard(false)}>
              {t('keepEditing')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmDiscard(false);
                onClose();
              }}
            >
              {t('discard')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
