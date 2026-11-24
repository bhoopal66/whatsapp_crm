'use client';

/**
 * The desk reminder digest settings (migration 234), owners and admins:
 * off by default; an approved utility template; send hour and gap. Saved
 * against the version loaded (316): over another admin's save the card
 * shows what is stored and keeps what was typed until Reload.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { ChangedNotice } from '@/components/settings/case-files-settings';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { deskApi, type DigestSettings as Settings } from './desk-api';
import { LoadFailed } from './load-failed';

export function DigestSettings() {
  const t = useTranslations('Desk');
  const [s, setS] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [changed, setChanged] = useState<{ stored: Settings | null } | null>(
    null
  );
  const load = useCallback(
    () =>
      deskApi.digest().then((r) => {
        setFailed(!r.ok);
        if (!r.ok) {
          toast.error(r.error);
          return;
        }
        setS(r.data);
        setChanged(null);
      }),
    []
  );
  useEffect(() => {
    void load();
  }, [load]);
  if (!s)
    return failed ? (
      <Card>
        <CardContent>
          <LoadFailed title={t('digest.title')} onRetry={load} />
        </CardContent>
      </Card>
    ) : null;
  const save = async () => {
    setBusy(true);
    const r = await deskApi.saveDigest(s);
    if (r.ok) {
      toast.success(t('digest.saved'));
      setS((cur) => cur && { ...cur, updatedAt: r.data });
    } else if (r.code === 'SETTINGS_CHANGED') {
      const now = await deskApi.digest();
      setChanged({ stored: now.ok ? now.data : null });
    } else toast.error(r.error);
    setBusy(false);
  };
  const stored = changed?.stored;
  return (
    <Card>
      <CardContent className="space-y-4 text-sm">
        <div>
          <h2 className="text-foreground text-base font-semibold">
            {t('digest.title')}
          </h2>
          <p className="text-muted-foreground">
            {t('digest.hint', { one: '{{1}}', two: '{{2}}' })}
          </p>
        </div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={s.enabled}
            onChange={(e) => setS({ ...s, enabled: e.target.checked })}
          />
          {t('digest.enabled')}
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="desk-digest-template">{t('digest.template')}</Label>
            <Input
              id="desk-digest-template"
              value={s.templateName ?? ''}
              maxLength={200}
              onChange={(e) =>
                setS({ ...s, templateName: e.target.value || null })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="desk-digest-language">{t('digest.language')}</Label>
            <Input
              id="desk-digest-language"
              value={s.language}
              maxLength={5}
              onChange={(e) => setS({ ...s, language: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="desk-digest-hour">{t('digest.sendHour')}</Label>
            <Input
              id="desk-digest-hour"
              type="number"
              min={8}
              max={20}
              value={s.sendHour}
              onChange={(e) => setS({ ...s, sendHour: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="desk-digest-gap">{t('digest.gapDays')}</Label>
            <Input
              id="desk-digest-gap"
              type="number"
              min={1}
              max={14}
              value={s.gapDays}
              onChange={(e) => setS({ ...s, gapDays: Number(e.target.value) })}
            />
          </div>
        </div>
        {changed && (
          <ChangedNotice
            text={[
              t('settingsChanged'),
              stored
                ? t('digest.storedNow', {
                    enabled: stored.enabled ? 'yes' : 'no',
                    template: stored.templateName ?? '-',
                    language: stored.language,
                    hour: stored.sendHour,
                    days: stored.gapDays,
                  })
                : '',
            ].join(' ')}
            busy={busy}
            onReload={load}
          />
        )}
        <Button disabled={busy || changed !== null} onClick={save}>
          {t('digest.save')}
        </Button>
      </CardContent>
    </Card>
  );
}
