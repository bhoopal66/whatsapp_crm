'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Play, ShieldAlert, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { AutomsgHistory } from '@/components/hr/automsg-history';
import { AutomsgTemplates } from '@/components/hr/automsg-templates';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAuth } from '@/hooks/use-auth';
import { hrMyRoles } from '@/lib/hr/api';
import {
  automsgConfig,
  automsgReleaseNow,
  automsgSaveSettings,
  automsgSetTrigger,
  type AutoMsgConfig,
} from '@/lib/hr/automsg/api';
import { TEMPLATE_KINDS, type TemplateKind } from '@/lib/hr/automsg/types';
import {
  automsgControls,
  automsgErrorKey,
  automsgRole,
  bannerView,
  releaseCounts,
  nextSettingsForm,
  type ConfigLoadReason,
  triggerRows,
  validateSettingsForm,
  type AutomsgRole,
  type SettingsField,
  type SettingsForm,
  type TriggerRowView,
} from '@/lib/hr/automsg/view';
import { createClient } from '@/lib/supabase/client';

/**
 * HR Automated messages (migration 203): the kill switch, the guard
 * settings and the per-trigger switches. Admins edit everything, a
 * recruiter lead only switches triggers; anyone else gets a note and the
 * page makes no calls. Every write is an RPC that re-checks the caller,
 * and the config is reloaded after each one.
 */
export default function HrAutomatedMessagesPage() {
  const t = useTranslations('Hr.automsg');
  const { accountId } = useAuth();
  const [role, setRole] = useState<AutomsgRole | null | undefined>(undefined);
  const [config, setConfig] = useState<AutoMsgConfig | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [invalid, setInvalid] = useState<SettingsField[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmOn, setConfirmOn] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);

  useEffect(() => {
    if (!accountId) return;
    let live = true;
    void hrMyRoles(createClient()).then((res) => {
      if (live) setRole('data' in res ? automsgRole(res.data) : null);
    });
    return () => {
      live = false;
    };
  }, [accountId]);

  const load = useCallback(async (reason: ConfigLoadReason = 'other') => {
    const res = await automsgConfig(createClient());
    if ('error' in res) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setConfig(res.data);
    setForm((cur) => nextSettingsForm(cur, res.data.settings, reason));
    if (reason !== 'other') setInvalid([]);
  }, []);

  useEffect(() => {
    if (role) void load('first');
  }, [role, load]);

  const refusal = (code: string) =>
    toast.error(t(`error.${automsgErrorKey(code)}`));

  /** Runs a write, toasts a refusal in words, then reloads the config. */
  const save = async (
    write: () => Promise<{ data: unknown } | { error: string }>,
    done: string,
    reason: ConfigLoadReason = 'other'
  ) => {
    setBusy(true);
    try {
      const res = await write();
      if ('error' in res) refusal(res.error);
      else toast.success(done);
      await load('error' in res ? 'other' : reason);
    } finally {
      setBusy(false);
    }
  };

  const setKillSwitch = (killSwitch: boolean) =>
    save(
      () => automsgSaveSettings(createClient(), { killSwitch }),
      t(killSwitch ? 'banner.turnedOff' : 'banner.turnedOn')
    );

  const saveSettings = () => {
    if (!form) return;
    const check = validateSettingsForm(form);
    if (!check.ok) {
      setInvalid(check.invalid);
      return;
    }
    setInvalid([]);
    void save(
      () => automsgSaveSettings(createClient(), check.patch),
      t('settings.saved'),
      'settings-saved'
    );
  };

  const setTrigger = (
    row: TriggerRowView,
    enabled: boolean,
    templateKind: TemplateKind | null
  ) =>
    save(
      () =>
        automsgSetTrigger(createClient(), row.trigger, enabled, templateKind),
      t('triggersTable.saved')
    );

  const runNow = async () => {
    setBusy(true);
    try {
      const res = await automsgReleaseNow();
      if ('error' in res) toast.error(t('banner.runFailed'));
      else toast.success(t('banner.runDone', releaseCounts(res.data)));
      setHistoryKey((k) => k + 1);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const controls = automsgControls(role ?? null);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4 md:p-6">
      <Link
        href="/hr-inbox"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" />
        {t('back')}
      </Link>
      <div>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      {role === null ? (
        <p className="text-muted-foreground text-sm">{t('noAccess')}</p>
      ) : failed ? (
        <div className="border-border bg-card space-y-2 rounded-lg border p-4">
          <p className="text-destructive text-sm">{t('loadFailed')}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t('retry')}
          </Button>
        </div>
      ) : role === undefined || !config || !form ? (
        <div className="bg-card-2 h-24 animate-pulse rounded-lg" />
      ) : (
        <>
          <Banner
            config={config}
            role={role}
            busy={busy}
            onTurnOn={() => setConfirmOn(true)}
            onTurnOff={() => void setKillSwitch(true)}
            onRunNow={() => void runNow()}
          />

          <section className="border-border bg-card space-y-4 rounded-lg border p-4">
            <div>
              <h2 className="font-medium">{t('settings.title')}</h2>
              {!controls.editSettings && (
                <p className="text-muted-foreground text-xs">
                  {t('settings.leadNote')}
                </p>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t('settings.quietStart')}
                error={
                  invalid.includes('quietStart')
                    ? t('settings.invalid.quietStart')
                    : null
                }
              >
                <Input
                  type="time"
                  value={form.quietStart}
                  disabled={!controls.editSettings}
                  onChange={(e) =>
                    setForm({ ...form, quietStart: e.target.value })
                  }
                />
              </Field>
              <Field
                label={t('settings.quietEnd')}
                error={
                  invalid.includes('quietEnd')
                    ? t('settings.invalid.quietEnd')
                    : null
                }
              >
                <Input
                  type="time"
                  value={form.quietEnd}
                  disabled={!controls.editSettings}
                  onChange={(e) =>
                    setForm({ ...form, quietEnd: e.target.value })
                  }
                />
              </Field>
              <p className="text-muted-foreground -mt-2 text-xs sm:col-span-2">
                {t('settings.quietHelp')}
              </p>
              <Field
                label={t('settings.tz')}
                error={invalid.includes('tz') ? t('settings.invalid.tz') : null}
              >
                <Input
                  value={form.tz}
                  placeholder="Asia/Dubai"
                  disabled={!controls.editSettings}
                  onChange={(e) => setForm({ ...form, tz: e.target.value })}
                />
              </Field>
              <Field
                label={t('settings.dailyCap')}
                error={
                  invalid.includes('dailyCap')
                    ? t('settings.invalid.dailyCap')
                    : null
                }
              >
                <Input
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  value={form.dailyCap}
                  disabled={!controls.editSettings}
                  onChange={(e) =>
                    setForm({ ...form, dailyCap: e.target.value })
                  }
                />
              </Field>
            </div>
            <label className="inline-flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.requiresConsent}
                disabled={!controls.editSettings}
                onCheckedChange={(v) =>
                  setForm({ ...form, requiresConsent: v === true })
                }
              />
              {t('settings.requiresConsent')}
            </label>
            {controls.editSettings && (
              <div>
                <Button size="sm" disabled={busy} onClick={saveSettings}>
                  {t('settings.save')}
                </Button>
              </div>
            )}
          </section>

          <section className="border-border bg-card rounded-lg border">
            <h2 className="p-4 pb-2 font-medium">{t('triggersTable.title')}</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('triggersTable.trigger')}</TableHead>
                  <TableHead>{t('triggersTable.template')}</TableHead>
                  <TableHead>{t('triggersTable.approved')}</TableHead>
                  <TableHead className="text-right">
                    {t('triggersTable.on')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {triggerRows(config, role).map((row) => (
                  <TableRow key={row.trigger}>
                    <TableCell className="align-top whitespace-normal">
                      <div className="font-medium">
                        {t(`triggers.${row.trigger}`)}
                      </div>
                      {row.note && (
                        <p className="text-muted-foreground text-xs">
                          {t(`triggersTable.${row.note}`)}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="align-top">
                      <select
                        aria-label={t('triggersTable.template')}
                        value={row.templateKind}
                        disabled={row.templateDisabled || busy}
                        onChange={(e) =>
                          void setTrigger(
                            row,
                            row.enabled,
                            e.target.value as TemplateKind
                          )
                        }
                        className="border-input bg-card dark:bg-input/30 h-8 rounded-md border px-2 text-sm disabled:opacity-60"
                      >
                        {TEMPLATE_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {t(`templateKinds.${k}`)}
                          </option>
                        ))}
                      </select>
                    </TableCell>
                    <TableCell className="align-top whitespace-normal">
                      <div className="text-sm">
                        {t('triggersTable.approvedLine', {
                          en: row.approved.en ? '✓' : '—',
                          ar: row.approved.ar ? '✓' : '—',
                        })}
                      </div>
                      {row.noApproved && (
                        <p className="text-warning text-xs">
                          {t('triggersTable.noApproved')}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-right align-top">
                      <Switch
                        aria-label={t(`triggers.${row.trigger}`)}
                        checked={row.enabled}
                        disabled={row.switchDisabled || busy}
                        onCheckedChange={(v: boolean) =>
                          void setTrigger(row, v, null)
                        }
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>

          <AutomsgTemplates
            templates={config.templates}
            role={role}
            onSaved={() => load()}
          />

          <AutomsgHistory role={role} refreshKey={historyKey} />

          <Dialog open={confirmOn} onOpenChange={setConfirmOn}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('banner.confirmTitle')}</DialogTitle>
                <DialogDescription>{t('banner.confirmBody')}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmOn(false)}>
                  {t('banner.cancel')}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setConfirmOn(false);
                    void setKillSwitch(false);
                  }}
                >
                  {t('banner.confirm')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}

function Banner({
  config,
  role,
  busy,
  onTurnOn,
  onTurnOff,
  onRunNow,
}: {
  config: AutoMsgConfig;
  role: AutomsgRole;
  busy: boolean;
  onTurnOn: () => void;
  onTurnOff: () => void;
  onRunNow: () => void;
}) {
  const t = useTranslations('Hr.automsg.banner');
  const view = bannerView(config.settings, role);
  const off = view.state === 'off';
  const Icon = off ? ShieldAlert : ShieldCheck;
  return (
    <div
      className={
        off
          ? 'border-warning/40 bg-warning-soft flex flex-wrap items-start gap-3 rounded-lg border p-4'
          : 'border-success/40 bg-success-soft flex flex-wrap items-start gap-3 rounded-lg border p-4'
      }
    >
      <Icon
        className={off ? 'text-warning size-5' : 'text-success size-5'}
        aria-hidden
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p
          className={
            off ? 'text-warning font-medium' : 'text-success font-medium'
          }
        >
          {t(off ? 'offTitle' : 'onTitle')}
        </p>
        <p className="text-sm">{t('safety')}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {view.action === 'turnOn' && (
          <Button size="sm" disabled={busy} onClick={onTurnOn}>
            {t('turnOn')}
          </Button>
        )}
        {view.action === 'turnOff' && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onTurnOff}
          >
            {t('turnOff')}
          </Button>
        )}
        {role === 'admin' && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onRunNow}
          >
            <Play className="size-4" aria-hidden />
            {t('runNow')}
          </Button>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <label className="space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {error && <span className="text-destructive block text-xs">{error}</span>}
    </label>
  );
}
