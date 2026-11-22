'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DEFAULT_RESPONSE_SETTINGS,
  MAX_TARGET_MINUTES,
  MIN_TARGET_MINUTES,
  WEEKDAYS,
  endFromInput,
  endToInput,
  nextInterval,
  parseResponseSettings,
  validateHours,
  type HoursInterval,
  type ResponseSettings,
  type Weekday,
} from '@/lib/response-times/hours';
import { SettingsPanelHead } from './settings-panel-head';

function timeZones(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  return zones.includes(current) ? zones : [current, ...zones];
}

const ERROR_KEYS = [
  'invalid_timezone',
  'invalid_hours',
  'invalid_target',
  'not_allowed',
] as const;

/**
 * Settings -> Inbox & CRM -> Response times (migration 237): the
 * workspace's business hours, response target and the escalation
 * switch (off by default). GET / PUT /api/response-times/settings,
 * owner/admin only (the section's gate, the route and the RPC).
 */
export function ResponseTimesPanel() {
  const t = useTranslations('ResponseTimes');
  const { accountId } = useAuth();
  const [form, setForm] = useState<ResponseSettings | null>(null);
  const [targetText, setTargetText] = useState('');
  const [available, setAvailable] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/response-times/settings');
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) throw new Error(String(body?.error ?? res.status));
        const s = parseResponseSettings(body?.settings);
        setForm(s);
        setTargetText(String(s.targetMinutes));
        setAvailable(body?.available !== false);
        setDirty(false);
      } catch {
        if (cancelled) return;
        toast.error(t('loadFailed'));
        setForm(DEFAULT_RESPONSE_SETTINGS);
        setTargetText(String(DEFAULT_RESPONSE_SETTINGS.targetMinutes));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, t]);

  const zones = useMemo(
    () => timeZones(form?.timezone ?? DEFAULT_RESPONSE_SETTINGS.timezone),
    [form?.timezone]
  );

  if (!form) {
    return (
      <div>
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <Loader2 className="text-muted-foreground size-4 animate-spin" />
      </div>
    );
  }

  const target = Number(targetText);
  const targetValid =
    /^\d+$/.test(targetText.trim()) &&
    target >= MIN_TARGET_MINUTES &&
    target <= MAX_TARGET_MINUTES;
  const hoursValid = validateHours(form.hours);
  const canSave = available && dirty && targetValid && hoursValid && !saving;

  const update = (next: ResponseSettings) => {
    setForm(next);
    setDirty(true);
  };
  const setDay = (day: Weekday, intervals: HoursInterval[]) =>
    update({ ...form, hours: { ...form.hours, [day]: intervals } });

  async function save() {
    if (!form || !canSave) return;
    setSaving(true);
    try {
      const res = await fetch('/api/response-times/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: form.enabled,
          timezone: form.timezone,
          hours: form.hours,
          targetMinutes: target,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = (ERROR_KEYS as readonly string[]).includes(body?.error)
          ? (body.error as (typeof ERROR_KEYS)[number])
          : null;
        toast.error(code ? t(`errors.${code}`) : t('saveFailed'));
        return;
      }
      const s = parseResponseSettings(body?.settings);
      setForm(s);
      setTargetText(String(s.targetMinutes));
      setDirty(false);
      toast.success(t('saved'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {!available ? (
        <p className="border-border bg-card-2 text-muted-foreground rounded-lg border p-3 text-sm">
          {t('notAvailable')}
        </p>
      ) : null}

      <section className="border-border bg-card flex items-start justify-between gap-4 rounded-lg border p-4">
        <div className="min-w-0">
          <p id="rt-enabled" className="text-foreground text-sm font-medium">
            {t('enabled')}
          </p>
          <p className="text-muted-foreground text-xs">{t('enabledHint')}</p>
        </div>
        <Switch
          checked={form.enabled}
          disabled={!available || saving}
          aria-labelledby="rt-enabled"
          onCheckedChange={(on) => update({ ...form, enabled: on })}
        />
      </section>

      <section className="border-border bg-card space-y-4 rounded-lg border p-4">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="rt-target">{t('target')}</Label>
            <div className="flex items-center gap-2">
              <Input
                id="rt-target"
                inputMode="numeric"
                className="w-24"
                value={targetText}
                aria-invalid={!targetValid}
                onChange={(e) => {
                  setTargetText(e.target.value);
                  setDirty(true);
                }}
              />
              <span className="text-muted-foreground text-sm">
                {t('minutes')}
              </span>
            </div>
            <p
              className={
                targetValid
                  ? 'text-muted-foreground text-xs'
                  : 'text-destructive text-xs'
              }
            >
              {targetValid ? t('targetHint') : t('errors.invalid_target')}
            </p>
          </div>
          <div className="min-w-0 space-y-1">
            <Label>{t('timezone')}</Label>
            <Select
              value={form.timezone}
              onValueChange={(v) => {
                if (typeof v === 'string' && v)
                  update({ ...form, timezone: v });
              }}
            >
              <SelectTrigger className="w-full" aria-label={t('timezone')}>
                <SelectValue>{form.timezone}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {zones.map((z) => (
                  <SelectItem key={z} value={z}>
                    {z}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </section>

      <section className="border-border bg-card space-y-3 rounded-lg border p-4">
        <div>
          <h3 className="text-foreground text-sm font-medium">
            {t('hoursTitle')}
          </h3>
          <p className="text-muted-foreground text-xs">{t('hoursHint')}</p>
        </div>
        <ul className="divide-border divide-y">
          {WEEKDAYS.map((day) => {
            const intervals = form.hours[day];
            const open = intervals.length > 0;
            const more = nextInterval(intervals);
            return (
              <li
                key={day}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start"
              >
                <div className="flex items-center justify-between gap-3 sm:w-44 sm:shrink-0 sm:pt-1">
                  <span
                    id={`rt-day-${day}`}
                    className="text-foreground text-sm"
                  >
                    {t(`days.${day}`)}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground text-xs">
                      {open ? t('open') : t('closed')}
                    </span>
                    <Switch
                      checked={open}
                      aria-labelledby={`rt-day-${day}`}
                      onCheckedChange={(on) =>
                        setDay(day, on ? [['09:00', '18:00']] : [])
                      }
                    />
                  </div>
                </div>
                {open ? (
                  <div className="min-w-0 flex-1 space-y-2">
                    {intervals.map(([start, end], i) => (
                      <div
                        key={i}
                        className="flex flex-wrap items-center gap-2"
                      >
                        <Input
                          type="time"
                          className="w-28"
                          aria-label={t('from', { day: t(`days.${day}`) })}
                          value={start}
                          onChange={(e) => {
                            const next = intervals.map(
                              (iv, j) =>
                                (j === i
                                  ? [e.target.value, iv[1]]
                                  : iv) as HoursInterval
                            );
                            setDay(day, next);
                          }}
                        />
                        <span className="text-muted-foreground text-sm">
                          {t('to')}
                        </span>
                        <Input
                          type="time"
                          className="w-28"
                          aria-label={t('until', { day: t(`days.${day}`) })}
                          value={endToInput(end)}
                          onChange={(e) => {
                            const next = intervals.map(
                              (iv, j) =>
                                (j === i
                                  ? [iv[0], endFromInput(e.target.value)]
                                  : iv) as HoursInterval
                            );
                            setDay(day, next);
                          }}
                        />
                        {intervals.length > 1 ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('removeHours')}
                            onClick={() =>
                              setDay(
                                day,
                                intervals.filter((_, j) => j !== i)
                              )
                            }
                          >
                            <X />
                          </Button>
                        ) : null}
                      </div>
                    ))}
                    {more ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setDay(day, [...intervals, more])}
                      >
                        <Plus />
                        {t('addHours')}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        {!hoursValid ? (
          <p className="text-destructive text-xs">
            {t('errors.invalid_hours')}
          </p>
        ) : null}
      </section>

      <div className="flex justify-end">
        <Button type="button" onClick={() => void save()} disabled={!canSave}>
          {saving ? <Loader2 className="animate-spin" /> : null}
          {t('save')}
        </Button>
      </div>
    </div>
  );
}
