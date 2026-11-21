'use client';

/**
 * Desk WhatsApp routing settings (migration 230), owners and admins:
 * the switch (off by default), the desk numbers and the escalation delay.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { deskApi } from './desk-api';

export function RoutingSettings() {
  const t = useTranslations('Desk');
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [minutes, setMinutes] = useState('120');
  const [numbers, setNumbers] = useState<{ id: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void deskApi.settings().then((r) => {
      if (!live) return;
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setEnabled(r.data.settings.routingEnabled);
      setIds(r.data.settings.deskChannelIds);
      setMinutes(String(r.data.settings.escalateMinutes));
      setNumbers(r.data.numbers);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const save = async () => {
    setBusy(true);
    const r = await deskApi.saveSettings({
      routingEnabled: enabled,
      deskChannelIds: ids,
      escalateMinutes: Number(minutes),
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    toast.success(t('routing.saved'));
  };

  if (!loaded) return null;
  return (
    <Card>
      <CardContent className="space-y-4 pt-6 text-sm">
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
        <Button disabled={busy} onClick={save}>
          {t('routing.save')}
        </Button>
      </CardContent>
    </Card>
  );
}
