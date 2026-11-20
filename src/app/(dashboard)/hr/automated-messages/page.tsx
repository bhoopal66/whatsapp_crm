'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
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
  automsgRcsStatus,
  automsgReleaseNow,
  automsgSaveSettings,
  automsgSetTrigger,
  type AutoMsgConfig,
  type AutoMsgRcsStatus,
} from '@/lib/hr/automsg/api';
import {
  AUTOMSG_CHANNELS,
  CHANNEL_LABEL_KEYS,
  type AutomsgChannel,
} from '@/lib/hr/automsg/channel';
import { TEMPLATE_KINDS, type TemplateKind } from '@/lib/hr/automsg/types';
import {
  approvalChips,
  automsgControls,
  automsgErrorKey,
  type ApprovalChip,
  automsgRole,
  bannerView,
  releaseCounts,
  nextSettingsForm,
  type ConfigLoadReason,
  showRcsNotice,
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
  const [rcsStatus, setRcsStatus] = useState<AutoMsgRcsStatus | null>(null);

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
    if (!role) return;
    let live = true;
    void load('first');
    // Once, with the first config: null (unknown) reads as not connected.
    void automsgRcsStatus().then((status) => {
      if (live) setRcsStatus(status);
    });
    return () => {
      live = false;
    };
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
    templateKind: TemplateKind | null,
    channel?: AutomsgChannel
  ) =>
    save(
      () =>
        automsgSetTrigger(
          createClient(),
          row.trigger,
          enabled,
          templateKind,
          channel
        ),
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
  const rows = config && role ? triggerRows(config, role, rcsStatus) : [];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
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
            <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
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
                  className="w-32"
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
                  className="w-32"
                  value={form.quietEnd}
                  disabled={!controls.editSettings}
                  onChange={(e) =>
                    setForm({ ...form, quietEnd: e.target.value })
                  }
                />
              </Field>
              <Field
                label={t('settings.tz')}
                error={invalid.includes('tz') ? t('settings.invalid.tz') : null}
              >
                <Input
                  className="w-56"
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
                  className="w-20"
                  value={form.dailyCap}
                  disabled={!controls.editSettings}
                  onChange={(e) =>
                    setForm({ ...form, dailyCap: e.target.value })
                  }
                />
              </Field>
              <label className="inline-flex h-8 items-center gap-2 text-sm">
                <Checkbox
                  checked={form.requiresConsent}
                  disabled={!controls.editSettings}
                  onCheckedChange={(v) =>
                    setForm({ ...form, requiresConsent: v === true })
                  }
                />
                {t('settings.requiresConsent')}
              </label>
            </div>
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
            {showRcsNotice(rows) && (
              <p
                role="status"
                className="border-warning bg-warning-soft text-warning mx-4 mb-2 rounded-md border-l-4 px-3 py-2 text-xs"
              >
                {t('rcs.notice')}
              </p>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('triggersTable.trigger')}</TableHead>
                  <TableHead>{t('triggersTable.template')}</TableHead>
                  <TableHead>{t('triggersTable.channel')}</TableHead>
                  <TableHead>{t('triggersTable.approved')}</TableHead>
                  <TableHead className="text-center">
                    {t('triggersTable.enabled')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
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
                      {row.channelDisabled ? (
                        <span className="text-sm">
                          {t(CHANNEL_LABEL_KEYS[row.channel])}
                        </span>
                      ) : (
                        <select
                          aria-label={t('triggersTable.channelFor', {
                            trigger: t(`triggers.${row.trigger}`),
                          })}
                          value={row.channel}
                          disabled={busy}
                          onChange={(e) =>
                            void setTrigger(
                              row,
                              row.enabled,
                              row.templateKind,
                              e.target.value as AutomsgChannel
                            )
                          }
                          className="border-input bg-card dark:bg-input/30 h-8 rounded-md border px-2 text-sm disabled:opacity-60"
                        >
                          {AUTOMSG_CHANNELS.map((c) => (
                            <option key={c} value={c}>
                              {t(CHANNEL_LABEL_KEYS[c])}
                            </option>
                          ))}
                        </select>
                      )}
                      {row.rcsNotConnected && (
                        <span className="bg-warning-soft text-warning mt-1.5 block w-fit rounded-full px-2 py-0.5 text-xs">
                          {t('rcs.notConnected')}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="align-top whitespace-normal">
                      <div className="flex flex-wrap gap-1.5">
                        {approvalChips(row.approved).map((chip) => (
                          <span
                            key={chip.key}
                            className={`rounded-full px-2 py-0.5 text-xs ${CHIP_TONE[chip.tone]}`}
                          >
                            {t(`triggersTable.chips.${chip.key}`)}
                          </span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-center align-top">
                      <Checkbox
                        aria-label={t(`triggers.${row.trigger}`)}
                        checked={row.enabled}
                        disabled={row.switchDisabled || busy}
                        onCheckedChange={(v) =>
                          // The row's current kind: hr_automsg_trigger_set
                          // stores the kind it is given, so null here
                          // reset a chosen template to the default.
                          void setTrigger(row, v === true, row.templateKind)
                        }
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>

          <section className="border-border bg-card rounded-lg border">
            <h2 className="p-4 pb-2 font-medium">
              {t('consentByChannel.title')}
            </h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('consentByChannel.channel')}</TableHead>
                  <TableHead>{t('consentByChannel.required')}</TableHead>
                  <TableHead>{t('consentByChannel.recordedWhere')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {AUTOMSG_CHANNELS.map((c) => (
                  <TableRow key={c}>
                    <TableCell className="font-medium">
                      {t(CHANNEL_LABEL_KEYS[c])}
                    </TableCell>
                    <TableCell>
                      {t(
                        config.settings.requiresConsent
                          ? 'consentByChannel.yes'
                          : 'consentByChannel.no'
                      )}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {t('consentByChannel.inChat')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="text-muted-foreground p-4 pt-2 text-xs">
              {t('consentByChannel.note')}
            </p>
          </section>

          <AutomsgTemplates
            templates={config.templates}
            role={role}
            rcsConnected={rcsStatus?.connected === true}
            onSaved={() => load()}
          />

          <div className="space-y-2">
            {role === 'admin' && (
              <Button size="sm" disabled={busy} onClick={() => void runNow()}>
                {t('runRelease')}
              </Button>
            )}
            <AutomsgHistory role={role} refreshKey={historyKey} />
          </div>

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
}: {
  config: AutoMsgConfig;
  role: AutomsgRole;
  busy: boolean;
  onTurnOn: () => void;
  onTurnOff: () => void;
}) {
  const t = useTranslations('Hr.automsg.banner');
  const view = bannerView(config.settings, role);
  const off = view.state === 'off';
  return (
    <div
      className={
        off
          ? 'border-warning bg-warning-soft space-y-1.5 rounded-lg border-l-4 px-4 py-3'
          : 'border-success bg-success-soft space-y-1.5 rounded-lg border-l-4 px-4 py-3'
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <p
          className={
            off ? 'text-warning font-semibold' : 'text-success font-semibold'
          }
        >
          {t(off ? 'offTitle' : 'onTitle')}
        </p>
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
      </div>
      <p className={off ? 'text-warning text-xs' : 'text-success text-xs'}>
        {t('safety')}
      </p>
    </div>
  );
}

/** Chip colours for the "Approved templates" cell (status tokens). */
const CHIP_TONE: Record<ApprovalChip['tone'], string> = {
  ok: 'bg-success-soft text-success',
  missing: 'bg-muted text-muted-foreground',
  warning: 'bg-warning-soft text-warning',
};

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
    <label className="flex flex-col gap-1 text-sm">
      <span className="inline-flex items-center gap-2">
        <span className="font-medium whitespace-nowrap">{label}</span>
        {children}
      </span>
      {error && <span className="text-destructive block text-xs">{error}</span>}
    </label>
  );
}
