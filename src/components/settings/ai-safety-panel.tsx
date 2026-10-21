'use client';

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useFormatter, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Eye,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  XCircle,
  Zap,
} from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/dashboard/skeleton';
import { cn } from '@/lib/utils';
import type {
  TsAccountSettings,
  TsActivityItem,
  TsActivityResponse,
  TsActivitySummary,
  TsCheck,
  TsSettingsResponse,
  TsSettingsPut,
  TsSettingsUpdate,
  TsStatus,
} from '@/lib/typesafe/admin-types';
import {
  describeDecision,
  FILTERABLE_CHECKS,
  formatLatency,
  formatUsd,
  type DisplayLabel,
  type OutcomeKind,
} from '@/lib/typesafe/describe-decision';

import type { PartnerBanksDraft } from '@/lib/typesafe/partner-banks-draft';

import { PartnerBanksCard } from './partner-banks-card';
import { SettingsChip, type ChipVariant } from './settings-chip';
import { SettingsPanelHead } from './settings-panel-head';
import { canOpenSection } from './settings-sections';
import { AdvancedSection } from '@/components/agents/ai-config-sections';

/**
 * Settings → AI Agents → Safety checks: the account's switches for the TypeSafe
 * decision layer around the AI auto-reply bot, and a log of everything
 * it decided.
 *
 * Client-only by construction. From lib/typesafe it imports just the
 * import-free contract (`admin-types`) and the pure display helper
 * (`describe-decision`); anything else there reaches the SDK and
 * node:crypto and must never enter a browser bundle.
 *
 * Saving: each control saves as it changes, optimistically, and rolls
 * back if the server refuses. Controls are disabled while a save is in
 * flight, so saves never race each other. Anything that makes the layer
 * act on customers for the first time (Live mode, or turning the layer
 * on while Live is selected) asks for confirmation first.
 *
 * The section is admin-only (`settings-sections.ts`), and so are the
 * API routes; the role check here is only so a stray render never
 * fires admin requests.
 */

const DAYS = 7;
const PAGE_SIZE = 50;

type CheckFilter = 'all' | TsCheck;

/** The PUT body: exactly the writable fields, never updatedAt/By. */
function toUpdate(s: TsAccountSettings): TsSettingsUpdate {
  return {
    enabled: s.enabled,
    mode: s.mode,
    triage: s.triage,
    guardrail: s.guardrail,
    passages: s.passages,
    watchHumanThreads: s.watchHumanThreads,
    languages: s.languages,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// The routes are being built alongside this panel, so their responses
// are checked for shape rather than trusted: a half-deployed backend
// should produce an error state, not a crash.
function isSettingsResponse(v: unknown): v is TsSettingsResponse {
  return isObject(v) && isObject(v.settings) && isObject(v.status);
}

function isActivityResponse(v: unknown): v is TsActivityResponse {
  return isObject(v) && isObject(v.summary) && Array.isArray(v.items);
}

/** `{ error: string }` from our routes; tolerate `{ error: { message } }`. */
function errorOf(v: unknown): string | null {
  if (!isObject(v)) return null;
  if (typeof v.error === 'string' && v.error) return v.error;
  if (isObject(v.error) && typeof v.error.message === 'string') {
    return v.error.message;
  }
  return null;
}

/** A finite count for a tile; anything else reads as 0. */
function count(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

export type PanelState = 'off' | 'monitor' | 'live' | 'problem';

const SWITCHABLE_CHECKS = ['triage', 'guardrail', 'passages'] as const;

/** What the layer is doing right now, for the header chip. */
export function effectiveState(
  settings: TsAccountSettings,
  status: TsStatus
): PanelState {
  // An unreadable server configuration turns the layer off — except the
  // guardrail's fail-safe, which holds every bot reply of an account
  // that runs it Live.
  if (status.problem) {
    return settings.enabled && settings.guardrail && settings.mode === 'live'
      ? 'problem'
      : 'off';
  }
  if (!settings.enabled || !status.configured || !status.accountAllowed) {
    return 'off';
  }
  if (settings.mode !== 'live') return 'monitor';
  // Live, unless every check the account runs is kept logged-only by the
  // server or by an approved logged-only policy.
  const running = SWITCHABLE_CHECKS.filter(
    (c) => settings[c] && status.checksAvailable?.[c] !== false
  );
  if (
    running.length > 0 &&
    running.every(
      (c) => status.forcedMonitor?.[c] || status.policies?.[c]?.loggedOnly
    )
  ) {
    return 'monitor';
  }
  return 'live';
}

/** Would applying `patch` make the layer act for the first time? */
function goesLive(
  settings: TsAccountSettings,
  patch: Partial<TsSettingsUpdate>
): boolean {
  const next = { ...settings, ...patch };
  const wasLive = settings.enabled && settings.mode === 'live';
  return next.enabled && next.mode === 'live' && !wasLive;
}

/** Relative + exact renderings of a timestamp, against a shared `now`. */
function useTimeFormat(now: number) {
  const format = useFormatter();
  return useCallback(
    (iso: string | null | undefined) => {
      if (!iso) return null;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return { relative: iso, exact: iso };
      return {
        relative: format.relativeTime(d, now),
        exact: d.toLocaleString(),
      };
    },
    [format, now]
  );
}

/** Renders a describe-decision label: catalogue text, or the raw string. */
function useLabel() {
  const t = useTranslations('Settings.aiSafety');
  return useCallback(
    (label: DisplayLabel) =>
      label.key && t.has(label.key) ? t(label.key, label.params) : label.raw,
    [t]
  );
}

export function AiSafetyPanel({
  guardrailExtra,
  onDataChange,
}: {
  /** Rendered right under the Reply guardrail switch (AI Agents puts
   *  the AI-config form's "rewrite a held draft once" there). */
  guardrailExtra?: ReactNode;
  /** Told whenever the loaded or saved settings change. */
  onDataChange?: (data: TsSettingsResponse) => void;
} = {}) {
  const { accountId, accountRole, profileLoading } = useAuth();
  const t = useTranslations('Settings.aiSafety');
  const allowed = canOpenSection(
    'ai',
    profileLoading ? null : accountRole
  );

  const [data, setData] = useState<TsSettingsResponse | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>(
    'loading'
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // State updates land a render later; the ref closes the window in
  // which two quick clicks could both start a save.
  const savingRef = useRef(false);
  // The change awaiting "Go live" confirmation, if any.
  const [pendingLive, setPendingLive] =
    useState<Partial<TsSettingsUpdate> | null>(null);
  // One clock for every relative time on the panel, so a minute ticking
  // over re-renders them together.
  const [now, setNow] = useState(() => Date.now());
  // Keyed on the account (not a bare boolean) so an in-place account
  // switch refetches instead of showing the previous account's switches.
  const loadedAccountIdRef = useRef<string | null>(null);

  const tick = useCallback(() => setNow(Date.now()), []);
  useEffect(() => {
    if (data) onDataChange?.(data);
  }, [data, onDataChange]);
  useEffect(() => {
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, [tick]);

  const loadSettings = useCallback(
    async ({
      quiet = false,
      reset = false,
    }: { quiet?: boolean; reset?: boolean } = {}) => {
      // `reset`: a different account — never show the last one's switches
      // while this one's load.
      if (reset) setData(null);
      if (!quiet) setLoadState('loading');
      try {
        const res = await fetch('/api/typesafe/settings', {
          cache: 'no-store',
        });
        const json: unknown = await res.json().catch(() => null);
        if (!res.ok || !isSettingsResponse(json)) {
          if (quiet) return;
          setLoadError(errorOf(json) ?? t('loadFailed'));
          setLoadState('error');
          return;
        }
        setData(json);
        setLoadState('ready');
      } catch {
        if (quiet) return;
        setLoadError(t('loadFailed'));
        setLoadState('error');
      }
    },
    [t]
  );

  useEffect(() => {
    if (!allowed || !accountId || loadedAccountIdRef.current === accountId) {
      return;
    }
    const switched = loadedAccountIdRef.current !== null;
    loadedAccountIdRef.current = accountId;
    void loadSettings({ reset: switched });
  }, [accountId, allowed, loadSettings]);

  const save = useCallback(
    async (
      patch: Partial<TsSettingsUpdate>,
      confirmedLive = false,
      // Absent: the list is left as it is. Not optimistic: the card
      // keeps its draft until the server confirms.
      partnerBanks?: PartnerBanksDraft
    ) => {
      if (!data || savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      const previous = data.settings;
      const optimistic: TsAccountSettings = { ...previous, ...patch };
      setData({ ...data, settings: optimistic });
      const rollBack = () =>
        setData((d) => (d ? { ...d, settings: previous } : d));
      try {
        const res = await fetch('/api/typesafe/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...toUpdate(optimistic),
            // Saved against what this screen showed: if another admin
            // saved since, the server refuses and sends the latest.
            expectedUpdatedAt: previous.updatedAt,
            confirmLive: confirmedLive,
            ...(partnerBanks !== undefined
              ? { partner_banks: partnerBanks }
              : {}),
          } satisfies TsSettingsPut),
        });
        const json: unknown = await res.json().catch(() => null);
        if (
          res.status === 409 &&
          isObject(json) &&
          isSettingsResponse(json.current)
        ) {
          setData(json.current);
          toast.error(errorOf(json) ?? t('saveFailed'));
          return;
        }
        if (!res.ok) {
          rollBack();
          toast.error(errorOf(json) ?? t('saveFailed'));
          return;
        }
        if (isSettingsResponse(json)) {
          setData(json);
        } else {
          // Saved, but the reply is not the documented shape: re-read
          // rather than guess what the server now holds.
          await loadSettings({ quiet: true });
        }
        toast.success(t('saved'));
      } catch {
        rollBack();
        toast.error(t('saveFailed'));
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [data, loadSettings, t]
  );

  const requestChange = (patch: Partial<TsSettingsUpdate>) => {
    if (!data) return;
    if (goesLive(data.settings, patch)) {
      setPendingLive(patch);
      return;
    }
    void save(patch);
  };

  const confirmLive = () => {
    const patch = pendingLive;
    setPendingLive(null);
    if (patch) void save(patch, true);
  };

  if (!allowed) {
    if (profileLoading) return <PanelSkeleton />;
    return (
      <p className="border-border bg-muted/40 text-muted-foreground rounded-md border px-3 py-2 text-sm">
        {t('adminOnly')}
      </p>
    );
  }

  const state = data ? effectiveState(data.settings, data.status) : null;

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          state && data ? (
            <StateChip state={state} status={data.status} />
          ) : null
        }
      />

      {loadState === 'loading' && !data ? (
        <PanelSkeleton />
      ) : loadState === 'error' && !data ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-10 text-center text-sm">
            <XCircle className="text-destructive h-6 w-6" />
            <p className="text-foreground">{loadError ?? t('loadFailed')}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadSettings()}
            >
              <RefreshCw className="mr-2 h-4 w-4" /> {t('retry')}
            </Button>
          </CardContent>
        </Card>
      ) : data ? (
        <>
          <StatusCard status={data.status} />
          <ControlsCard
            settings={data.settings}
            status={data.status}
            saving={saving}
            now={now}
            onChange={requestChange}
            guardrailExtra={guardrailExtra}
          />
          {/* Checked, not trusted: absent from a backend without it. */}
          {Array.isArray(data.bank_catalogue) ? (
            <PartnerBanksCard
              key={accountId ?? 'none'}
              catalogue={data.bank_catalogue}
              saved={data.partner_banks ?? null}
              saving={saving}
              onSave={(value) => void save({}, false, value)}
            />
          ) : null}
        </>
      ) : null}

      {/* Keyed on the account: a switch remounts it, so one account's
          decisions never show under another's while the new ones load. */}
      <ActivityCard
        key={accountId ?? 'none'}
        accountId={accountId}
        settings={data?.settings ?? null}
        now={now}
        onLoaded={tick}
      />

      <Dialog
        open={pendingLive !== null}
        onOpenChange={(open) => {
          if (!open) setPendingLive(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pendingLive && 'enabled' in pendingLive
                ? t('confirmLive.enableTitle')
                : t('confirmLive.title')}
            </DialogTitle>
            <DialogDescription>{t('confirmLive.body')}</DialogDescription>
          </DialogHeader>
          <ul className="text-foreground list-disc space-y-1.5 pl-5 text-sm">
            <li>{t('confirmLive.handoff')}</li>
            <li>{t('confirmLive.replies')}</li>
            <li>{t('confirmLive.optOuts')}</li>
          </ul>
          <p className="text-muted-foreground text-xs">
            {t('confirmLive.thresholds')}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingLive(null)}>
              {t('confirmLive.cancel')}
            </Button>
            <Button onClick={confirmLive}>{t('confirmLive.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function PanelSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

function StateChip({ state, status }: { state: PanelState; status: TsStatus }) {
  const t = useTranslations('Settings.aiSafety');
  const forced =
    state === 'monitor' &&
    SWITCHABLE_CHECKS.some((c) => status.forcedMonitor?.[c])
      ? t('state.forcedHint')
      : undefined;
  if (state === 'problem') {
    return (
      <span title={t('state.problemHint')}>
        <SettingsChip className="border-destructive/40 bg-destructive/10 text-destructive">
          <AlertTriangle /> {t('state.problem')}
        </SettingsChip>
      </span>
    );
  }
  if (state === 'live') {
    return (
      <SettingsChip variant="ok">
        <ShieldCheck /> {t('state.live')}
      </SettingsChip>
    );
  }
  if (state === 'monitor') {
    return (
      <span title={forced}>
        <SettingsChip variant="admin">
          <Eye /> {t('state.monitor')}
        </SettingsChip>
      </span>
    );
  }
  return (
    <SettingsChip variant="muted">
      <ShieldOff /> {t('state.off')}
    </SettingsChip>
  );
}

// ------------------------------------------------------------------
// Status
// ------------------------------------------------------------------

function StatusCard({ status }: { status: TsStatus }) {
  const t = useTranslations('Settings.aiSafety');
  const checkName = (c: TsCheck) => t(`checks.${c}`);

  const notes: string[] = [];
  if (status.configured && !status.problem) {
    const forced = FILTERABLE_CHECKS.filter((c) => status.forcedMonitor?.[c]);
    if (forced.length === FILTERABLE_CHECKS.length) {
      notes.push(t('status.forcedMonitor'));
    } else {
      for (const c of forced) {
        notes.push(t('status.forcedMonitorCheck', { check: checkName(c) }));
      }
    }
    if (!status.accountAllowed) notes.push(t('status.accountNotAllowed'));
    for (const c of FILTERABLE_CHECKS) {
      if (status.checksAvailable?.[c] === false) {
        notes.push(t('status.checkUnavailable', { check: checkName(c) }));
      }
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="text-primary h-4 w-4" /> {t('status.title')}
        </CardTitle>
        <CardAction>
          {status.problem ? (
            <SettingsChip className="border-destructive/40 bg-destructive/10 text-destructive">
              <XCircle /> {t('status.problem')}
            </SettingsChip>
          ) : !status.configured ? (
            <SettingsChip variant="warn">
              <AlertTriangle /> {t('status.notConfigured')}
            </SettingsChip>
          ) : (
            <SettingsChip variant="ok">
              <CheckCircle2 /> {t('status.configured')}
            </SettingsChip>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {status.problem ? (
          <div className="space-y-1">
            <p className="text-destructive">
              {t('status.problemBody', { problem: status.problem })}
            </p>
            <p className="text-muted-foreground text-xs">
              {t('status.problemGuardrail')}
            </p>
          </div>
        ) : !status.configured ? (
          <p className="text-muted-foreground">
            {t('status.notConfiguredBody')}
          </p>
        ) : null}

        <AdvancedSection>
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_minmax(0,1fr)] sm:items-center">
            <dt className="text-muted-foreground">{t('status.model')}</dt>
            <dd>
              <code className="bg-muted rounded px-1.5 py-0.5 text-xs">
                {status.model || '—'}
              </code>
            </dd>
            <dt className="text-muted-foreground">{t('status.thresholds')}</dt>
            <dd className="flex flex-wrap gap-1.5">
              {FILTERABLE_CHECKS.map((c) => {
                const policy = status.policies?.[c] ?? null;
                return (
                  <SettingsChip
                    key={c}
                    variant={policy === null ? 'muted' : 'admin'}
                  >
                    {checkName(c)}:{' '}
                    {policy === null
                      ? t('status.builtIn')
                      : policy.loggedOnly
                        ? t('status.customLoggedOnly', {
                            version: policy.version,
                          })
                        : t('status.custom', { version: policy.version })}
                  </SettingsChip>
                );
              })}
            </dd>
          </dl>
        </AdvancedSection>

        {status.configured && !status.problem ? (
          <p className="text-muted-foreground text-xs">
            {t('status.failMode', { mode: status.failMode })}
          </p>
        ) : null}

        {notes.length > 0 ? (
          <ul className="space-y-1.5">
            {notes.map((note) => (
              <li
                key={note}
                className="text-warning flex items-start gap-2 text-xs"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>{note}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------
// Controls
// ------------------------------------------------------------------

function ControlsCard({
  settings,
  status,
  saving,
  now,
  onChange,
  guardrailExtra,
}: {
  settings: TsAccountSettings;
  status: TsStatus;
  saving: boolean;
  now: number;
  onChange: (patch: Partial<TsSettingsUpdate>) => void;
  guardrailExtra?: ReactNode;
}) {
  const t = useTranslations('Settings.aiSafety');
  const time = useTimeFormat(now);

  // With an unreadable server configuration the switches stay usable:
  // the guardrail's fail-safe holds bot replies for an account running
  // it Live, and turning it off or to Monitor here is how to stop that.
  const lockReason = status.problem
    ? null
    : !status.configured
      ? t('controls.disabledNotConfigured')
      : !status.accountAllowed
        ? t('controls.disabledNotAllowed')
        : null;
  const disabled = lockReason !== null || saving;
  const unavailable = (c: TsCheck) =>
    !status.problem && status.checksAvailable?.[c] === false;

  const checkRows: {
    id: 'triage' | 'guardrail' | 'passages' | 'watch';
    field: 'triage' | 'guardrail' | 'passages' | 'watchHumanThreads';
    check: TsCheck;
  }[] = [
    { id: 'triage', field: 'triage', check: 'triage' },
    { id: 'guardrail', field: 'guardrail', check: 'guardrail' },
    { id: 'passages', field: 'passages', check: 'passages' },
    // Watching runs triage (for opt-outs only) on threads people
    // handle, so it goes wherever triage goes on this server.
    { id: 'watch', field: 'watchHumanThreads', check: 'triage' },
  ];

  const changed = time(settings.updatedAt);

  const renderCheck = ({ id, field, check }: (typeof checkRows)[number]) => (
    <SwitchRow
      key={id}
      id={`ts-${id}`}
      title={t(`controls.${id}`)}
      description={t(`controls.${id}Desc`)}
      checked={settings[field]}
      disabled={disabled || unavailable(check)}
      onCheckedChange={(value) => {
        const patch: Partial<TsSettingsUpdate> = {};
        patch[field] = value;
        onChange(patch);
      }}
      note={
        unavailable(check) ? (
          <SettingsChip variant="warn" className="mt-2">
            {t('controls.unavailableOnServer')}
          </SettingsChip>
        ) : id === 'watch' && settings.watchHumanThreads && !settings.triage ? (
          <SettingsChip variant="warn" className="mt-2">
            {t('controls.watchNeedsTriage')}
          </SettingsChip>
        ) : null
      }
    />
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('controls.title')}</CardTitle>
        <CardDescription>{t('controls.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {lockReason ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{lockReason}</AlertDescription>
          </Alert>
        ) : null}

        <SwitchRow
          id="ts-enabled"
          title={t('controls.enable')}
          description={t('controls.enableDesc')}
          checked={settings.enabled}
          disabled={disabled}
          onCheckedChange={(enabled) => onChange({ enabled })}
          emphasis
        />

        <div className="space-y-2">
          <p className="text-foreground text-sm font-medium" id="ts-mode-label">
            {t('controls.mode')}
          </p>
          <RadioGroup
            aria-labelledby="ts-mode-label"
            value={settings.mode}
            onValueChange={(value) => {
              if (value === 'monitor' || value === 'live') {
                if (value !== settings.mode) onChange({ mode: value });
              }
            }}
            disabled={disabled}
            className="gap-2 sm:grid-cols-2"
          >
            {(['monitor', 'live'] as const).map((mode) => (
              <label
                key={mode}
                className={cn(
                  'border-border flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors',
                  settings.mode === mode &&
                    'border-primary-soft-2 bg-primary-soft',
                  disabled && 'cursor-not-allowed opacity-60'
                )}
              >
                <RadioGroupItem value={mode} className="mt-0.5" />
                <span className="min-w-0">
                  <span className="text-foreground block text-sm font-medium">
                    {t(`controls.${mode}`)}
                  </span>
                  <span className="text-muted-foreground mt-1 block text-xs">
                    {t(`controls.${mode}Desc`)}
                  </span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </div>

        <div className="space-y-2">
          <p className="text-foreground text-sm font-medium">
            {t('controls.checks')}
          </p>
          {checkRows.slice(0, 2).map((row) => (
            <Fragment key={row.id}>
              {renderCheck(row)}
              {row.id === 'guardrail' ? guardrailExtra : null}
            </Fragment>
          ))}
        </div>

        {/* Less used, or uncalibrated (the knowledge filter): kept out
            of the way until asked for. */}
        <AdvancedSection>
          <div className="space-y-2">{checkRows.slice(2).map(renderCheck)}</div>

          <div className="space-y-2">
            <p
              className="text-foreground text-sm font-medium"
              id="ts-languages-label"
            >
              {t('controls.languages')}
            </p>
            <p className="text-muted-foreground text-xs">
              {t('controls.languagesDesc')}
            </p>
            <Select
              value={settings.languages}
              onValueChange={(value) => {
                if (
                  (value === 'english' || value === 'all') &&
                  value !== settings.languages
                ) {
                  onChange({ languages: value });
                }
              }}
              disabled={disabled}
            >
              <SelectTrigger
                aria-labelledby="ts-languages-label"
                className="w-full sm:max-w-md"
              >
                {/* Base UI's SelectValue renders the raw value unless
                  given children. */}
                <SelectValue>
                  {settings.languages === 'all'
                    ? t('controls.all')
                    : t('controls.english')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="english">
                  <span className="whitespace-normal">
                    {t('controls.english')}
                  </span>
                </SelectItem>
                <SelectItem value="all">
                  <span className="whitespace-normal">{t('controls.all')}</span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </AdvancedSection>

        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          {saving ? (
            <>
              <Loader2 className="size-3 animate-spin" /> {t('saving')}
            </>
          ) : changed ? (
            <span title={changed.exact}>
              {settings.updatedBy
                ? t('controls.lastChangedBy', {
                    time: changed.relative,
                    name: settings.updatedBy,
                  })
                : t('controls.lastChanged', { time: changed.relative })}
            </span>
          ) : (
            t('controls.neverChanged')
          )}
        </p>
      </CardContent>
    </Card>
  );
}

function SwitchRow({
  id,
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
  note,
  emphasis = false,
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  note?: ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div
      className={cn(
        'border-border flex items-center justify-between gap-4 rounded-md border p-3',
        emphasis && 'bg-card-2'
      )}
    >
      <div className="min-w-0">
        <p id={`${id}-label`} className="text-foreground text-sm font-medium">
          {title}
        </p>
        <p id={`${id}-desc`} className="text-muted-foreground mt-0.5 text-xs">
          {description}
        </p>
        {note}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-desc`}
      />
    </div>
  );
}

// ------------------------------------------------------------------
// Activity
// ------------------------------------------------------------------

const KIND_VARIANT: Record<OutcomeKind, ChipVariant> = {
  intervened: 'admin',
  logged: 'muted',
  passed: 'ok',
  unavailable: 'warn',
};

const KIND_ICON: Record<OutcomeKind, typeof Zap> = {
  intervened: Zap,
  logged: Eye,
  passed: CheckCircle2,
  unavailable: AlertTriangle,
};

function OutcomeChip({
  kind,
  children,
  title,
}: {
  kind: OutcomeKind;
  children: ReactNode;
  title?: string;
}) {
  const Icon = KIND_ICON[kind];
  return (
    <span title={title} className="inline-flex">
      <SettingsChip
        variant={KIND_VARIANT[kind]}
        // Logged-only reads as a dashed outline: something that would
        // have happened, and did not.
        className={cn(kind === 'logged' && 'border-dashed bg-transparent')}
      >
        <Icon /> {children}
      </SettingsChip>
    </span>
  );
}

function ActivityCard({
  accountId,
  settings,
  now,
  onLoaded,
}: {
  accountId: string | null;
  settings: TsAccountSettings | null;
  now: number;
  onLoaded: () => void;
}) {
  const t = useTranslations('Settings.aiSafety');
  const time = useTimeFormat(now);

  const [check, setCheck] = useState<CheckFilter>('all');
  const [actedOnly, setActedOnly] = useState(false);
  const [summary, setSummary] = useState<TsActivitySummary | null>(null);
  const [items, setItems] = useState<TsActivityItem[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Every request takes a ticket; only the latest may write state, so a
  // slow page for an old filter can never land on top of a new one.
  const ticketRef = useRef(0);

  const url = useCallback(
    (before: string | null) => {
      const params = new URLSearchParams({
        days: String(DAYS),
        limit: String(PAGE_SIZE),
      });
      if (check !== 'all') params.set('check', check);
      if (actedOnly) params.set('acted', 'true');
      if (before) params.set('before', before);
      return `/api/typesafe/activity?${params.toString()}`;
    },
    [check, actedOnly]
  );

  const load = useCallback(async () => {
    const ticket = ++ticketRef.current;
    setState('loading');
    setError(null);
    setLoadingMore(false);
    try {
      const res = await fetch(url(null), { cache: 'no-store' });
      const json: unknown = await res.json().catch(() => null);
      if (ticket !== ticketRef.current) return;
      if (!res.ok || !isActivityResponse(json)) {
        setError(errorOf(json) ?? t('activity.loadFailed'));
        setState('error');
        return;
      }
      setSummary(json.summary);
      setItems(json.items);
      setNextBefore(json.nextBefore ?? null);
      setState('ready');
      onLoaded();
    } catch {
      if (ticket !== ticketRef.current) return;
      setError(t('activity.loadFailed'));
      setState('error');
    }
  }, [url, t, onLoaded]);

  const loadMore = async () => {
    if (!nextBefore || loadingMore || state !== 'ready') return;
    const ticket = ++ticketRef.current;
    setLoadingMore(true);
    try {
      const res = await fetch(url(nextBefore), { cache: 'no-store' });
      const json: unknown = await res.json().catch(() => null);
      if (ticket !== ticketRef.current) return;
      if (!res.ok || !isActivityResponse(json)) {
        toast.error(errorOf(json) ?? t('activity.loadFailed'));
        return;
      }
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...json.items.filter((i) => !seen.has(i.id))];
      });
      setNextBefore(json.nextBefore ?? null);
    } catch {
      if (ticket === ticketRef.current) toast.error(t('activity.loadFailed'));
    } finally {
      if (ticket === ticketRef.current) setLoadingMore(false);
    }
  };

  // Refetch on account or filter change (`load` changes with the filters).
  useEffect(() => {
    if (!accountId) return;
    void load();
  }, [accountId, load]);

  const filtered = check !== 'all' || actedOnly;
  const hasData = summary !== null;
  const noActivity = hasData && count(summary.decisions) === 0 && !filtered;
  const last = time(summary?.lastDecisionAt);
  const days = count(summary?.days) || DAYS;

  // No settings (still loading, or failed) → the neutral explanation.
  const emptyBody = !settings
    ? t('activity.emptyOn')
    : !settings.enabled
      ? t('activity.emptyOff')
      : settings.watchHumanThreads
        ? t('activity.emptyWatching')
        : t('activity.emptyOn');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('activity.title')}</CardTitle>
        <CardDescription>
          {t('activity.description', { days })}
          {last ? (
            <>
              {' · '}
              <span title={last.exact}>
                {t('activity.lastDecision', { time: last.relative })}
              </span>
            </>
          ) : null}
        </CardDescription>
        <CardAction>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            disabled={state === 'loading'}
          >
            <RefreshCw
              className={cn(
                'mr-1.5 h-4 w-4',
                state === 'loading' && 'animate-spin'
              )}
            />
            {t('activity.refresh')}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        {!hasData && state === 'loading' ? (
          <div className="space-y-3" aria-busy="true">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {Array.from({ length: 10 }, (_, i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </div>
            <Skeleton className="h-40 w-full" />
          </div>
        ) : !hasData && state === 'error' ? (
          <div className="flex flex-col items-center justify-center gap-3 py-8 text-center text-sm">
            <XCircle className="text-destructive h-6 w-6" />
            <p className="text-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="mr-2 h-4 w-4" /> {t('retry')}
            </Button>
          </div>
        ) : noActivity ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-10 text-center text-sm">
            <ShieldCheck className="h-8 w-8 opacity-40" />
            <p className="text-foreground font-medium">
              {t('activity.emptyTitle')}
            </p>
            <p className="max-w-[52ch] text-xs">{emptyBody}</p>
          </div>
        ) : summary ? (
          <>
            <SummaryTiles summary={summary} />

            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <Select
                value={check}
                onValueChange={(value) => {
                  if (
                    value === 'all' ||
                    (FILTERABLE_CHECKS as readonly string[]).includes(
                      String(value)
                    )
                  ) {
                    setCheck(value as CheckFilter);
                  }
                }}
              >
                <SelectTrigger
                  aria-label={t('activity.check')}
                  className="w-44"
                >
                  <SelectValue>
                    {check === 'all'
                      ? t('activity.allChecks')
                      : t(`checks.${check}`)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('activity.allChecks')}</SelectItem>
                  {FILTERABLE_CHECKS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {t(`checks.${c}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Switch checked={actedOnly} onCheckedChange={setActedOnly} />
                {t('activity.actedOnly')}
              </label>

              <Legend />
            </div>

            {state === 'error' ? (
              <Alert variant="destructive">
                <XCircle className="h-4 w-4" />
                <AlertDescription className="flex flex-wrap items-center gap-2">
                  {error}
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => void load()}
                  >
                    {t('retry')}
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}

            {items.length === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-sm">
                {state === 'loading' ? (
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                ) : (
                  t('activity.noMatches')
                )}
              </p>
            ) : (
              <div
                className={cn(
                  'border-border rounded-md border transition-opacity',
                  state !== 'ready' && 'opacity-60'
                )}
                aria-busy={state === 'loading'}
              >
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('activity.columns.time')}</TableHead>
                      <TableHead>{t('activity.columns.check')}</TableHead>
                      <TableHead>{t('activity.columns.outcome')}</TableHead>
                      <TableHead>{t('activity.columns.reasons')}</TableHead>
                      <TableHead>{t('activity.columns.contact')}</TableHead>
                      <TableHead>{t('activity.columns.language')}</TableHead>
                      <TableHead className="text-right">
                        {t('activity.columns.latency')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <ActivityRow key={item.id} item={item} time={time} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {items.length > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-muted-foreground text-xs">
                  {t('activity.showing', { count: items.length })}
                </p>
                {nextBefore ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void loadMore()}
                    disabled={loadingMore || state !== 'ready'}
                  >
                    {loadingMore ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    {t('activity.loadMore')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SummaryTiles({ summary }: { summary: TsActivitySummary }) {
  const t = useTranslations('Settings.aiSafety.activity.tiles');
  const n = (v: unknown) => count(v).toLocaleString();
  const fallbacks = count(summary.fallbacks);
  const tiles: { key: string; value: string; warn?: boolean }[] = [
    { key: 'decisions', value: n(summary.decisions) },
    { key: 'acted', value: n(summary.acted) },
    { key: 'handoffs', value: n(summary.triageHandoffs) },
    { key: 'optOuts', value: n(summary.optOuts) },
    { key: 'held', value: n(summary.repliesHeld) },
    { key: 'blocked', value: n(summary.repliesBlocked) },
    { key: 'removed', value: n(summary.passagesDropped) },
    { key: 'fallbacks', value: n(fallbacks), warn: fallbacks > 0 },
    { key: 'cost', value: formatUsd(count(summary.estUsd)) },
    { key: 'p95', value: formatLatency(summary.p95LatencyMs) ?? '—' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map((tile) => (
        <div
          key={tile.key}
          className={cn(
            'border-border bg-card rounded-md border p-3',
            tile.warn && 'border-warning/40 bg-warning-soft'
          )}
        >
          <p className="text-muted-foreground text-xs">{t(tile.key)}</p>
          <p
            className={cn(
              'text-foreground mt-1 text-lg font-semibold tabular-nums',
              tile.warn && 'text-warning'
            )}
          >
            {tile.value}
          </p>
        </div>
      ))}
    </div>
  );
}

function Legend() {
  const t = useTranslations('Settings.aiSafety.activity');
  const kinds: OutcomeKind[] = [
    'intervened',
    'logged',
    'passed',
    'unavailable',
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
      {kinds.map((kind) => (
        <OutcomeChip key={kind} kind={kind} title={t(`hint.${kind}`)}>
          {t(`legend.${kind}`)}
        </OutcomeChip>
      ))}
    </div>
  );
}

function ActivityRow({
  item,
  time,
}: {
  item: TsActivityItem;
  time: ReturnType<typeof useTimeFormat>;
}) {
  const t = useTranslations('Settings.aiSafety');
  const label = useLabel();
  const d = describeDecision(item);
  const at = time(item.createdAt);
  const contact = item.contactName || t('activity.unknownContact');

  return (
    <TableRow>
      <TableCell className="text-muted-foreground text-xs" title={at?.exact}>
        {at?.relative ?? '—'}
      </TableCell>
      <TableCell className="text-xs">{label(d.check)}</TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          <OutcomeChip kind={d.kind} title={t(`activity.hint.${d.kind}`)}>
            {label(d.outcome)}
          </OutcomeChip>
          {d.effect === 'acted' ? (
            <span className="text-primary inline-flex items-center gap-1 text-[11px] font-medium">
              <Zap className="size-3" /> {t('activity.legend.intervened')}
            </span>
          ) : d.effect === 'logged' ? (
            <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
              <Eye className="size-3" /> {t('activity.legend.logged')}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="min-w-56 whitespace-normal">
        {d.reasons.length === 0 && !item.errorCode ? (
          <span className="text-muted-foreground text-xs">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {d.reasons.map((reason) => (
              <span
                key={reason.raw}
                title={reason.raw}
                className="border-border bg-muted text-foreground rounded border px-1.5 py-0.5 text-[11px]"
              >
                {label(reason)}
                {reason.key === null && reason.count > 1
                  ? ` ×${reason.count}`
                  : null}
              </span>
            ))}
            {item.errorCode ? (
              <span className="text-muted-foreground px-0.5 py-0.5 text-[11px]">
                {t('activity.errorCode', { code: item.errorCode })}
              </span>
            ) : null}
          </div>
        )}
      </TableCell>
      <TableCell className="text-xs">
        {item.conversationId ? (
          <Link
            href={`/inbox?c=${encodeURIComponent(item.conversationId)}`}
            className="text-primary inline-flex items-center gap-1 hover:underline"
            title={t('activity.openConversation')}
          >
            <span className="max-w-40 truncate">{contact}</span>
            <ExternalLink className="size-3 shrink-0" />
          </Link>
        ) : item.contactName ? (
          <span className="inline-block max-w-40 truncate align-bottom">
            {item.contactName}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-xs">
        {d.language ? label(d.language) : '—'}
      </TableCell>
      <TableCell className="text-muted-foreground text-right text-xs tabular-nums">
        {formatLatency(item.latencyMs) ?? '—'}
      </TableCell>
    </TableRow>
  );
}
