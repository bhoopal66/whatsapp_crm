'use client';

/**
 * Case CSAT settings (migration 246), owners and admins: off by default;
 * which moments ask (after submission, after approval); the Meta template
 * used outside the customer's 24-hour window; the language of the text
 * request; how long a reply counts; send hours (Dubai). Loads and saves
 * through /api/cases/csat-settings, version-checked (409: reload).
 *
 * Self-contained: mount it anywhere an owner or admin sees settings.
 * `readOnly` shows the values without the save button.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import type { CsatSettings } from '@/lib/cases/csat';

const LANGUAGES = ['en', 'ar'] as const;

export interface CsatSettingsCardProps {
  readOnly?: boolean;
  className?: string;
}

export function CsatSettingsCard({
  readOnly = false,
  className,
}: CsatSettingsCardProps) {
  const t = useTranslations('CaseCsat.settings');
  const id = useId();
  const [s, setS] = useState<CsatSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const res = await fetch('/api/cases/csat-settings');
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { settings: CsatSettings };
      setS(body.settings);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed)
    return (
      <Card className={className}>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm">
          <p className="text-destructive">{t('loadFailed')}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t('retry')}
          </Button>
        </CardContent>
      </Card>
    );
  if (!s) return null;

  const set = <K extends keyof CsatSettings>(k: K, v: CsatSettings[K]) =>
    setS({ ...s, [k]: v });
  const num = (v: string) => (v === '' ? NaN : Number(v));

  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/cases/csat-settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: s.enabled,
          askOnSubmitted: s.askOnSubmitted,
          askOnApproved: s.askOnApproved,
          templateSubmitted: s.templateSubmitted.trim(),
          templateApproved: s.templateApproved.trim(),
          language: s.language,
          replyWindowDays: s.replyWindowDays,
          sendStartHour: s.sendStartHour,
          sendEndHour: s.sendEndHour,
          expectedUpdatedAt: s.updatedAt,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        settings?: CsatSettings;
        code?: string;
      } | null;
      if (res.ok && body?.settings) {
        setS(body.settings);
        toast.success(t('saved'));
      } else if (body?.code === 'STALE') {
        toast.error(t('stale'));
        void load();
      } else if (body?.code === 'INVALID') {
        toast.error(t('invalid'));
      } else {
        toast.error(t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (
    key: 'enabled' | 'askOnSubmitted' | 'askOnApproved',
    label: string,
    hint?: string
  ) => (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <Label htmlFor={`${id}-${key}`}>{label}</Label>
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      </div>
      <Switch
        id={`${id}-${key}`}
        checked={s[key]}
        disabled={readOnly || (key !== 'enabled' && !s.enabled)}
        onCheckedChange={(v) => set(key, !!v)}
      />
    </div>
  );

  return (
    <Card className={className}>
      <CardContent className="space-y-4 text-sm">
        <div>
          <h2 className="text-foreground text-base font-semibold">
            {t('title')}
          </h2>
          <p className="text-muted-foreground">{t('hint')}</p>
        </div>
        {toggle('enabled', t('enabled'), s.enabled ? t('on') : t('off'))}
        <div className="space-y-3 border-s ps-3">
          {toggle('askOnSubmitted', t('askOnSubmitted'))}
          {toggle('askOnApproved', t('askOnApproved'))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-tpl-submitted`}>
              {t('templateSubmitted')}
            </Label>
            <Input
              id={`${id}-tpl-submitted`}
              value={s.templateSubmitted}
              maxLength={100}
              disabled={readOnly}
              onChange={(e) => set('templateSubmitted', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-tpl-approved`}>
              {t('templateApproved')}
            </Label>
            <Input
              id={`${id}-tpl-approved`}
              value={s.templateApproved}
              maxLength={100}
              disabled={readOnly}
              onChange={(e) => set('templateApproved', e.target.value)}
            />
          </div>
          <p className="text-muted-foreground text-xs sm:col-span-2">
            {t('templateHint', { one: '{{1}}', two: '{{2}}' })}
          </p>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-language`}>{t('language')}</Label>
            <Select
              value={s.language}
              disabled={readOnly}
              onValueChange={(v) => typeof v === 'string' && set('language', v)}
            >
              <SelectTrigger id={`${id}-language`} className="w-full">
                <SelectValue>
                  {LANGUAGES.includes(s.language as 'en' | 'ar')
                    ? t(`languages.${s.language as 'en' | 'ar'}`)
                    : s.language}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l} value={l}>
                    {t(`languages.${l}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-window`}>{t('replyWindowDays')}</Label>
            <Input
              id={`${id}-window`}
              type="number"
              inputMode="numeric"
              min={1}
              max={30}
              value={Number.isNaN(s.replyWindowDays) ? '' : s.replyWindowDays}
              disabled={readOnly}
              onChange={(e) => set('replyWindowDays', num(e.target.value))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-start`}>{t('sendStartHour')}</Label>
            <Input
              id={`${id}-start`}
              type="number"
              inputMode="numeric"
              min={8}
              max={20}
              value={Number.isNaN(s.sendStartHour) ? '' : s.sendStartHour}
              disabled={readOnly}
              onChange={(e) => set('sendStartHour', num(e.target.value))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-end`}>{t('sendEndHour')}</Label>
            <Input
              id={`${id}-end`}
              type="number"
              inputMode="numeric"
              min={9}
              max={21}
              value={Number.isNaN(s.sendEndHour) ? '' : s.sendEndHour}
              disabled={readOnly}
              onChange={(e) => set('sendEndHour', num(e.target.value))}
            />
          </div>
          <p className="text-muted-foreground text-xs sm:col-span-2">
            {t('hoursHint')}
          </p>
        </div>
        {!readOnly && (
          <Button disabled={busy} onClick={() => void save()}>
            {t('save')}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
