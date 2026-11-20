'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { toast } from 'sonner';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/use-auth';
import { canEditRule, canManageTeam } from '@/lib/hr/access';
import { agentSettings, setAgentSetting } from '@/lib/hr/agents/api';
import { decideErrorKey } from '@/lib/hr/agents/panel';
import { agentSwitchView } from '@/lib/hr/agents/setup-switches';
import { AGENT_KINDS, type AgentKind } from '@/lib/hr/agents/types';
import { Checkbox } from '@/components/ui/checkbox';
import { canSetHrLines } from '@/lib/auth/roles';
import {
  hrLinesGet,
  hrLinesSet,
  hrMemberSet,
  hrMyRoles,
  hrRuleSet,
  hrRulesList,
  type HrLines,
} from '@/lib/hr/api';
import {
  hrLineRows,
  hrLinesPayload,
  isDirty,
  linesSaveError,
  toggleLine,
  type HrLineChannel,
} from '@/lib/hr/lines-view';
import {
  addableStaff,
  draftOf,
  invalidFields,
  isEmptyPatch,
  ruleHasAfter,
  ruleIsTask,
  rulePatch,
  rulesByInbox,
  ruleTrigger,
  teamByInbox,
  type HrTeamRow,
  type RuleDraft,
} from '@/lib/hr/setup';
import {
  HR_INBOXES,
  type HrErrorCode,
  type HrInbox,
  type HrRoles,
  type HrRule,
  type HrTeamRole,
} from '@/lib/hr/types';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

const NO_ROLES: HrRoles = { admin: false, recruiter: null, dept: null };

/** The saved HR lines and the workspace's numbers; null when either fails. */
async function fetchLineState(
  supabase: ReturnType<typeof createClient>
): Promise<{ lines: HrLines; channels: HrLineChannel[] } | null> {
  try {
    const [lines, list] = await Promise.all([
      hrLinesGet(supabase),
      fetch('/api/whatsapp/channels').then((r) =>
        r.ok ? (r.json() as Promise<{ channels?: HrLineChannel[] }>) : null
      ),
    ]);
    if ('error' in lines || !list) return null;
    return { lines: lines.data, channels: list.channels ?? [] };
  } catch {
    return null;
  }
}
const FIELD =
  'h-8 rounded-md border border-input bg-card px-2 text-sm dark:bg-input/30';

/** HR team (admins edit) and workflow rules (inbox leads and admins edit). */
export default function HrSetupPage() {
  const t = useTranslations('Hr');
  const { accountId, accountRole } = useAuth();
  const { members, nameOf } = useWorkspaceMembers();
  const linesAdmin = !!accountRole && canSetHrLines(accountRole);
  const [lineChannels, setLineChannels] = useState<HrLineChannel[] | null>(
    null
  );
  const [savedLines, setSavedLines] = useState<HrLines | null>(null);
  const [draftLines, setDraftLines] = useState<HrLines | null>(null);
  const [linesFailed, setLinesFailed] = useState(false);
  const [savingLines, setSavingLines] = useState(false);
  const supabase = useMemo(() => createClient(), []);
  const [roles, setRoles] = useState<HrRoles>(NO_ROLES);
  const [team, setTeam] = useState<HrTeamRow[] | null>(null);
  const [teamFailed, setTeamFailed] = useState(false);
  const [teamError, setTeamError] = useState<HrErrorCode | null>(null);
  const [rules, setRules] = useState<HrRule[] | null>(null);
  const [rulesError, setRulesError] = useState<HrErrorCode | null>(null);
  const [agents, setAgents] = useState<Record<AgentKind, boolean> | null>(null);
  const [savingAgents, setSavingAgents] = useState<AgentKind[]>([]);
  const [agentsFailed, setAgentsFailed] = useState(false);
  const [picks, setPicks] = useState<Record<HrInbox, string>>({
    recruiter: '',
    dept: '',
  });

  const loadTeam = useCallback(
    () =>
      supabase
        .from('hr_team_members')
        .select('user_id,inbox,role')
        .then(({ data, error }) => {
          setTeamFailed(!!error);
          if (!error) setTeam((data as HrTeamRow[] | null) ?? []);
        }),
    [supabase]
  );

  useEffect(() => {
    if (!accountId) return;
    void hrMyRoles(supabase).then((r) => {
      if ('data' in r) setRoles(r.data ?? NO_ROLES);
    });
    void loadTeam();
    void agentSettings(supabase).then((r) => {
      if ('data' in r) setAgents(r.data);
      else setAgentsFailed(true);
    });
    void hrRulesList(supabase).then((r) => {
      if ('data' in r) setRules(r.data);
      else setRulesError(r.error);
    });
  }, [accountId, supabase, loadTeam]);

  // Shows a fresh read of the HR lines and numbers (a failed one as such).
  const applyLineState = useCallback(
    (state: Awaited<ReturnType<typeof fetchLineState>>) => {
      if (!state) {
        setLinesFailed(true);
        return;
      }
      setLinesFailed(false);
      setSavedLines(state.lines);
      setDraftLines(state.lines);
      setLineChannels(state.channels);
    },
    []
  );

  // HR lines are owner/admin only, and so is the numbers list.
  useEffect(() => {
    if (!accountId || !linesAdmin) return;
    let cancelled = false;
    void fetchLineState(supabase).then((state) => {
      if (!cancelled) applyLineState(state);
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, linesAdmin, supabase, applyLineState]);

  const lineRows = useMemo(
    () =>
      hrLineRows(
        lineChannels ?? [],
        draftLines?.channel_ids ?? [],
        nameOf,
        (owner) => t('setup.lines.personal', { owner })
      ),
    [lineChannels, draftLines, nameOf, t]
  );
  const linesDirty =
    !!savedLines && !!draftLines && isDirty(savedLines, draftLines);

  async function saveLines() {
    if (!draftLines || savingLines) return;
    setSavingLines(true);
    try {
      const { channelIds, autoOpen, expected } = hrLinesPayload(draftLines);
      const res = await hrLinesSet(supabase, channelIds, autoOpen, expected);
      if ('error' in res) {
        // STALE (another admin saved) and INVALID (a ticked number was
        // deleted) are only fixed by a fresh list: reload, then explain.
        const { key, reload } = linesSaveError(res.error);
        if (reload) applyLineState(await fetchLineState(supabase));
        toast.error(t(key));
        return;
      }
      setSavedLines(res.data);
      setDraftLines(res.data);
      toast.success(t('setup.lines.saved'));
    } finally {
      setSavingLines(false);
    }
  }

  const manage = canManageTeam(roles);
  const byInbox = useMemo(
    () => teamByInbox(team ?? [], nameOf),
    [team, nameOf]
  );
  const ruleGroups = useMemo(() => rulesByInbox(rules ?? []), [rules]);

  const agentView = agentSwitchView(
    roles,
    agents ??
      (Object.fromEntries(AGENT_KINDS.map((k) => [k, false])) as Record<
        AgentKind,
        boolean
      >)
  );

  async function toggleAgent(kind: AgentKind, enabled: boolean) {
    if (savingAgents.includes(kind)) return;
    setSavingAgents((prev) => [...prev, kind]);
    setAgents((prev) => (prev ? { ...prev, [kind]: enabled } : prev));
    try {
      const res = await setAgentSetting(supabase, kind, enabled);
      if ('error' in res) {
        toast.error(t(decideErrorKey(res.error)));
        const fresh = await agentSettings(supabase);
        if ('data' in fresh) setAgents(fresh.data);
      }
    } finally {
      setSavingAgents((prev) => prev.filter((k) => k !== kind));
    }
  }

  async function setMember(
    userId: string,
    inbox: HrInbox,
    role: HrTeamRole | null
  ) {
    setTeamError(null);
    const res = await hrMemberSet(supabase, userId, inbox, role);
    if ('error' in res) setTeamError(res.error);
    else await loadTeam();
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      <h1 className="text-xl font-semibold">{t('setup.title')}</h1>

      <section className="border-border bg-card space-y-3 rounded-lg border p-4">
        <div>
          <h2 className="font-semibold">{t('setup.team.title')}</h2>
          <p className="text-muted-foreground text-sm">
            {t('setup.team.description')}
          </p>
          {!manage && (
            <p className="text-muted-foreground text-sm">
              {t('setup.team.readOnly')}
            </p>
          )}
        </div>
        {teamFailed && (
          <p className="text-destructive text-sm">
            {t('setup.team.loadFailed')}
          </p>
        )}
        {teamError && (
          <p className="text-destructive text-sm">{t(`error.${teamError}`)}</p>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          {HR_INBOXES.map((inbox) => {
            const addable = addableStaff(
              members,
              (team ?? []).filter((r) => r.inbox === inbox)
            );
            return (
              <div key={inbox} className="bg-card-2 space-y-2 rounded-md p-3">
                <h3 className="text-sm font-medium">{t(`inbox.${inbox}`)}</h3>
                {byInbox[inbox].length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    {t('setup.team.empty')}
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {byInbox[inbox].map((entry) => (
                      <li
                        key={entry.user_id}
                        className="flex items-center gap-2 text-sm"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {entry.name}
                        </span>
                        {manage ? (
                          <>
                            <select
                              className={FIELD}
                              value={entry.role}
                              aria-label={entry.name}
                              onChange={(e) =>
                                void setMember(
                                  entry.user_id,
                                  inbox,
                                  e.target.value as HrTeamRole
                                )
                              }
                            >
                              <option value="lead">
                                {t('setup.team.lead')}
                              </option>
                              <option value="member">
                                {t('setup.team.member')}
                              </option>
                            </select>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={t('setup.team.remove')}
                              title={t('setup.team.remove')}
                              onClick={() =>
                                void setMember(entry.user_id, inbox, null)
                              }
                            >
                              <X className="size-4" />
                            </Button>
                          </>
                        ) : (
                          <span className="text-muted-foreground">
                            {t(`setup.team.${entry.role}`)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {manage && (
                  <div className="flex flex-wrap gap-2">
                    <select
                      className={cn(FIELD, 'min-w-0 flex-1')}
                      value={picks[inbox]}
                      aria-label={t('setup.team.pick')}
                      onChange={(e) =>
                        setPicks((p) => ({ ...p, [inbox]: e.target.value }))
                      }
                    >
                      <option value="">{t('setup.team.pick')}</option>
                      {addable.map((p) => (
                        <option key={p.user_id} value={p.user_id}>
                          {p.full_name || p.email}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      disabled={!picks[inbox]}
                      onClick={() => {
                        const userId = picks[inbox];
                        setPicks((p) => ({ ...p, [inbox]: '' }));
                        void setMember(userId, inbox, 'member');
                      }}
                    >
                      {t('setup.team.add')}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {agentView.visible && (
        <section className="border-border bg-card space-y-3 rounded-lg border p-4">
          <div>
            <h2 className="font-semibold">{t('setup.agents.title')}</h2>
            <p className="text-muted-foreground text-sm">
              {t('setup.agents.description')}
            </p>
            <p className="text-warning text-sm">{t('setup.agents.legal')}</p>
            {agentView.disabled.orchestrator && (
              <p className="text-muted-foreground text-sm">
                {t('setup.agents.readOnly')}
              </p>
            )}
          </div>
          {agentsFailed && (
            <p className="text-destructive text-sm">
              {t('setup.agents.loadFailed')}
            </p>
          )}
          {agents && (
            <div className="bg-card-2 space-y-2 rounded-md p-3">
              {AGENT_KINDS.map((kind) => (
                <label
                  key={kind}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  {t(`setup.agents.kinds.${kind}`)}
                  <Switch
                    checked={agents[kind]}
                    disabled={
                      agentView.disabled[kind] || savingAgents.includes(kind)
                    }
                    onCheckedChange={(v: boolean) => void toggleAgent(kind, v)}
                  />
                </label>
              ))}
              {!agents.orchestrator && (
                <p className="text-muted-foreground text-xs">
                  {t('setup.agents.masterOff')}
                </p>
              )}
            </div>
          )}
          <p className="text-muted-foreground text-sm">
            {t('setup.agents.autoSend')}
          </p>
        </section>
      )}

      {linesAdmin && (
        <section className="border-border bg-card space-y-3 rounded-lg border p-4">
          <div>
            <h2 className="font-semibold">{t('setup.lines.title')}</h2>
            <p className="text-muted-foreground text-sm">
              {t('setup.lines.description')}
            </p>
          </div>
          {linesFailed && (
            <p className="text-destructive text-sm">
              {t('setup.lines.loadFailed')}
            </p>
          )}
          {draftLines && lineChannels && (
            <>
              <label className="bg-card-2 flex items-center justify-between gap-2 rounded-md p-3 text-sm">
                {t('setup.lines.autoOpen')}
                <Switch
                  checked={draftLines.auto_open_recruiter}
                  disabled={savingLines}
                  onCheckedChange={(v: boolean) =>
                    setDraftLines((d) =>
                      d ? { ...d, auto_open_recruiter: v } : d
                    )
                  }
                />
              </label>
              {lineRows.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {t('setup.lines.empty')}
                </p>
              ) : (
                <ul className="bg-card-2 divide-border divide-y rounded-md">
                  {lineRows.map((row) => (
                    <li key={row.id}>
                      <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                        <Checkbox
                          checked={row.checked}
                          disabled={savingLines}
                          onCheckedChange={(v) =>
                            setDraftLines((d) =>
                              d ? toggleLine(d, row.id, !!v) : d
                            )
                          }
                        />
                        <span className="min-w-0">
                          <span className="block truncate">{row.title}</span>
                          <span className="text-muted-foreground block truncate text-xs">
                            {row.subtitle}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={!linesDirty || savingLines}
                  onClick={() => void saveLines()}
                >
                  {t('setup.lines.save')}
                </Button>
              </div>
            </>
          )}
        </section>
      )}

      <section className="border-border bg-card space-y-3 rounded-lg border p-4">
        <div>
          <h2 className="font-semibold">{t('setup.rules.title')}</h2>
          <p className="text-muted-foreground text-sm">
            {t('setup.rules.description')}
          </p>
        </div>
        {rulesError && (
          <p className="text-destructive text-sm">
            {t('setup.rules.loadFailed')} {t(`error.${rulesError}`)}
          </p>
        )}
        {rules?.length === 0 && (
          <p className="text-muted-foreground text-sm">
            {t('setup.rules.empty')}
          </p>
        )}
        {HR_INBOXES.map((inbox) =>
          ruleGroups[inbox].length === 0 ? null : (
            <div key={inbox} className="space-y-2">
              <h3 className="text-sm font-medium">{t(`inbox.${inbox}`)}</h3>
              {!canEditRule(roles, inbox) && (
                <p className="text-muted-foreground text-xs">
                  {t('setup.rules.readOnly')}
                </p>
              )}
              {ruleGroups[inbox].map((rule) => (
                <RuleRow
                  // A saved rule remounts its row, resetting the draft.
                  key={`${rule.key}:${rule.updated_at}`}
                  rule={rule}
                  editable={canEditRule(roles, inbox)}
                  onSaved={(saved) =>
                    setRules((prev) =>
                      (prev ?? []).map((r) => (r.key === saved.key ? saved : r))
                    )
                  }
                />
              ))}
            </div>
          )
        )}
      </section>
    </div>
  );
}

function RuleRow({
  rule,
  editable,
  onSaved,
}: {
  rule: HrRule;
  editable: boolean;
  onSaved: (rule: HrRule) => void;
}) {
  const t = useTranslations('Hr');
  const supabase = useMemo(() => createClient(), []);
  const [draft, setDraft] = useState<RuleDraft>(() => draftOf(rule));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const bad = invalidFields(rule, draft);
  const patch = rulePatch(rule, draft);
  const trigger = ruleTrigger(rule);
  const when = t(`setup.trigger.${trigger.key}`, {
    label: trigger.labelKey ? t(trigger.labelKey.replace(/^Hr\./, '')) : '',
    hours: trigger.hours ?? 0,
  });

  async function save() {
    if (bad.length > 0) {
      setFailed(true);
      setMessage(t('setup.rules.invalid'));
      return;
    }
    setSaving(true);
    const res = await hrRuleSet(supabase, rule.key, patch);
    setSaving(false);
    if ('error' in res) {
      setFailed(true);
      setMessage(t(`error.${res.error}`));
    } else {
      setFailed(false);
      setMessage(t('setup.rules.saved'));
      onSaved(res.data);
    }
  }

  const numberField = (field: 'afterHours' | 'dueHours', label: string) => (
    <label className="text-muted-foreground flex flex-col gap-1 text-xs">
      {label}
      <Input
        type="number"
        inputMode="numeric"
        className={cn('h-8 w-24', bad.includes(field) && 'border-destructive')}
        value={draft[field]}
        disabled={!editable}
        aria-invalid={bad.includes(field)}
        onChange={(e) => {
          setMessage(null);
          setDraft((d) => ({ ...d, [field]: e.target.value }));
        }}
      />
    </label>
  );

  return (
    <div className="bg-card-2 space-y-2 rounded-md p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 text-sm">
          <p>
            <span className="text-muted-foreground">
              {t('setup.rules.when')}:{' '}
            </span>
            {when}
          </p>
          <p>
            <span className="text-muted-foreground">
              {t('setup.rules.then')}:{' '}
            </span>
            {ruleIsTask(rule)
              ? t('setup.rules.createTask', { title: rule.title ?? '' })
              : t('setup.rules.markUrgent')}
          </p>
        </div>
        <label className="inline-flex items-center gap-2 text-sm">
          <Switch
            checked={draft.enabled}
            disabled={!editable}
            onCheckedChange={(v: boolean) => {
              setMessage(null);
              setDraft((d) => ({ ...d, enabled: v }));
            }}
          />
          {t('setup.rules.enabled')}
        </label>
      </div>
      {(ruleHasAfter(rule) || ruleIsTask(rule)) && (
        <div className="flex flex-wrap items-end gap-3">
          {ruleHasAfter(rule) &&
            numberField('afterHours', t('setup.rules.afterHours'))}
          {ruleIsTask(rule) &&
            numberField('dueHours', t('setup.rules.dueHours'))}
          {ruleIsTask(rule) && (
            <label className="text-muted-foreground flex min-w-0 flex-1 basis-48 flex-col gap-1 text-xs">
              {t('setup.rules.taskTitle')}
              <Input
                className={cn(
                  'h-8',
                  bad.includes('title') && 'border-destructive'
                )}
                maxLength={300}
                value={draft.title}
                disabled={!editable}
                aria-invalid={bad.includes('title')}
                onChange={(e) => {
                  setMessage(null);
                  setDraft((d) => ({ ...d, title: e.target.value }));
                }}
              />
            </label>
          )}
        </div>
      )}
      {editable && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            disabled={saving || isEmptyPatch(patch)}
            onClick={() => void save()}
          >
            {t('setup.rules.save')}
          </Button>
          {message && (
            <span
              className={cn(
                'text-sm',
                failed ? 'text-destructive' : 'text-success'
              )}
            >
              {message}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
