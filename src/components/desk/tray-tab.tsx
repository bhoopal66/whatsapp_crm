'use client';

/**
 * The case desk's Tray tab (migration 230, design 035 section 6): the
 * customer WhatsApp documents the router could not place with certainty.
 * Rules against misfiling: no case is pre-selected, the case number,
 * company and bank are always shown, a company the sender does not act
 * for needs its legal name typed, and filing needs a chosen case.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';
import { formatAge } from '@/lib/desk/intake-form';
import {
  needsCompanyConfirm,
  type DeskSettings,
  type TrayItem,
} from '@/lib/desk/tray';

import { deskApi } from './desk-api';
import { FilePreview } from './file-preview';

export function TrayTab({ isLead }: { isLead: boolean }) {
  const t = useTranslations('Desk');
  const { user } = useAuth();
  const [items, setItems] = useState<TrayItem[] | null>(null);
  const [settings, setSettings] = useState<DeskSettings | null>(null);

  const load = useCallback(
    () =>
      Promise.all([deskApi.tray(), deskApi.settings()]).then(([r, s]) => {
        if (r.ok) setItems(r.data);
        else {
          toast.error(r.error);
          setItems([]);
        }
        if (s.ok) setSettings(s.data.settings);
      }),
    []
  );
  useEffect(() => {
    void load();
  }, [load]);

  const duty = settings?.dutyUserId ?? null;
  const dutyLabel =
    duty === null
      ? t('tray.dutyNobody')
      : duty === user?.id
        ? t('tray.dutyYou')
        : t('tray.dutyOther');
  const setDuty = async (userId: string | null) => {
    const r = await deskApi.setDuty(userId);
    if (!r.ok) toast.error(r.error);
    await load();
  };
  const oldest = items?.length
    ? Math.max(...items.map((i) => i.ageSeconds))
    : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground text-sm">{t('tray.intro')}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            {items !== null && (
              <span className="text-foreground font-medium">
                {t('tray.count', { count: items.length })}
                {oldest !== null && (
                  <span className="text-muted-foreground font-normal">
                    {' · '}
                    {t('tray.oldest', { age: formatAge(oldest) })}
                  </span>
                )}
              </span>
            )}
            <span className="text-muted-foreground">
              {t('tray.duty')}: {dutyLabel}
            </span>
            {isLead && user && duty !== user.id && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDuty(user.id)}
              >
                {t('tray.takeDuty')}
              </Button>
            )}
            {isLead && duty !== null && (
              <Button size="sm" variant="ghost" onClick={() => setDuty(null)}>
                {t('tray.clearDuty')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
      {items === null && (
        <p className="text-muted-foreground text-sm">{t('loading')}</p>
      )}
      {items !== null && items.length === 0 && (
        <p className="text-muted-foreground text-sm">{t('tray.empty')}</p>
      )}
      {items?.map((item) => (
        <TrayCard key={item.trayId} item={item} onDone={load} />
      ))}
    </div>
  );
}

function TrayCard({
  item,
  onDone,
}: {
  item: TrayItem;
  onDone: () => Promise<unknown>;
}) {
  const t = useTranslations('Desk');
  // Never pre-selected (design 035): the person chooses.
  const [caseId, setCaseId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // Advice only (design 035 D12): shown as text, never selected for you.
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const picked = item.candidates.find((c) => c.caseId === caseId) ?? null;
  const suggest = async () => {
    setBusy(true);
    const r = await deskApi.suggest(item.trayId);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    const s = r.data;
    if (s.status === 'suggested') {
      const c = item.candidates.find((x) => x.caseId === s.caseId);
      setSuggestion(
        t('tray.suggestions.suggested', {
          caseNumber: c?.caseNumber ?? s.caseId,
          percent: Math.round(s.p * 100),
        })
      );
    } else setSuggestion(t(`tray.suggestions.${s.status}`));
  };
  const mustConfirm = picked ? needsCompanyConfirm(item, picked) : false;

  const file = async () => {
    if (!picked) return;
    setBusy(true);
    const r = await deskApi.trayFile(
      item.trayId,
      picked.caseId,
      mustConfirm ? confirm : null
    );
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    toast.success(
      t('tray.filed', { caseNumber: r.data.caseNumber ?? picked.caseId })
    );
    await onDone();
  };
  const dismiss = async () => {
    setBusy(true);
    const r = await deskApi.trayDismiss(item.trayId, reason);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    toast.success(t('tray.dismissed'));
    await onDone();
  };

  return (
    <Card>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-foreground font-medium break-words">
            {item.contactName ?? t('tray.unknownSender')}
          </span>
          {item.contactPhone && (
            <span className="text-muted-foreground font-mono text-xs">
              {item.contactPhone}
            </span>
          )}
          <span className="text-muted-foreground text-xs">
            {t('tray.received', { age: formatAge(item.ageSeconds) })}
          </span>
          {item.escalatedAt && (
            <Badge variant="destructive">{t('tray.escalated')}</Badge>
          )}
        </div>
        <p className="bg-warning-soft text-warning rounded-md px-2 py-1 text-xs">
          {t(`tray.reasons.${item.reason}`)}
        </p>
        {item.senderCompanies.length > 0 && (
          <p className="text-muted-foreground text-xs">
            {t('tray.actsFor', {
              companies: item.senderCompanies.map((c) => c.company).join(', '),
            })}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {item.mediaUrl && (
            <a
              href={item.mediaUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary text-sm underline underline-offset-2"
            >
              {t('tray.open')}
              {item.originalName ? ` · ${item.originalName}` : ''}
            </a>
          )}
          {item.caption && (
            <span className="text-muted-foreground min-w-0 text-xs break-words">
              “{item.caption}”
            </span>
          )}
        </div>
        <FilePreview
          target={{ type: 'tray', id: item.trayId }}
          mime={item.mime}
          name={item.originalName}
        />
        <fieldset className="space-y-2">
          <legend className="text-foreground mb-1 font-medium">
            {t('tray.candidates')}
          </legend>
          {item.candidates.length === 0 && (
            <p className="text-muted-foreground text-xs">
              {t('tray.noCandidates')}
            </p>
          )}
          {item.candidates.map((c) => (
            <label
              key={c.caseId}
              className={`flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 ${
                caseId === c.caseId ? 'border-primary bg-muted' : ''
              }`}
            >
              <input
                type="radio"
                name={`tray-${item.trayId}`}
                checked={caseId === c.caseId}
                onChange={() => {
                  setCaseId(c.caseId);
                  setConfirm('');
                }}
              />
              <span className="font-mono text-xs">{c.caseNumber}</span>
              <span className="text-foreground">{c.company}</span>
              <span className="text-muted-foreground text-xs">
                {c.bankCode}
                {c.product ? ` · ${c.product}` : ''}
              </span>
              {c.why.map((w) => (
                <Badge key={w} variant="outline">
                  {t(`tray.why.${w}`)}
                </Badge>
              ))}
            </label>
          ))}
        </fieldset>
        {item.candidates.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={suggest}
            >
              {t('tray.suggest')}
            </Button>
            {suggestion && (
              <span className="text-muted-foreground text-xs">
                {suggestion}
              </span>
            )}
          </div>
        )}
        {picked && mustConfirm && (
          <div className="space-y-1.5">
            <Label htmlFor={`confirm-${item.trayId}`}>
              {t('tray.confirmCompany', { company: picked.company })}
            </Label>
            <Input
              id={`confirm-${item.trayId}`}
              value={confirm}
              maxLength={200}
              autoComplete="off"
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <Button
            disabled={busy || !picked || (mustConfirm && !confirm.trim())}
            onClick={file}
          >
            {t('tray.file')}
          </Button>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <Input
              className="min-w-40 flex-1"
              value={reason}
              maxLength={500}
              placeholder={t('tray.dismissReason')}
              aria-label={t('tray.dismissReason')}
              onChange={(e) => setReason(e.target.value)}
            />
            <Button
              variant="outline"
              disabled={busy || reason.trim().length < 3}
              onClick={dismiss}
            >
              {t('tray.dismiss')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
