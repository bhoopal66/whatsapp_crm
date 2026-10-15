'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BellRing, Moon, Send, Smartphone } from 'lucide-react';
import { toast } from 'sonner';

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
import { usePushSubscription } from '@/hooks/use-push-subscription';
import type { PushKind } from '@/lib/push/kinds';
import {
  DEFAULT_PUSH_PREFERENCES,
  groupedPushKinds,
  isKindOn,
  parsePushPreferences,
  preferencesToSave,
  type PushPreferences,
} from '@/lib/push/settings';
import { SettingsPanelHead } from './settings-panel-head';

const SAVE_DELAY_MS = 600;

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function timeZones(current: string | null): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  const extra = [current, browserTimeZone()].filter(
    (z): z is string => !!z && !zones.includes(z)
  );
  return [...extra, ...zones];
}

/**
 * Settings → My account → Notifications: this device's web push switch
 * and the person's push preferences (GET/PUT /api/push/preferences),
 * saved on change after a short pause.
 */
export function NotificationsSettings() {
  const t = useTranslations('PushNotifications');
  const push = usePushSubscription();
  const [prefs, setPrefs] = useState<PushPreferences | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zones = useMemo(
    () => timeZones(prefs?.timeZone ?? null),
    [prefs?.timeZone]
  );

  useEffect(() => {
    let cancelled = false;
    fetch('/api/push/preferences')
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((body: unknown) => {
        if (cancelled) return;
        const p = parsePushPreferences(body);
        setPrefs({ ...p, timeZone: p.timeZone ?? browserTimeZone() });
      })
      .catch(() => {
        if (cancelled) return;
        toast.error(t('loadFailed'));
        setPrefs({ ...DEFAULT_PUSH_PREFERENCES, timeZone: browserTimeZone() });
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    []
  );

  const update = useCallback(
    (next: PushPreferences) => {
      setPrefs(next);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const body = preferencesToSave(next);
      if (!body) return;
      saveTimer.current = setTimeout(() => {
        fetch('/api/push/preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then((res) => {
            if (res.ok) toast.success(t('saved'), { id: 'push-prefs' });
            else toast.error(t('saveFailed'), { id: 'push-prefs' });
          })
          .catch(() => toast.error(t('saveFailed'), { id: 'push-prefs' }));
      }, SAVE_DELAY_MS);
    },
    [t]
  );

  const toggleDevice = async (on: boolean) => {
    if (on) {
      const result = await push.subscribe();
      if (result === 'on') toast.success(t('turnedOn'));
      else if (result === 'not_configured') toast.error(t('notConfigured'));
      else if (result === 'denied') toast.error(t('permissionDenied'));
      else toast.error(t('subscribeFailed'));
    } else {
      const ok = await push.unsubscribe();
      if (ok) toast.success(t('turnedOff'));
      else toast.error(t('unsubscribeFailed'));
    }
  };

  const sendTest = async () => {
    const result = await push.sendTest();
    if (result === 'sent') toast.success(t('testSent'));
    else if (result === 'none') toast.error(t('testNone'));
    else if (result === 'not_configured') toast.error(t('testNotConfigured'));
    else toast.error(t('testFailed'));
  };

  const statusKey =
    push.state === 'ios-needs-install' ? 'iosNeedsInstall' : push.state;
  const canToggle = push.state === 'on' || push.state === 'off';
  const quietIncomplete =
    prefs !== null &&
    (!!prefs.quietStart || !!prefs.quietEnd) &&
    preferencesToSave(prefs) === null;

  return (
    <section className="animate-in fade-in-50 max-w-3xl duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <div className="border-border bg-card space-y-4 rounded-xl border p-4">
        <h3 className="text-foreground flex items-center gap-2 text-sm font-semibold">
          <Smartphone className="text-muted-foreground size-4" />
          {t('deviceTitle')}
        </h3>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <Label htmlFor="push-device">{t('deviceSwitch')}</Label>
            <p className="text-muted-foreground mt-1 text-sm">
              {t(`status.${statusKey}`)}
            </p>
          </div>
          <Switch
            id="push-device"
            checked={push.state === 'on'}
            disabled={!canToggle || push.busy}
            onCheckedChange={(v) => void toggleDevice(v)}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={push.state !== 'on'}
          onClick={() => void sendTest()}
        >
          <Send />
          {t('sendTest')}
        </Button>
      </div>

      {prefs ? (
        <>
          <div className="border-border bg-card mt-6 space-y-4 rounded-xl border p-4">
            <div>
              <h3 className="text-foreground flex items-center gap-2 text-sm font-semibold">
                <BellRing className="text-muted-foreground size-4" />
                {t('preferencesTitle')}
              </h3>
              <p className="text-muted-foreground mt-1 text-sm">
                {t('preferencesDescription')}
              </p>
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="push-enabled">{t('masterSwitch')}</Label>
              <Switch
                id="push-enabled"
                checked={prefs.enabled}
                onCheckedChange={(v) => update({ ...prefs, enabled: v })}
              />
            </div>
            {groupedPushKinds().map(({ group, kinds }) => (
              <fieldset
                key={group}
                disabled={!prefs.enabled}
                className="space-y-2"
              >
                <legend className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">
                  {t(`groups.${group}`)}
                </legend>
                {kinds.map((kind: PushKind) => (
                  <div
                    key={kind}
                    className="flex items-center justify-between gap-4"
                  >
                    <Label
                      htmlFor={`push-kind-${kind}`}
                      className="font-normal"
                    >
                      {t(`kinds.${kind}`)}
                    </Label>
                    <Switch
                      id={`push-kind-${kind}`}
                      checked={isKindOn(prefs, kind)}
                      disabled={!prefs.enabled}
                      onCheckedChange={(v) =>
                        update({
                          ...prefs,
                          kinds: { ...prefs.kinds, [kind]: v },
                        })
                      }
                    />
                  </div>
                ))}
              </fieldset>
            ))}
          </div>

          <div className="border-border bg-card mt-6 space-y-4 rounded-xl border p-4">
            <div>
              <h3 className="text-foreground flex items-center gap-2 text-sm font-semibold">
                <Moon className="text-muted-foreground size-4" />
                {t('quietTitle')}
              </h3>
              <p className="text-muted-foreground mt-1 text-sm">
                {t('quietDescription')}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-[8rem_8rem_minmax(0,1fr)]">
              <div className="space-y-1">
                <Label htmlFor="push-quiet-start">{t('quietStart')}</Label>
                <Input
                  id="push-quiet-start"
                  type="time"
                  value={prefs.quietStart ?? ''}
                  onChange={(e) =>
                    update({ ...prefs, quietStart: e.target.value || null })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="push-quiet-end">{t('quietEnd')}</Label>
                <Input
                  id="push-quiet-end"
                  type="time"
                  value={prefs.quietEnd ?? ''}
                  onChange={(e) =>
                    update({ ...prefs, quietEnd: e.target.value || null })
                  }
                />
              </div>
              <div className="min-w-0 space-y-1">
                <Label>{t('timeZone')}</Label>
                <Select
                  value={prefs.timeZone ?? browserTimeZone()}
                  onValueChange={(v) => {
                    if (typeof v === 'string' && v)
                      update({ ...prefs, timeZone: v });
                  }}
                >
                  <SelectTrigger className="w-full" aria-label={t('timeZone')}>
                    <SelectValue>
                      {prefs.timeZone ?? browserTimeZone()}
                    </SelectValue>
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
            {quietIncomplete ? (
              <p className="text-muted-foreground text-sm">
                {t('quietIncomplete')}
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
