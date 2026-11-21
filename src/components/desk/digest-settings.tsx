'use client';

/**
 * The desk reminder digest settings (migration 234), owners and admins:
 * off by default; an approved utility template; send hour and gap.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { deskApi, type DigestSettings as Settings } from './desk-api';

export function DigestSettings() {
  const t = useTranslations('Desk');
  const [s, setS] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void deskApi.digest().then((r) => {
      if (!live) return;
      if (r.ok) setS(r.data);
      else toast.error(r.error);
    });
    return () => {
      live = false;
    };
  }, []);
  if (!s) return null;
  const save = async () => {
    setBusy(true);
    const r = await deskApi.saveDigest(s);
    setBusy(false);
    if (r.ok) toast.success(t('digest.saved'));
    else toast.error(r.error);
  };
  return (
    <Card>
      <CardContent className="space-y-4 pt-6 text-sm">
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
        <Button disabled={busy} onClick={save}>
          {t('digest.save')}
        </Button>
      </CardContent>
    </Card>
  );
}
