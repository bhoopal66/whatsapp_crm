'use client';

// Settings → Phone system: "Service details after a call" (migration 336,
// docs/yeastar.md). Owners and admins only, as /api/pbx/service-details
// and 336's RPCs are: anyone else gets nothing from this component, even
// if a parent mounts it. Off by default, and it cannot be switched on
// without an approved utility template.

import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2 } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import type {
  ServiceDetailsSettings,
  ServiceMatchType,
} from '@/lib/pbx/service-details';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

import { pbxFetch } from './fetch';

const MATCH_TYPES: ServiceMatchType[] = ['queue', 'did', 'extension'];

interface MapRow {
  id: string | null;
  matchType: ServiceMatchType;
  matchValue: string;
  label: string;
}
interface Loaded {
  settings: ServiceDetailsSettings;
  map: MapRow[];
  templates: { name: string; language: string }[] | null;
}

export function ServiceDetailsCard() {
  const { accountRole } = useAuth();
  if (!accountRole || !canEditSettings(accountRole)) return null;
  return <ServiceDetailsEditor />;
}

function ServiceDetailsEditor() {
  const t = useTranslations('Settings.phoneSystem.serviceDetails');
  const id = useId();
  const [data, setData] = useState<Loaded | null>(null);
  const [s, setS] = useState<ServiceDetailsSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const read = useCallback(
    () =>
      pbxFetch<Loaded>('/api/pbx/service-details').then((res) => {
        setFailed(!res.ok);
        if (!res.ok) return;
        setData(res.data);
        setS(res.data.settings);
      }),
    []
  );
  useEffect(() => {
    void read();
  }, [read]);
  const load = () => {
    setFailed(false);
    void read();
  };

  const templates = data?.templates ?? [];
  const names = [...new Set(templates.map((x) => x.name))];
  const languages = templates
    .filter((x) => x.name === s?.templateName)
    .map((x) => x.language);
  const set = <K extends keyof ServiceDetailsSettings>(
    k: K,
    v: ServiceDetailsSettings[K]
  ) => s && setS({ ...s, [k]: v });

  const save = async () => {
    if (!s) return;
    setBusy(true);
    const res = await pbxFetch<{ settings: ServiceDetailsSettings }>(
      '/api/pbx/service-details',
      { method: 'PUT', body: s }
    );
    setBusy(false);
    if (res.ok) {
      setS(res.data.settings);
      toast.success(t('saved'));
    } else
      toast.error(
        t(res.code === 'NO_TEMPLATE' ? 'needTemplate' : 'saveFailed')
      );
  };

  return (
    <section className="border-border bg-card min-w-0 space-y-4 rounded-xl border p-4 text-sm">
      <div>
        <h3 className="text-foreground text-base font-semibold">
          {t('title')}
        </h3>
        <p className="text-muted-foreground">
          {t('hint', { one: '{{1}}', two: '{{2}}' })}
        </p>
      </div>
      {failed ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-destructive">{t('loadFailed')}</p>
          <Button variant="outline" size="sm" onClick={load}>
            {t('retry')}
          </Button>
        </div>
      ) : !s || !data ? (
        <div className="bg-muted/50 h-24 animate-pulse rounded-lg" />
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Label htmlFor={`${id}-enabled`}>{t('enabled')}</Label>
              <p className="text-muted-foreground text-xs">
                {s.templateName
                  ? t(s.enabled ? 'on' : 'off')
                  : t('needTemplate')}
              </p>
            </div>
            <Switch
              id={`${id}-enabled`}
              checked={s.enabled}
              disabled={!s.templateName && !s.enabled}
              onCheckedChange={(v) => set('enabled', !!v)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-template`}>{t('template')}</Label>
              <Select
                value={s.templateName ?? ''}
                onValueChange={(v) => {
                  if (typeof v !== 'string' || !v) return;
                  const first = templates.find((x) => x.name === v);
                  setS({
                    ...s,
                    templateName: v,
                    language: first?.language ?? null,
                  });
                }}
              >
                <SelectTrigger id={`${id}-template`} className="w-full">
                  <SelectValue>
                    {s.templateName ?? t('chooseTemplate')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {names.map((n) => (
                    <SelectItem key={n} value={n}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {data.templates && names.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  {t('noTemplates')}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-language`}>{t('language')}</Label>
              <Select
                value={s.language ?? ''}
                disabled={!s.templateName}
                onValueChange={(v) =>
                  typeof v === 'string' && v && set('language', v)
                }
              >
                <SelectTrigger id={`${id}-language`} className="w-full">
                  <SelectValue>{s.language ?? '-'}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {languages.map((l) => (
                    <SelectItem key={l} value={l}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-min`}>{t('minSeconds')}</Label>
              <Input
                id={`${id}-min`}
                type="number"
                inputMode="numeric"
                min={0}
                max={3600}
                value={Number.isNaN(s.minSeconds) ? '' : s.minSeconds}
                onChange={(e) =>
                  set(
                    'minSeconds',
                    e.target.value === '' ? NaN : Number(e.target.value)
                  )
                }
              />
            </div>
          </div>
          <div className="space-y-3 border-s ps-3">
            {(['inbound', 'outbound'] as const).map((k) => (
              <div key={k} className="flex items-center justify-between gap-3">
                <Label htmlFor={`${id}-${k}`}>{t(k)}</Label>
                <Switch
                  id={`${id}-${k}`}
                  checked={s[k]}
                  onCheckedChange={(v) => set(k, !!v)}
                />
              </div>
            ))}
          </div>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t('save')}
          </Button>
          <ServiceMapEditor
            initial={data.map}
            onChange={(map) => setData({ ...data, map })}
          />
        </>
      )}
    </section>
  );
}

const BLANK: MapRow = {
  id: null,
  matchType: 'queue',
  matchValue: '',
  label: '',
};

function ServiceMapEditor({
  initial,
  onChange,
}: {
  initial: MapRow[];
  onChange: (rows: MapRow[]) => void;
}) {
  const t = useTranslations('Settings.phoneSystem.serviceDetails.map');
  const [rows, setRows] = useState<MapRow[]>(initial);
  const [draft, setDraft] = useState<MapRow>(BLANK);
  const [busy, setBusy] = useState(false);

  const commit = (next: MapRow[]) => {
    setRows(next);
    onChange(next);
  };

  const saveRow = async (row: MapRow, index: number | null) => {
    setBusy(true);
    const res = await pbxFetch<{ row: MapRow }>('/api/pbx/service-details', {
      method: 'POST',
      body: {
        matchType: row.matchType,
        matchValue: row.matchValue,
        label: row.label,
        ...(row.id ? { replaces: row.id } : {}),
      },
    });
    setBusy(false);
    if (!res.ok) return void toast.error(t('saveFailed'));
    const saved = res.data.row;
    // An upsert onto another row's key replaces that row too.
    const rest = rows.filter(
      (r, i) =>
        i !== index &&
        r.id !== saved.id &&
        !(r.matchType === saved.matchType && r.matchValue === saved.matchValue)
    );
    commit([...rest, saved]);
    if (index === null) setDraft(BLANK);
    toast.success(t('saved'));
  };

  const remove = async (row: MapRow) => {
    if (!row.id) return;
    setBusy(true);
    const res = await pbxFetch(
      `/api/pbx/service-details?id=${encodeURIComponent(row.id)}`,
      { method: 'DELETE' }
    );
    setBusy(false);
    if (!res.ok) return void toast.error(t('saveFailed'));
    commit(rows.filter((r) => r.id !== row.id));
  };

  const line = (
    row: MapRow,
    edit: (r: MapRow) => void,
    actions: React.ReactNode,
    key: string
  ) => (
    <div
      key={key}
      className="grid items-center gap-2 sm:grid-cols-[8rem_1fr_2fr_auto]"
    >
      <Select
        value={row.matchType}
        onValueChange={(v) =>
          MATCH_TYPES.includes(v as ServiceMatchType) &&
          edit({ ...row, matchType: v as ServiceMatchType })
        }
      >
        <SelectTrigger aria-label={t('type')} className="w-full">
          <SelectValue>{t(`types.${row.matchType}`)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {MATCH_TYPES.map((m) => (
            <SelectItem key={m} value={m}>
              {t(`types.${m}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        aria-label={t('value')}
        placeholder={t('value')}
        maxLength={64}
        value={row.matchValue}
        onChange={(e) => edit({ ...row, matchValue: e.target.value })}
      />
      <Input
        aria-label={t('label')}
        placeholder={t('label')}
        maxLength={60}
        value={row.label}
        onChange={(e) => edit({ ...row, label: e.target.value })}
      />
      <div className="flex gap-1">{actions}</div>
    </div>
  );
  const ready = (r: MapRow) =>
    r.matchValue.trim() !== '' && r.label.trim() !== '';

  return (
    <div className="space-y-2 border-t pt-4">
      <h4 className="text-foreground font-medium">{t('title')}</h4>
      <p className="text-muted-foreground text-xs">{t('hint')}</p>
      {rows.map((row, i) =>
        line(
          row,
          (next) => setRows(rows.map((r, j) => (j === i ? next : r))),
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !ready(row)}
              onClick={() => void saveRow(row, i)}
            >
              {t('save')}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('delete')}
              disabled={busy}
              onClick={() => void remove(row)}
            >
              <Trash2 />
            </Button>
          </>,
          row.id ?? String(i)
        )
      )}
      {line(
        draft,
        setDraft,
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !ready(draft)}
          onClick={() => void saveRow(draft, null)}
        >
          <Plus />
          {t('add')}
        </Button>,
        'draft'
      )}
    </div>
  );
}
