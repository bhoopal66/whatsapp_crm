'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { useAccountNumbers } from '@/hooks/use-whatsapp-numbers';
import { createClient } from '@/lib/supabase/client';
import { SHIPPED_WORKFLOW as DEF } from '@/lib/journeys/workflow';
import {
  LIST_BUTTON_LABEL_MAX,
  mergeCopy,
  type JourneyCopy,
} from '@/lib/journeys/host/copy';
import {
  blankMessageForm,
  copyFormFrom,
  copyOverrides,
  copyProblems,
  parseTaamulDid,
  sameOverrides,
  sessionMessages,
  sessionTitleLimits,
  templateChecklist,
  textLength,
  type ChecklistItem,
  type CopyForm,
  type CopyOverrides,
  type MessageForm,
  type TemplateRowLite,
} from '@/lib/journeys/settings-ui';
import { cn } from '@/lib/utils';

import { SettingsPanelHead } from './settings-panel-head';

/** `GET /api/journeys/settings` → `settings`. */
interface JourneySettings {
  enabled: boolean;
  startOnFirstInbound: boolean;
  taamulDid: string | null;
  copy: Record<string, unknown>;
}

type Patch = Partial<
  Pick<JourneySettings, 'enabled' | 'startOnFirstInbound' | 'taamulDid'>
> & { copy?: CopyOverrides };

const OK = 'text-success';
const WAIT = 'text-warning';

/**
 * Settings → Journey bot (module 016, admin+): the bot's switches, the
 * Call Taamul number, which of the workflow's templates each connected
 * kind of number can send, and the editable SESSION copy. Every save is
 * a PUT of only the fields it changes; the route validates again.
 */
export function JourneyBotSettings({
  onOpenTemplates,
}: {
  onOpenTemplates?: () => void;
}) {
  const t = useTranslations('Settings.journeyBot');
  const { accountId } = useAuth();
  const [settings, setSettings] = useState<JourneySettings | null>(null);
  const [defaults, setDefaults] = useState<JourneyCopy | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState<keyof Patch | null>(null);

  useEffect(() => {
    let off = false;
    fetch('/api/journeys/settings', { cache: 'no-store' })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.settings || !json.defaultCopy) throw new Error();
        if (off) return;
        setSettings(json.settings as JourneySettings);
        setDefaults(json.defaultCopy as JourneyCopy);
      })
      .catch(() => {
        if (!off) setLoadFailed(true);
      });
    return () => {
      off = true;
    };
  }, []);

  // The account's templates (members read them) and its kinds of number.
  const numbers = useAccountNumbers();
  const kinds = useMemo(
    () => [...new Set((numbers ?? []).map((n) => n.provider))],
    [numbers]
  );
  const [rows, setRows] = useState<TemplateRowLite[] | null>(null);
  const [rowsFailed, setRowsFailed] = useState(false);
  useEffect(() => {
    if (!accountId) return;
    let off = false;
    createClient()
      .from('message_templates')
      .select('name, language, status')
      .eq('account_id', accountId)
      .then(({ data, error }) => {
        if (off) return;
        setRowsFailed(!!error);
        setRows((data ?? []) as TemplateRowLite[]);
      });
    return () => {
      off = true;
    };
  }, [accountId]);

  /** PUTs `patch` (only those fields change); true once saved. */
  const save = async (patch: Patch): Promise<boolean> => {
    setSaving(Object.keys(patch)[0] as keyof Patch);
    try {
      const res = await fetch('/api/journeys/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.settings) throw new Error();
      setSettings(json.settings as JourneySettings);
      toast.success(t('saved'));
      return true;
    } catch {
      toast.error(t('saveFailed'));
      return false;
    } finally {
      setSaving(null);
    }
  };

  const head = (
    <SettingsPanelHead title={t('title')} description={t('description')} />
  );
  if (loadFailed)
    return (
      <section className="max-w-4xl">
        {head}
        <p className="text-destructive text-sm">{t('loadFailed')}</p>
      </section>
    );
  if (!settings || !defaults)
    return (
      <section className="max-w-4xl" aria-busy="true">
        {head}
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </section>
    );

  return (
    <section className="animate-in fade-in-50 max-w-4xl space-y-6 duration-200">
      {head}
      <Card>
        <CardHeader>
          <CardTitle>{t('bot.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <SwitchRow
            id="journey-bot-enabled"
            label={t('bot.enabled')}
            hint={t('bot.enabledHint')}
            checked={settings.enabled}
            disabled={saving !== null}
            onChange={(enabled) => void save({ enabled })}
          />
          <SwitchRow
            id="journey-bot-first-inbound"
            label={t('bot.firstInbound')}
            hint={t('bot.firstInboundHint')}
            checked={settings.startOnFirstInbound}
            disabled={saving !== null}
            onChange={(startOnFirstInbound) =>
              void save({ startOnFirstInbound })
            }
          />
        </CardContent>
      </Card>
      <DidCard
        saved={settings.taamulDid}
        saving={saving === 'taamulDid'}
        onSave={(taamulDid) => save({ taamulDid })}
      />
      <TemplatesCard
        items={templateChecklist(DEF, rows ?? [], kinds)}
        titles={mergeCopy(settings.copy).titles}
        loading={rows === null || numbers === null}
        failed={rowsFailed}
        hasMeta={kinds.includes('meta')}
        hasWhapi={kinds.includes('whapi')}
        onOpenTemplates={onOpenTemplates}
      />
      <CopyEditor
        defaults={defaults}
        saved={settings.copy}
        saving={saving === 'copy'}
        onSave={(copy) => save({ copy })}
      />
    </section>
  );
}

function SwitchRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p id={`${id}-label`} className="text-foreground text-sm font-medium">
          {label}
        </p>
        <p className="text-muted-foreground mt-1 max-w-[70ch] text-sm">
          {hint}
        </p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={(next) => onChange(next)}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
      />
    </div>
  );
}

function DidCard({
  saved,
  saving,
  onSave,
}: {
  saved: string | null;
  saving: boolean;
  onSave: (value: string | null) => Promise<boolean>;
}) {
  const t = useTranslations('Settings.journeyBot.did');
  const [draft, setDraft] = useState(saved ?? '');
  const parsed = parseTaamulDid(draft);
  const unchanged = parsed.ok && parsed.value === (saved ?? null);
  return (
    <Card>
      <CardHeader>
        <CardTitle id="journey-bot-did-label">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (parsed.ok && !unchanged) void onSave(parsed.value);
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            inputMode="tel"
            placeholder={t('placeholder')}
            aria-labelledby="journey-bot-did-label"
            aria-invalid={!parsed.ok}
            className="sm:max-w-xs"
          />
          <Button type="submit" disabled={!parsed.ok || unchanged || saving}>
            {saving && <Loader2 className="animate-spin" />}
            {t('save')}
          </Button>
        </form>
        {!parsed.ok ? (
          <p className="text-destructive text-xs">{t('invalid')}</p>
        ) : !saved ? (
          <p className="text-muted-foreground text-xs">{t('unset')}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TemplatesCard({
  items,
  titles,
  loading,
  failed,
  hasMeta,
  hasWhapi,
  onOpenTemplates,
}: {
  items: ChecklistItem[];
  titles: Record<string, string>;
  loading: boolean;
  failed: boolean;
  hasMeta: boolean;
  hasWhapi: boolean;
  onOpenTemplates?: () => void;
}) {
  const t = useTranslations('Settings.journeyBot.templates');
  const missing = (
    <span className="text-destructive">
      {t('state.missing')} —{' '}
      {onOpenTemplates ? (
        <button
          type="button"
          className="underline underline-offset-2"
          onClick={onOpenTemplates}
        >
          {t('state.create')}
        </button>
      ) : (
        t('state.create')
      )}
    </span>
  );
  const metaState = (i: ChecklistItem): ReactNode =>
    i.meta === 'approved' ? (
      <span className={OK}>{t('state.approved')}</span>
    ) : i.meta === 'pending' ? (
      <span className={WAIT}>{t('state.pending')}</span>
    ) : i.meta === 'notApproved' ? (
      <span className="text-destructive">
        {t('state.notApproved', { status: i.metaStatus ?? '' })}
      </span>
    ) : (
      missing
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        ) : (
          <>
            {failed && (
              <p className="text-destructive text-sm">{t('loadFailed')}</p>
            )}
            {!hasMeta && !hasWhapi && (
              <p className="text-muted-foreground text-sm">{t('noNumbers')}</p>
            )}
            <div className="-mx-1 overflow-x-auto px-1">
              <table className="w-full min-w-[36rem] text-sm">
                <thead>
                  <tr className="text-muted-foreground text-left text-xs">
                    <th className="py-1.5 pr-3 font-normal">{t('name')}</th>
                    <th className="py-1.5 pr-3 font-normal">{t('category')}</th>
                    <th className="py-1.5 pr-3 font-normal">{t('buttons')}</th>
                    {hasMeta && (
                      <th className="py-1.5 pr-3 font-normal">{t('meta')}</th>
                    )}
                    {hasWhapi && (
                      <th className="py-1.5 font-normal">{t('whapi')}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr
                      key={i.name}
                      className="border-border border-t align-top"
                    >
                      <td className="text-foreground py-2 pr-3 font-mono text-xs break-all">
                        {i.name}
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-[11px] font-medium',
                            i.category === 'MARKETING'
                              ? 'bg-primary-soft text-primary'
                              : 'bg-muted text-muted-foreground'
                          )}
                        >
                          {t(`categories.${i.category}`)}
                        </span>
                      </td>
                      <td className="text-muted-foreground py-2 pr-3 text-xs">
                        {[
                          ...i.buttons.map((id) => titles[id] ?? id),
                          ...(i.phoneButton ? [t('callButton')] : []),
                        ].join(' · ') || '—'}
                      </td>
                      {hasMeta && (
                        <td className="py-2 pr-3 text-xs">{metaState(i)}</td>
                      )}
                      {hasWhapi && (
                        <td className="py-2 text-xs">
                          {i.whapi === 'present' ? (
                            <span className={OK}>{t('state.present')}</span>
                          ) : (
                            missing
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <p className="text-muted-foreground text-xs">{t('sessionNote')}</p>
      </CardContent>
    </Card>
  );
}

function CopyEditor({
  defaults,
  saved,
  saving,
  onSave,
}: {
  defaults: JourneyCopy;
  saved: Record<string, unknown>;
  saving: boolean;
  onSave: (copy: CopyOverrides) => Promise<boolean>;
}) {
  const t = useTranslations('Settings.journeyBot.copy');
  // Seeded once: a save answers with exactly these overrides, so the
  // form never needs re-seeding (and a switch save cannot wipe edits).
  const [form, setForm] = useState<CopyForm>(() =>
    copyFormFrom(saved, defaults)
  );
  const messages = useMemo(() => sessionMessages(DEF, defaults), [defaults]);
  const limits = useMemo(() => sessionTitleLimits(DEF), []);
  const overrides = useMemo(
    () => copyOverrides(form, defaults),
    [form, defaults]
  );
  const dirty = !sameOverrides(
    overrides,
    copyOverrides(copyFormFrom(saved, defaults), defaults)
  );
  const problems = copyProblems(form, DEF);

  const setMessage = (name: string, patch: Partial<MessageForm>) =>
    setForm((f) => ({
      ...f,
      messages: { ...f.messages, [name]: { ...f.messages[name], ...patch } },
    }));
  const setTitle = (id: string, value: string) =>
    setForm((f) => ({ ...f, titles: { ...f.titles, [id]: value } }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {messages.map((m) => {
          const d = defaults.messages[m.name];
          const f = form.messages[m.name];
          const variantKeys = Object.keys(d.variants ?? {});
          const touched =
            !!f.body.trim() ||
            !!f.buttonLabel.trim() ||
            Object.values(f.variants).some((v) => v.trim());
          const labelLength = textLength(f.buttonLabel);
          return (
            <div
              key={m.name}
              className="border-border space-y-3 rounded-xl border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-foreground text-sm font-medium">
                    {t(`messages.${m.name}`)}
                  </p>
                  <p className="text-muted-foreground font-mono text-xs">
                    {m.name}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!touched}
                  onClick={() => setMessage(m.name, blankMessageForm(d))}
                >
                  <RotateCcw />
                  {t('reset')}
                </Button>
              </div>
              <Field label={variantKeys.length ? t('bodyFallback') : t('body')}>
                <Textarea
                  value={f.body}
                  placeholder={d.body}
                  rows={2}
                  onChange={(e) => setMessage(m.name, { body: e.target.value })}
                />
              </Field>
              {variantKeys.map((k) => (
                <Field key={k} label={t(`variants.${k}`)}>
                  <Textarea
                    value={f.variants[k] ?? ''}
                    placeholder={d.variants?.[k]}
                    rows={2}
                    onChange={(e) =>
                      setMessage(m.name, {
                        variants: { ...f.variants, [k]: e.target.value },
                      })
                    }
                  />
                </Field>
              ))}
              {m.list && (
                <Field label={t('buttonLabel')}>
                  <div className="flex items-center gap-2">
                    <Input
                      value={f.buttonLabel}
                      placeholder={d.buttonLabel}
                      aria-invalid={labelLength > LIST_BUTTON_LABEL_MAX}
                      onChange={(e) =>
                        setMessage(m.name, { buttonLabel: e.target.value })
                      }
                    />
                    <Counter
                      length={labelLength || textLength(d.buttonLabel ?? '')}
                      max={LIST_BUTTON_LABEL_MAX}
                    />
                  </div>
                </Field>
              )}
              {m.buttons.length > 0 && (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted-foreground text-left text-xs">
                      <th className="w-36 py-1 pr-2 font-normal">
                        {t('payload')}
                      </th>
                      <th className="py-1 font-normal" colSpan={3}>
                        {m.list ? t('rowTitle') : t('buttonTitle')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.buttons.map((id) => {
                      const value = form.titles[id] ?? '';
                      return (
                        <tr key={id}>
                          <td className="text-muted-foreground py-1 pr-2 font-mono text-xs break-all">
                            {id}
                          </td>
                          <td className="py-1">
                            <Input
                              value={value}
                              placeholder={defaults.titles[id]}
                              aria-label={id}
                              aria-invalid={textLength(value) > limits[id]}
                              onChange={(e) => setTitle(id, e.target.value)}
                            />
                          </td>
                          <td className="w-14 py-1 pl-2">
                            <Counter
                              length={
                                textLength(value) ||
                                textLength(defaults.titles[id] ?? '')
                              }
                              max={limits[id]}
                            />
                          </td>
                          <td className="w-9 py-1 pl-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('resetTitle')}
                              title={t('resetTitle')}
                              disabled={!value.trim()}
                              onClick={() => setTitle(id, '')}
                            >
                              <RotateCcw />
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
        <p className="text-muted-foreground text-xs">{t('sharedTitles')}</p>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {problems.length > 0 && (
            <p className="text-destructive text-xs">
              {t('tooLong', { count: problems.length })}
            </p>
          )}
          <Button
            disabled={!dirty || problems.length > 0 || saving}
            onClick={() => void onSave(overrides)}
          >
            {saving && <Loader2 className="animate-spin" />}
            {t('save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </label>
  );
}

function Counter({ length, max }: { length: number; max: number }) {
  return (
    <span
      className={cn(
        'text-xs whitespace-nowrap tabular-nums',
        length > max ? 'text-destructive' : 'text-muted-foreground'
      )}
    >
      {length}/{max}
    </span>
  );
}
