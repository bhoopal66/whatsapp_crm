'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  channelTeams,
  setChannelAudience,
  setChannelPolicy,
  type ChannelRule,
  type ChannelWithMembership,
} from '@/lib/chat';
import {
  AUDIENCE_ROLE_OPTIONS,
  POLICY_FIELDS,
  audienceChanged,
  audienceMinRole,
  audienceRoleOption,
  audienceSummary,
  filterTeams,
  policyChanges,
  policyOf,
  type AudienceForm,
  type AudienceRoleOption,
  type AudienceSummary,
  type ChannelPolicy,
} from '@/lib/chat/channel-rules';
import { channelAdminErrorKey } from '@/lib/chat/view';

import { useChatWorkspaceContext } from './chat-context';
import { GREEN_BUTTON } from './dm-picker';

export interface TeamOption {
  id: string;
  name: string;
}

export interface ChannelAudienceState {
  /** The channel's teams; null while loading or on a failed read. */
  teamIds: string[] | null;
  /** The workspace's teams by name; null while loading or on failure. */
  teams: TeamOption[] | null;
  failed: boolean;
}

/**
 * A team channel's chosen teams (chat_channel_teams, 159) and the
 * workspace's team names. Teams are read straight from `teams` under RLS
 * (044: any member may read the roster), not /api/account/teams, which is
 * admin-only while a channel admin may be an agent. Re-read whenever the
 * channel row changes: an audience save updates the row, and realtime
 * hands every viewer a fresh one.
 */
export function useChannelAudience(
  channel: ChannelWithMembership
): ChannelAudienceState {
  const ws = useChatWorkspaceContext();
  const isTeam = channel.kind === 'team';
  const [state, setState] = useState<ChannelAudienceState>({
    teamIds: null,
    teams: null,
    failed: false,
  });
  useEffect(() => {
    if (!isTeam) return;
    let cancelled = false;
    void Promise.all([
      channelTeams(ws.sb, channel.id),
      ws.sb
        .from('teams')
        .select('id, name')
        .eq('account_id', channel.accountId)
        .order('name', { ascending: true }),
    ])
      .then(([teamIds, { data, error }]) => {
        if (cancelled) return;
        if (error) throw error;
        setState({
          teamIds,
          teams: ((data ?? []) as TeamOption[]).map((r) => ({
            id: String(r.id),
            name: String(r.name),
          })),
          failed: false,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ teamIds: null, teams: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
    // The channel object, not only its id: a fresh row means a re-read.
  }, [ws.sb, isTeam, channel]);
  return state;
}

/** One line for an AudienceSummary (Chat.rules.summary*). */
export function audienceSummaryText(
  t: ReturnType<typeof useTranslations<'Chat'>>,
  s: AudienceSummary
): string {
  if (s.kind === 'everyone') return t('rules.summaryEveryone');
  if (s.kind === 'adminsOnly') return t('rules.summaryAdminsOnly');
  const teams = s.teams.join(', ');
  if (s.role === 'all') return t('rules.summaryTeams', { teams });
  return s.teams.length > 0
    ? t('rules.summaryRoleTeams', { role: s.role, teams })
    : t('rules.summaryRole', { role: s.role });
}

/** Posting permissions (157): three Everyone / Only channel admins choices. */
export function ChannelPolicyForm({
  channel,
  onDone,
}: {
  channel: ChannelWithMembership;
  onDone: () => void;
}) {
  const t = useTranslations('Chat');
  const ws = useChatWorkspaceContext();
  const stored = policyOf(channel);
  const [form, setForm] = useState<ChannelPolicy>(stored);
  const [busy, setBusy] = useState(false);
  const changes = policyChanges(stored, form);

  const save = async () => {
    if (!changes || busy) return;
    setBusy(true);
    try {
      await setChannelPolicy(ws.sb, channel.id, changes);
      toast.success(t('rules.policySaved'));
      await ws.reloadChannels();
      onDone();
    } catch (err) {
      toast.error(t(channelAdminErrorKey('edit', err)));
      setBusy(false);
    }
  };

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t('rules.policyTitle')}</DialogTitle>
        <DialogDescription>{t('rules.policyBody')}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        {POLICY_FIELDS.map((field) => (
          <fieldset key={field} className="space-y-2">
            <legend className="mb-2 text-sm font-medium">
              {t(`rules.field.${field}`)}
            </legend>
            <RadioGroup
              value={form[field]}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, [field]: v as ChannelRule }))
              }
              className="flex flex-wrap gap-x-5 gap-y-2"
            >
              {(['everyone', 'admins'] as const).map((rule) => (
                <Label
                  key={rule}
                  className="flex items-center gap-2 font-normal"
                >
                  <RadioGroupItem value={rule} />
                  {t(`rules.${rule}`)}
                </Label>
              ))}
            </RadioGroup>
          </fieldset>
        ))}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t('settings.cancel')}
        </Button>
        <Button
          type="submit"
          className={GREEN_BUTTON}
          disabled={!changes || busy}
        >
          {busy ? t('settings.saving') : t('settings.save')}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Who can see a team channel (159): a minimum role and optional teams. */
export function ChannelAudienceForm({
  channel,
  onDone,
}: {
  channel: ChannelWithMembership;
  onDone: () => void;
}) {
  const t = useTranslations('Chat');
  const ws = useChatWorkspaceContext();
  const loaded = useChannelAudience(channel);
  const [role, setRole] = useState<AudienceRoleOption>(
    audienceRoleOption(channel.audienceMinRole)
  );
  // Null until the user touches the teams: the stored set fills it in.
  const [picked, setPicked] = useState<string[] | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const storedTeamIds = loaded.teamIds;
  const teamIds = picked ?? storedTeamIds ?? [];
  const stored: AudienceForm = {
    role: audienceRoleOption(channel.audienceMinRole),
    teamIds: storedTeamIds ?? [],
  };
  const form: AudienceForm = { role, teamIds };
  const ready = storedTeamIds !== null && loaded.teams !== null;
  const changed = ready && audienceChanged(stored, form);
  const teams = useMemo(() => loaded.teams ?? [], [loaded.teams]);
  const shown = filterTeams(teams, query);
  const summary = audienceSummaryText(t, audienceSummary(form, teams));

  const toggle = (id: string, on: boolean) =>
    setPicked(
      on ? [...new Set([...teamIds, id])] : teamIds.filter((x) => x !== id)
    );

  const save = async () => {
    if (!changed || busy) return;
    setBusy(true);
    try {
      await setChannelAudience(ws.sb, channel.id, {
        minRole: audienceMinRole(role),
        teamIds: [...teamIds],
      });
      toast.success(t('rules.audienceSaved'));
      await ws.reloadChannels();
      onDone();
    } catch (err) {
      toast.error(t(channelAdminErrorKey('edit', err)));
      setBusy(false);
    }
  };

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t('rules.audienceTitle')}</DialogTitle>
        <DialogDescription>{t('rules.audienceBody')}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">
            {t('rules.minRole')}
          </legend>
          <RadioGroup
            value={role}
            onValueChange={(v) => setRole(v as AudienceRoleOption)}
            className="grid grid-cols-2 gap-2"
          >
            {AUDIENCE_ROLE_OPTIONS.map((o) => (
              <Label key={o} className="flex items-center gap-2 font-normal">
                <RadioGroupItem value={o} />
                {t(`rules.role.${o}`)}
              </Label>
            ))}
          </RadioGroup>
        </fieldset>
        <div className="space-y-2">
          <Label htmlFor="channel-audience-teams">
            {t('rules.teams')}{' '}
            <span className="text-muted-foreground font-normal">
              {t('settings.optional')}
            </span>
          </Label>
          {loaded.failed ? (
            <p className="text-destructive text-xs" role="alert">
              {t('rules.teamsFailed')}
            </p>
          ) : !ready ? (
            <p className="text-muted-foreground text-xs">
              {t('rules.loading')}
            </p>
          ) : teams.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {t('rules.noTeams')}
            </p>
          ) : (
            <>
              <Input
                id="channel-audience-teams"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('rules.teamsSearch')}
                autoComplete="off"
              />
              <ul className="bg-card-2 max-h-44 space-y-1 overflow-y-auto rounded-md border p-2">
                {shown.length === 0 ? (
                  <li className="text-muted-foreground px-1 text-xs">
                    {t('rules.noTeamMatch')}
                  </li>
                ) : (
                  shown.map((team) => (
                    <li key={team.id}>
                      <Label className="hover:bg-muted flex items-center gap-2 rounded px-1 py-1 font-normal">
                        <Checkbox
                          checked={teamIds.includes(team.id)}
                          onCheckedChange={(on) => toggle(team.id, on === true)}
                        />
                        <span className="truncate">{team.name}</span>
                      </Label>
                    </li>
                  ))
                )}
              </ul>
              <p className="text-muted-foreground text-xs">
                {t('rules.teamsHint')}
              </p>
            </>
          )}
        </div>
        <p
          className="bg-info-soft text-info rounded-md px-3 py-2 text-xs font-medium"
          aria-live="polite"
        >
          {summary}
        </p>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t('settings.cancel')}
        </Button>
        <Button
          type="submit"
          className={GREEN_BUTTON}
          disabled={!changed || busy}
        >
          {busy ? t('settings.saving') : t('settings.save')}
        </Button>
      </DialogFooter>
    </form>
  );
}
