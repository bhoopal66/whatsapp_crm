'use client';

/**
 * Desk WhatsApp routing settings (migration 230), owners and admins:
 * the switch (off by default), the desk numbers and the escalation delay.
 * Saved against the version loaded (316), as the digest card.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { ChangedNotice } from '@/components/settings/case-files-settings';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import type { DeskSettings } from '@/lib/desk/tray';

import { deskApi } from './desk-api';
import { LoadFailed } from './load-failed';

export function RoutingSettings() {
  const t = useTranslations('Desk');
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [minutes, setMinutes] = useState('120');
  const [numbers, setNumbers] = useState<{ id: string; label: string }[]>([]);
  const [version, setVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [changed, setChanged] = useState<{
    stored: DeskSettings | null;
  } | null>(null);

  const load = useCallback(
    () =>
      deskApi.settings().then((r) => {
        setFailed(!r.ok);
        if (!r.ok) {
          toast.error(r.error);
          return;
        }
        setEnabled(r.data.settings.routingEnabled);
        setIds(r.data.settings.deskChannelIds);
        setMinutes(String(r.data.settings.escalateMinutes));
        setVersion(r.data.settings.updatedAt);
        setNumbers(r.data.numbers);
        setChanged(null);
        setLoaded(true);
      }),
    []
  );
  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    const r = await deskApi.saveSettings({
      routingEnabled: enabled,
      deskChannelIds: ids,
      escalateMinutes: Number(minutes),
      expectedUpdatedAt: version,
    });
    if (r.ok) {
      toast.success(t('routing.saved'));
      setVersion(r.data);
    } else if (r.code === 'SETTINGS_CHANGED') {
      const now = await deskApi.settings();
      setChanged({ stored: now.ok ? now.data.settings : null });
      if (now.ok) setNumbers(now.data.numbers);
    } else toast.error(r.error);
    setBusy(false);
  };

  if (!loaded)
    return failed ? (
      <Card>
        <CardContent>
          <LoadFailed title={t('routing.title')} onRetry={load} />
        </CardContent>
      </Card>
    ) : null;
  const stored = changed?.stored;
  return (
    <Card>
      <CardContent className="space-y-4 text-sm">
        <div>
          <h2 className="text-foreground text-base font-semibold">
            {t('routing.title')}
          </h2>
          <p className="text-muted-foreground">{t('routing.hint')}</p>
        </div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {t('routing.enabled')}
        </label>
        <fieldset className="space-y-1.5">
          <legend className="text-foreground mb-1">
            {t('routing.numbers')}
          </legend>
          {numbers.length === 0 && (
            <p className="text-muted-foreground">{t('routing.noNumbers')}</p>
          )}
          {numbers.map((n) => (
            <label key={n.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={ids.includes(n.id)}
                onChange={(e) =>
                  setIds((cur) =>
                    e.target.checked
                      ? [...cur, n.id]
                      : cur.filter((x) => x !== n.id)
                  )
                }
              />
              <span className="break-all">{n.label}</span>
            </label>
          ))}
        </fieldset>
        <div className="max-w-xs space-y-1.5">
          <Label htmlFor="desk-escalate">{t('routing.escalate')}</Label>
          <Input
            id="desk-escalate"
            type="number"
            min={15}
            max={1440}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </div>
        {changed && (
          <ChangedNotice
            text={[
              t('settingsChanged'),
              stored
                ? t('routing.storedNow', {
                    enabled: stored.routingEnabled ? 'yes' : 'no',
                    numbers:
                      stored.deskChannelIds
                        .map(
                          (id) => numbers.find((n) => n.id === id)?.label ?? id
                        )
                        .join(', ') || '-',
                    minutes: stored.escalateMinutes,
                  })
                : '',
            ].join(' ')}
            busy={busy}
            onReload={load}
          />
        )}
        <Button disabled={busy || changed !== null} onClick={save}>
          {t('routing.save')}
        </Button>
      </CardContent>
    </Card>
  );
}
