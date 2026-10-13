'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import {
  applyExtensionPatch,
  canEditExtension,
  enforcedRetention,
  extensionState,
  parseDueMinutes,
  parseRetentionDays,
  retentionNeedsConfirm,
  rulesBody,
  sendsRetention,
  validateBankNumbers,
  validateRoutes,
  workspaceChangePatch,
  type BankNumberRowIssues,
  type ExtensionPatch,
  type MappableWorkspace,
  type PbxExtensionView,
  type RecordingRules,
  type RouteRowIssues,
} from '@/lib/pbx/admin-ui';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

import { CheckRow } from './connection-dialog';
import { DOT, pbxFetch } from './fetch';

export interface RouteView {
  didNumber: string;
  nameOnPbx: string | null;
  accountId: string;
}
interface RouteRow {
  key: number;
  didNumber: string;
  nameOnPbx: string;
  accountId: string | null;
}

let nextKey = 0;
const NONE = '__none__';

function Card({
  title,
  action,
  className,
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        'border-border bg-card min-w-0 rounded-xl border p-4',
        className
      )}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-foreground text-base font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

const Issue = ({ text }: { text: string | null }) =>
  text ? <p className="text-destructive mt-1 text-xs">{text}</p> : null;

// ---------- Phone numbers → workspace ----------

export function RoutesCard({
  connected,
  onRoutes,
}: {
  connected: boolean;
  onRoutes: (routes: RouteView[]) => void;
}) {
  const t = useTranslations('Settings.phoneSystem');
  const { workspaces: mine } = useAuth();
  const [rows, setRows] = useState<RouteRow[]>([]);
  const [admin, setAdmin] = useState<{ accountId: string; name: string }[]>([]);
  const [issues, setIssues] = useState<RouteRowIssues[]>([]);
  const [saving, setSaving] = useState(false);

  const take = useCallback(
    (data: { routes: RouteView[]; workspaces: typeof admin }) => {
      setRows(
        data.routes.map((r) => ({
          key: nextKey++,
          didNumber: r.didNumber,
          nameOnPbx: r.nameOnPbx ?? '',
          accountId: r.accountId,
        }))
      );
      setAdmin(data.workspaces);
      setIssues([]);
      onRoutes(data.routes);
    },
    [onRoutes]
  );

  useEffect(() => {
    void pbxFetch<{ routes: RouteView[]; workspaces: typeof admin }>(
      '/api/pbx/routes'
    ).then((res) => {
      if (res.ok) take(res.data);
    });
  }, [take]);

  const nameOf = (id: string | null) =>
    admin.find((w) => w.accountId === id)?.name ??
    mine.find((w) => w.accountId === id)?.name ??
    t('routes.otherWorkspace');
  const edit = (key: number, patch: Partial<RouteRow>) =>
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, ...patch } : r))
    );

  const save = async () => {
    const checked = validateRoutes(rows);
    if (!checked.ok) return setIssues(checked.issues);
    setSaving(true);
    const res = await pbxFetch<{
      routes: RouteView[];
      workspaces: typeof admin;
    }>('/api/pbx/routes', { method: 'PUT', body: checked.payload });
    setSaving(false);
    if (res.ok) {
      take(res.data);
      toast.success(t('routes.saved'));
    } else
      toast.error(t('saveFailed'), { description: res.error ?? undefined });
  };

  return (
    <Card title={t('routes.title')}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('routes.number')}</TableHead>
            <TableHead>{t('routes.nameOnPbx')}</TableHead>
            <TableHead>{t('routes.workspace')}</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-muted-foreground">
                {t('routes.empty')}
              </TableCell>
            </TableRow>
          ) : null}
          {rows.map((r, i) => {
            const issue = issues[i] ?? {};
            const options = admin.some((w) => w.accountId === r.accountId)
              ? admin
              : r.accountId
                ? [
                    ...admin,
                    { accountId: r.accountId, name: nameOf(r.accountId) },
                  ]
                : admin;
            return (
              <TableRow key={r.key} className="align-top">
                <TableCell className="min-w-36">
                  <Input
                    inputMode="tel"
                    value={r.didNumber}
                    aria-label={t('routes.number')}
                    onChange={(e) => edit(r.key, { didNumber: e.target.value })}
                  />
                  <Issue
                    text={
                      issue.number ? t(`routes.issues.${issue.number}`) : null
                    }
                  />
                </TableCell>
                <TableCell className="min-w-36">
                  <Input
                    value={r.nameOnPbx}
                    aria-label={t('routes.nameOnPbx')}
                    onChange={(e) => edit(r.key, { nameOnPbx: e.target.value })}
                  />
                  <Issue
                    text={issue.name ? t(`routes.issues.${issue.name}`) : null}
                  />
                </TableCell>
                <TableCell className="min-w-44">
                  <Select
                    value={r.accountId ?? NONE}
                    onValueChange={(v) =>
                      edit(r.key, { accountId: v === NONE ? null : String(v) })
                    }
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label={t('routes.workspace')}
                    >
                      <SelectValue>
                        {r.accountId
                          ? nameOf(r.accountId)
                          : t('routes.pickWorkspace')}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {options.map((w) => (
                        <SelectItem key={w.accountId} value={w.accountId}>
                          {w.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Issue
                    text={
                      issue.workspace
                        ? t(`routes.issues.${issue.workspace}`)
                        : null
                    }
                  />
                </TableCell>
                <TableCell>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('routes.remove')}
                    onClick={() => {
                      setRows((prev) => prev.filter((x) => x.key !== r.key));
                      setIssues([]);
                    }}
                  >
                    <Trash2 />
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <div className="mt-3 flex flex-wrap justify-between gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setRows((prev) => [
              ...prev,
              {
                key: nextKey++,
                didNumber: '',
                nameOnPbx: '',
                accountId: admin.length === 1 ? admin[0].accountId : null,
              },
            ])
          }
        >
          <Plus />
          {t('routes.add')}
        </Button>
        <Button size="sm" onClick={save} disabled={saving || !connected}>
          {saving ? <Loader2 className="animate-spin" /> : null}
          {t('routes.save')}
        </Button>
      </div>
    </Card>
  );
}

// ---------- Extensions → people ----------

export function ExtensionsCard({
  connected,
  onChanged,
}: {
  connected: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations('Settings.phoneSystem');
  const tx = useTranslations('Settings.phoneSystem.extensions');
  const { workspaces: mine } = useAuth();
  const [rows, setRows] = useState<PbxExtensionView[]>([]);
  const [workspaces, setWorkspaces] = useState<MappableWorkspace[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    void pbxFetch<{
      extensions: PbxExtensionView[];
      workspaces: MappableWorkspace[];
    }>('/api/pbx/extensions').then((res) => {
      if (!res.ok) return;
      setRows(res.data.extensions);
      setWorkspaces(res.data.workspaces);
    });
  }, []);

  const wsName = (id: string) =>
    workspaces.find((w) => w.accountId === id)?.name ??
    mine.find((w) => w.accountId === id)?.name ??
    t('routes.otherWorkspace');

  const sync = async () => {
    setSyncing(true);
    const res = await pbxFetch<{
      extensions: PbxExtensionView[];
      total: number;
      added: number;
    }>('/api/pbx/extensions/sync', { method: 'POST' });
    setSyncing(false);
    if (res.ok) {
      setRows(res.data.extensions);
      toast.success(
        tx('synced', { total: res.data.total, added: res.data.added })
      );
      onChanged();
    } else
      toast.error(tx('syncFailed'), { description: res.error ?? undefined });
  };

  // Optimistic, one request per row at a time; an error puts the row back.
  const patch = async (row: PbxExtensionView, p: ExtensionPatch) => {
    const flag = (on: boolean) =>
      setBusy((prev) => {
        const next = new Set(prev);
        if (on) next.add(row.id);
        else next.delete(row.id);
        return next;
      });
    const put = (v: PbxExtensionView) =>
      setRows((prev) => prev.map((r) => (r.id === row.id ? v : r)));
    put(applyExtensionPatch(row, p, workspaces));
    flag(true);
    const res = await pbxFetch<{ extension: PbxExtensionView }>(
      `/api/pbx/extensions/${row.id}`,
      { method: 'PATCH', body: p }
    );
    flag(false);
    if (res.ok) {
      put({ ...res.data.extension, callerIdName: row.callerIdName });
      onChanged();
    } else {
      put(row);
      toast.error(tx('saveFailed', { extension: row.extension }), {
        description: res.error ?? undefined,
      });
    }
  };

  return (
    <Card
      title={tx('title')}
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={sync}
          disabled={syncing || !connected}
        >
          {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {tx('sync')}
        </Button>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{tx('extension')}</TableHead>
            <TableHead>{tx('person')}</TableHead>
            <TableHead>{tx('workspace')}</TableHead>
            <TableHead>{tx('softphone')}</TableHead>
            <TableHead>{tx('showStatus')}</TableHead>
            <TableHead>{tx('state')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={6}
                className="text-muted-foreground whitespace-normal"
              >
                {tx('empty')}
              </TableCell>
            </TableRow>
          ) : null}
          {rows.map((row) => {
            const editable =
              canEditExtension(row, workspaces) && !busy.has(row.id);
            const people =
              workspaces.find((w) => w.accountId === row.accountId)?.people ??
              [];
            const { state, tone } = extensionState(row);
            return (
              <TableRow key={row.id}>
                <TableCell className="font-medium">
                  {row.extension}
                  {row.callerIdName ? (
                    <span className="text-muted-foreground block text-xs font-normal">
                      {row.callerIdName}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="min-w-44">
                  {row.mapped && !row.userId ? (
                    <span className="text-muted-foreground">
                      {tx('mappedElsewhere')}
                    </span>
                  ) : (
                    <Select
                      value={row.userId ?? NONE}
                      disabled={!editable}
                      onValueChange={(v) =>
                        patch(row, { userId: v === NONE ? null : String(v) })
                      }
                    >
                      <SelectTrigger
                        className="w-full"
                        aria-label={tx('person')}
                      >
                        <SelectValue>
                          {row.userId
                            ? (row.personName ?? row.userId.slice(0, 8))
                            : tx('notMapped')}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>{tx('notMapped')}</SelectItem>
                        {people.map((p) => (
                          <SelectItem key={p.userId} value={p.userId}>
                            {p.name ?? p.userId.slice(0, 8)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </TableCell>
                <TableCell className="min-w-40">
                  {editable && workspaces.length > 1 ? (
                    <Select
                      value={row.accountId}
                      onValueChange={(v) =>
                        v !== row.accountId &&
                        patch(
                          row,
                          workspaceChangePatch(row, String(v), workspaces)
                        )
                      }
                    >
                      <SelectTrigger
                        className="w-full"
                        aria-label={tx('workspace')}
                      >
                        <SelectValue>{wsName(row.accountId)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {workspaces.map((w) => (
                          <SelectItem key={w.accountId} value={w.accountId}>
                            {w.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    wsName(row.accountId)
                  )}
                </TableCell>
                <TableCell>
                  <Checkbox
                    aria-label={tx('softphone')}
                    checked={row.softphoneEnabled}
                    disabled={!editable}
                    onCheckedChange={(v) =>
                      patch(row, { softphoneEnabled: v === true })
                    }
                  />
                </TableCell>
                <TableCell>
                  <Checkbox
                    aria-label={tx('showStatus')}
                    checked={row.presenceMonitor}
                    disabled={!editable}
                    onCheckedChange={(v) =>
                      patch(row, { presenceMonitor: v === true })
                    }
                  />
                </TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                    <span
                      className={cn('size-2 shrink-0 rounded-full', DOT[tone])}
                    />
                    <span
                      className={cn(
                        tone === 'brown' &&
                          'text-orange-800 [[data-mode=dark]_&]:text-orange-300',
                        tone === 'green' &&
                          'text-emerald-700 [[data-mode=dark]_&]:text-emerald-300',
                        (tone === 'grey' || tone === 'muted') &&
                          'text-muted-foreground'
                      )}
                    >
                      {tx(`states.${state}`)}
                    </span>
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}

// ---------- Recording rules + Bank numbers ----------

type Rules = RecordingRules;
/** GET /api/pbx/settings `recordings` (pbx_recordings_kept, 093). */
interface Kept {
  kept: number;
  legalHold: number;
  oldestCallAt: string | null;
  expired: number;
}
interface BankRow {
  key: number;
  number: string;
  bankCode: string;
}

/**
 * A team leader's part of the phone settings: mandatory outcomes only
 * (PUT /api/pbx/settings takes that one field from them, migration 097).
 */
export function OutcomeRuleCard() {
  const t = useTranslations('Settings.phoneSystem');
  const [on, setOn] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void pbxFetch<{ settings: Rules }>('/api/pbx/settings').then((res) => {
      if (res.ok) setOn(res.data.settings.mandatoryDisposition);
    });
  }, []);
  const save = async (v: boolean) => {
    setSaving(true);
    const res = await pbxFetch<{ settings: Rules }>('/api/pbx/settings', {
      method: 'PUT',
      body: { mandatoryDisposition: v },
    });
    setSaving(false);
    if (res.ok) {
      setOn(res.data.settings.mandatoryDisposition);
      toast.success(t('rules.saved'));
    } else
      toast.error(t('saveFailed'), { description: res.error ?? undefined });
  };
  return (
    <Card title={t('outcomes.title')}>
      <div className="space-y-1 text-sm">
        <CheckRow
          checked={on === true}
          disabled={on === null || saving}
          onChange={(v) => void save(v)}
          label={t('rules.mandatory')}
        />
        <p className="text-muted-foreground pl-[1.625rem] text-xs">
          {t('outcomes.hint')}
        </p>
      </div>
    </Card>
  );
}

/**
 * What the typed period does, whether the saved one is enforced yet,
 * and what the workspace keeps now.
 */
function RetentionNote({
  days,
  kept,
  unenforced,
}: {
  days: ReturnType<typeof parseRetentionDays>;
  kept: Kept | null;
  /** A period is saved but deletes nothing until saved again (093). */
  unenforced: boolean;
}) {
  const t = useTranslations('Settings.phoneSystem');
  const format = useFormatter();
  const parts = kept
    ? [
        t('rules.kept', { count: kept.kept }),
        kept.oldestCallAt &&
          t('rules.keptOldest', {
            date: format.dateTime(new Date(kept.oldestCallAt), {
              dateStyle: 'medium',
            }),
          }),
        kept.legalHold > 0 && t('rules.keptHeld', { count: kept.legalHold }),
        kept.expired > 0 && t('rules.keptExpired', { count: kept.expired }),
      ].filter((p): p is string => typeof p === 'string')
    : [];
  return (
    <div className="text-muted-foreground space-y-1 text-xs">
      {days.ok && (
        <p>
          {days.value === null
            ? t('rules.retentionKeeps')
            : t('rules.retentionDeletes', { days: days.value })}
        </p>
      )}
      {unenforced && (
        <p className="font-medium text-amber-700 [[data-mode=dark]_&]:text-amber-300">
          {t('rules.retentionNotEnforced')}
        </p>
      )}
      {parts.length > 0 && <p>{parts.join(' · ')}</p>}
    </div>
  );
}

export function RecordingRulesCard() {
  const t = useTranslations('Settings.phoneSystem');
  const [rules, setRules] = useState<Rules | null>(null);
  const [kept, setKept] = useState<Kept | null>(null);
  const [retention, setRetention] = useState('');
  const [due, setDue] = useState('');
  const [ruleIssue, setRuleIssue] = useState<string | null>(null);
  const [banks, setBanks] = useState<BankRow[]>([]);
  const [bankIssues, setBankIssues] = useState<BankNumberRowIssues[]>([]);
  const [saving, setSaving] = useState<'rules' | 'banks' | null>(null);
  // The saved value, not the unsaved checkbox.
  const [paused, setPaused] = useState(false);
  // A period that deletes recordings as soon as it is saved, counted and
  // waiting for the admin's go-ahead; due null: it could not be counted.
  const [confirm, setConfirm] = useState<{
    days: number;
    due: number | null;
  } | null>(null);

  const takeRules = (r: Rules) => {
    setRules(r);
    setPaused(r.storeRecordings === false);
    setRetention(r.retentionDays === null ? '' : String(r.retentionDays));
    setDue(String(r.missedCallDueMinutes));
    setRuleIssue(null);
  };
  const takeBanks = (list: { number: string; bankCode: string }[]) => {
    setBanks(list.map((b) => ({ key: nextKey++, ...b })));
    setBankIssues([]);
  };

  useEffect(() => {
    void pbxFetch<{ settings: Rules; recordings: Kept | null }>(
      '/api/pbx/settings'
    ).then((res) => {
      if (!res.ok) return;
      takeRules(res.data.settings);
      setKept(res.data.recordings ?? null);
    });
    void pbxFetch<{ bankNumbers: { number: string; bankCode: string }[] }>(
      '/api/pbx/bank-numbers'
    ).then((res) => {
      if (res.ok) takeBanks(res.data.bankNumbers);
    });
  }, []);

  // confirmedDays: the period the admin just confirmed deleting under.
  // ask: the route refused the period unconfirmed (409
  // confirm_retention): the period in force is not the one this page
  // loaded, so ask whatever the loaded one was.
  const saveRules = async (
    confirmedDays?: number,
    ask = false
  ): Promise<void> => {
    if (!rules) return;
    const days = parseRetentionDays(retention);
    const minutes = parseDueMinutes(due);
    if (!days.ok) return setRuleIssue(t('rules.retentionInvalid'));
    if (minutes === null) return setRuleIssue(t('rules.dueInvalid'));
    // A first or shorter period deletes every older recording on the next
    // cron run (093): count them with the run's own rule, and ask first
    // unless that is none. The period is sent only when changed, or to
    // start one not enforced yet (sendsRetention).
    const period = days.value;
    let confirmed = confirmedDays === period ? confirmedDays : undefined;
    if (
      period !== null &&
      confirmed === undefined &&
      sendsRetention(rules, period) &&
      (ask || retentionNeedsConfirm(enforcedRetention(rules), period))
    ) {
      setSaving('rules');
      const count = await pbxFetch<{ due: number }>(
        `/api/pbx/settings/retention?days=${period}`
      );
      setSaving(null);
      const n =
        count.ok && typeof count.data.due === 'number' ? count.data.due : null;
      if (n !== 0) return setConfirm({ days: period, due: n });
      confirmed = period;
    }
    setConfirm(null);
    setSaving('rules');
    const res = await pbxFetch<{ settings: Rules }>('/api/pbx/settings', {
      method: 'PUT',
      body: rulesBody(rules, period, minutes, confirmed),
    });
    setSaving(null);
    if (res.ok) {
      takeRules(res.data.settings);
      toast.success(t('rules.saved'));
    } else if (res.code === 'confirm_retention' && !ask)
      return saveRules(undefined, true);
    else toast.error(t('saveFailed'), { description: res.error ?? undefined });
  };

  const saveBanks = async () => {
    const checked = validateBankNumbers(banks);
    if (!checked.ok) return setBankIssues(checked.issues);
    setSaving('banks');
    const res = await pbxFetch<{
      bankNumbers: { number: string; bankCode: string }[];
    }>('/api/pbx/bank-numbers', { method: 'PUT', body: checked.payload });
    setSaving(null);
    if (res.ok) {
      takeBanks(res.data.bankNumbers);
      toast.success(t('banks.saved'));
    } else
      toast.error(t('saveFailed'), { description: res.error ?? undefined });
  };

  const flag = (key: keyof Rules, label: string) => (
    <CheckRow
      checked={rules?.[key] === true}
      disabled={!rules}
      onChange={(v) =>
        setRules((prev) => (prev ? { ...prev, [key]: v } : prev))
      }
      label={label}
    />
  );
  const editBank = (key: number, p: Partial<BankRow>) =>
    setBanks((prev) => prev.map((b) => (b.key === key ? { ...b, ...p } : b)));

  return (
    <Card
      title={
        <>
          {t('rules.title')}
          {paused ? (
            <span className="bg-destructive/10 text-destructive ml-2 rounded-md px-1.5 py-0.5 align-middle text-xs font-medium">
              {t('rules.paused')}
            </span>
          ) : null}
        </>
      }
      className="border-amber-200 bg-amber-50/70 [[data-mode=dark]_&]:border-amber-500/30 [[data-mode=dark]_&]:bg-amber-500/10"
    >
      <div className="space-y-3 text-sm">
        <div>
          {flag('storeRecordings', t('rules.storeRecordings'))}
          <p className="text-muted-foreground mt-1 pl-[1.625rem] text-xs">
            {t('rules.storeRecordingsHint')}
          </p>
        </div>
        {flag('announcementRequired', t('rules.announcement'))}
        {flag('excludeBankNumbers', t('rules.excludeBanks'))}
        <div className="flex flex-wrap items-center gap-2">
          <span>{t('rules.retention')}</span>
          <Input
            className="bg-card w-24"
            inputMode="numeric"
            value={retention}
            placeholder="—"
            aria-label={t('rules.retention')}
            onChange={(e) => {
              setRetention(e.target.value);
              setConfirm(null);
            }}
          />
          <span className="text-muted-foreground">
            {retention.trim() ? t('rules.days') : t('rules.keep')} ·{' '}
            {t('rules.erasure')}
          </span>
        </div>
        <RetentionNote
          days={parseRetentionDays(retention)}
          kept={kept}
          unenforced={
            rules !== null &&
            rules.retentionDays !== null &&
            enforcedRetention(rules) === null
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          <span>{t('rules.dueAfter')}</span>
          <Input
            className="bg-card w-24"
            inputMode="numeric"
            value={due}
            aria-label={t('rules.dueAfter')}
            onChange={(e) => setDue(e.target.value)}
          />
          <span className="text-muted-foreground">{t('rules.minutes')}</span>
        </div>
        {flag('mandatoryDisposition', t('rules.mandatory'))}
        {flag('missedCallWhatsappDraft', t('rules.whatsappDraft'))}
        <Issue text={ruleIssue} />
        {confirm ? (
          <div className="border-destructive/40 bg-destructive/5 space-y-2 rounded-md border p-3">
            <p className="text-destructive text-xs">
              {confirm.due === null
                ? t('rules.confirmDeleteUnknown', { days: confirm.days })
                : t('rules.confirmDelete', {
                    count: confirm.due,
                    days: confirm.days,
                  })}
            </p>
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={saving !== null}
                onClick={() => setConfirm(null)}
              >
                {t('rules.confirmCancel')}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={saving !== null}
                onClick={() => void saveRules(confirm.days)}
              >
                {saving === 'rules' ? (
                  <Loader2 className="animate-spin" />
                ) : null}
                {t('rules.confirmSave')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => void saveRules()}
              disabled={!rules || saving !== null}
            >
              {saving === 'rules' ? <Loader2 className="animate-spin" /> : null}
              {t('rules.save')}
            </Button>
          </div>
        )}
      </div>

      <div className="border-border mt-4 border-t pt-4">
        <h4 className="mb-2 text-sm font-semibold">{t('banks.title')}</h4>
        {banks.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('banks.empty')}</p>
        ) : null}
        <div className="space-y-2">
          {banks.map((b, i) => {
            const issue = bankIssues[i] ?? {};
            return (
              <div key={b.key} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <Input
                    className="bg-card"
                    inputMode="tel"
                    value={b.number}
                    placeholder={t('banks.number')}
                    aria-label={t('banks.number')}
                    onChange={(e) =>
                      editBank(b.key, { number: e.target.value })
                    }
                  />
                  <Issue
                    text={
                      issue.number ? t(`banks.issues.${issue.number}`) : null
                    }
                  />
                </div>
                <div className="w-28 shrink-0 sm:w-36">
                  <Input
                    className="bg-card"
                    value={b.bankCode}
                    placeholder={t('banks.bankCode')}
                    aria-label={t('banks.bankCode')}
                    onChange={(e) =>
                      editBank(b.key, { bankCode: e.target.value })
                    }
                  />
                  <Issue
                    text={
                      issue.bankCode
                        ? t(`banks.issues.${issue.bankCode}`)
                        : null
                    }
                  />
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="mt-1"
                  aria-label={t('banks.remove')}
                  onClick={() => {
                    setBanks((prev) => prev.filter((x) => x.key !== b.key));
                    setBankIssues([]);
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap justify-between gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setBanks((prev) => [
                ...prev,
                { key: nextKey++, number: '', bankCode: '' },
              ])
            }
          >
            <Plus />
            {t('banks.add')}
          </Button>
          <Button size="sm" onClick={saveBanks} disabled={saving !== null}>
            {saving === 'banks' ? <Loader2 className="animate-spin" /> : null}
            {t('banks.save')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
