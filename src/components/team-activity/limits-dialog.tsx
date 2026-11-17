'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { NewChatNoticeSection } from '@/components/team-activity/new-chat-notice-section';
import { hourLabel } from '@/lib/team-activity/format';
import {
  BOOLEAN_LIMITS,
  LIMIT_BOUNDS,
  TEAM_ACTIVITY_DEFAULTS,
  isValidTimeZone,
  type TeamActivityLimits,
} from '@/lib/team-activity/limits';
import {
  RESTRICTION_RULES,
  limitValueValid,
  ruleSwitchesDisabled,
} from '@/lib/team-activity/restrictions';

type NumericKey = keyof typeof LIMIT_BOUNDS;

const NUMBER_FIELDS: NumericKey[] = [
  'dailyNewChatsPerUser',
  'dailyNewChatsPerNumber',
  'minReplyRate',
  'maxUnansweredInRow',
  'burstNewChats10min',
];

type BooleanKey = (typeof BOOLEAN_LIMITS)[number];

const RESTRICTION_NUMBER_FIELDS: {
  key: 'sameOpenerMax' | 'replyRateThrottlePct' | 'jevBlockMinP';
  step: number;
  width: string;
}[] = [
  { key: 'sameOpenerMax', step: 1, width: 'w-32' },
  { key: 'replyRateThrottlePct', step: 1, width: 'w-32' },
  { key: 'jevBlockMinP', step: 0.01, width: 'w-32' },
];

const ACCESS_FLAGS = [
  'allowUnlockRequests',
  'agentViewEnabled',
  'leaderViewEnabled',
] as const;

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * The account's limits, editable by admins. Opened from the page
 * header, which remounts it (a new `key`) on every open so the form
 * starts from what the page shows.
 */
export function LimitsDialog({
  open,
  onOpenChange,
  limits,
  saved,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  limits: TeamActivityLimits;
  /** Whether these limits were saved before (else they are the defaults). */
  saved: boolean;
  onSaved: (limits: TeamActivityLimits) => void;
}) {
  const t = useTranslations('TeamActivity.limits');
  const [form, setForm] = useState<TeamActivityLimits>(limits);
  const [zone, setZone] = useState(limits.timezone ?? browserZone());
  const [saving, setSaving] = useState(false);

  const zoneValid = isValidTimeZone(zone.trim());
  const outOfBounds =
    NUMBER_FIELDS.some((k) => {
      const v = form[k];
      const [min, max] = LIMIT_BOUNDS[k];
      return !Number.isInteger(v) || v < min || v > max;
    }) ||
    RESTRICTION_NUMBER_FIELDS.some((f) => !limitValueValid(f.key, form[f.key]));
  const rulesOff = ruleSwitchesDisabled(form);

  const setFlag = (key: BooleanKey, checked: boolean) =>
    setForm((f) => ({ ...f, [key]: checked }));

  const setNumber = (key: NumericKey, raw: string) => {
    const n = raw === '' ? Number.NaN : Number(raw);
    setForm((f) => ({ ...f, [key]: n }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/team-activity/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, timezone: zone.trim() }),
      });
      const body = (await res.json().catch(() => null)) as {
        limits?: TeamActivityLimits;
        error?: string;
      } | null;
      if (!res.ok || !body?.limits) {
        toast.error(body?.error ?? t('saveFailed'));
        return;
      }
      toast.success(t('saved'));
      onSaved(body.limits);
      onOpenChange(false);
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {saved ? t('description') : t('descriptionDefaults')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {NUMBER_FIELDS.map((key) => {
            const [min, max] = LIMIT_BOUNDS[key];
            const value = form[key];
            const invalid =
              !Number.isInteger(value) || value < min || value > max;
            return (
              <div key={key} className="grid gap-1.5">
                <Label htmlFor={`ta-${key}`}>{t(`${key}.label`)}</Label>
                <Input
                  id={`ta-${key}`}
                  type="number"
                  inputMode="numeric"
                  min={min}
                  max={max}
                  step={1}
                  value={Number.isFinite(value) ? String(value) : ''}
                  onChange={(e) => setNumber(key, e.target.value)}
                  aria-invalid={invalid}
                  className="w-32"
                />
                <p className="text-muted-foreground text-xs">
                  {t(`${key}.help`, {
                    recommended: TEAM_ACTIVITY_DEFAULTS[key],
                  })}
                </p>
              </div>
            );
          })}

          <div className="grid gap-1.5">
            <Label>{t('quietHours.label')}</Label>
            <div className="flex items-center gap-2 text-sm">
              <select
                aria-label={t('quietHours.start')}
                value={form.quietHoursStart}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    quietHoursStart: Number(e.target.value),
                  }))
                }
                className="border-input dark:bg-input/30 h-8 rounded-lg border bg-transparent px-2 text-sm"
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
              <span className="text-muted-foreground">
                {t('quietHours.to')}
              </span>
              <select
                aria-label={t('quietHours.end')}
                value={form.quietHoursEnd}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    quietHoursEnd: Number(e.target.value),
                  }))
                }
                className="border-input dark:bg-input/30 h-8 rounded-lg border bg-transparent px-2 text-sm"
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-muted-foreground text-xs">
              {t('quietHours.help')}
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ta-timezone">{t('timezone.label')}</Label>
            <Input
              id="ta-timezone"
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              aria-invalid={!zoneValid}
              className="w-64"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-xs">
              {zoneValid ? t('timezone.help') : t('timezone.invalid')}
            </p>
          </div>

          <div className="border-border flex items-start justify-between gap-4 rounded-lg border p-3">
            <div>
              <p className="text-foreground text-sm font-medium">
                {t('notify.label')}
              </p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t('notify.help')}
              </p>
            </div>
            <Switch
              checked={form.notify}
              onCheckedChange={(checked) =>
                setForm((f) => ({ ...f, notify: checked }))
              }
              aria-label={t('notify.label')}
            />
          </div>

          <div className="border-border space-y-3 rounded-lg border p-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-foreground text-sm font-medium">
                  {t('restrictions.master.label')}
                </p>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {t('restrictions.master.help')}
                </p>
              </div>
              <Switch
                checked={form.blockOverLimit}
                onCheckedChange={(checked) =>
                  setFlag('blockOverLimit', checked)
                }
                aria-label={t('restrictions.master.label')}
              />
            </div>

            <div className="bg-card-2 space-y-3 rounded-md p-3">
              {RESTRICTION_RULES.map((key) => (
                <div
                  key={key}
                  className="flex items-start justify-between gap-4"
                >
                  <div className={rulesOff ? 'opacity-60' : undefined}>
                    <p className="text-foreground text-sm font-medium">
                      {t(`restrictions.${key}.label`)}
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {t(`restrictions.${key}.help`, {
                        n: form.maxUnansweredInRow,
                        max: form.sameOpenerMax,
                        pct: form.replyRateThrottlePct,
                      })}
                    </p>
                  </div>
                  <Switch
                    checked={form[key]}
                    disabled={rulesOff}
                    onCheckedChange={(checked) => setFlag(key, checked)}
                    aria-label={t(`restrictions.${key}.label`)}
                  />
                </div>
              ))}
            </div>

            {RESTRICTION_NUMBER_FIELDS.map(({ key, step, width }) => {
              const [min, max] = LIMIT_BOUNDS[key];
              const value = form[key];
              return (
                <div key={key} className="grid gap-1.5">
                  <Label htmlFor={`ta-${key}`}>
                    {t(`restrictions.${key}.label`)}
                  </Label>
                  <Input
                    id={`ta-${key}`}
                    type="number"
                    inputMode="decimal"
                    min={min}
                    max={max}
                    step={step}
                    value={Number.isFinite(value) ? String(value) : ''}
                    onChange={(e) => setNumber(key, e.target.value)}
                    aria-invalid={!limitValueValid(key, value)}
                    className={width}
                  />
                  <p className="text-muted-foreground text-xs">
                    {t(`restrictions.${key}.help`)}
                  </p>
                </div>
              );
            })}
          </div>

          <div className="border-border space-y-3 rounded-lg border p-3">
            {ACCESS_FLAGS.map((key) => (
              <div key={key} className="flex items-start justify-between gap-4">
                <p className="text-foreground text-sm">
                  {t(`restrictions.${key}.label`)}
                </p>
                <Switch
                  checked={form[key]}
                  onCheckedChange={(checked) => setFlag(key, checked)}
                  aria-label={t(`restrictions.${key}.label`)}
                />
              </div>
            ))}
          </div>

          <NewChatNoticeSection />
        </div>

        <DialogFooter className="flex-row flex-wrap justify-between gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              setForm({ ...TEAM_ACTIVITY_DEFAULTS, timezone: form.timezone })
            }
          >
            {t('reset')}
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              onClick={() => void save()}
              disabled={saving || outOfBounds || !zoneValid}
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
