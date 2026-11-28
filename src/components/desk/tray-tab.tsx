'use client';

/**
 * The case desk's Tray tab (migration 230, design 035 section 6): the
 * customer WhatsApp documents the router could not place with certainty.
 * Rules against misfiling: no case is pre-selected, the case number,
 * company and bank are always shown, a company the sender does not act
 * for needs its legal name typed, and filing needs a chosen case.
 */
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';
import { formatFileSize } from '@/lib/case-files/view';
import { mergeCandidates } from '@/lib/desk/case-search';
import { trayDismissBlock, trayFileBlock } from '@/lib/desk/form-hints';
import { formatAge } from '@/lib/desk/intake-form';
import {
  needsCompanyConfirm,
  TRAY_PAGE,
  TRAY_PAGE_MAX,
  type DeskSettings,
  type TrayCandidate,
  type TrayItem,
} from '@/lib/desk/tray';

import { deskApi } from './desk-api';
import { FilePreview } from './file-preview';
import { DisabledHint } from './disabled-hint';
import { LoadFailed } from './load-failed';
import { TrayCaseFinder } from './tray-case-finder';
import { chatMediaDisplayUrl } from '@/lib/storage/chat-media-url';

export function TrayTab({ isLead }: { isLead: boolean }) {
  const t = useTranslations('Desk');
  const locale = useLocale();
  const { user } = useAuth();
  const [items, setItems] = useState<TrayItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(TRAY_PAGE);
  const [settings, setSettings] = useState<DeskSettings | null>(null);
  // A failed read keeps what is on screen (the picked case, the typed
  // confirmation) and offers Retry; it never reads as an empty tray.
  const [trayFailed, setTrayFailed] = useState(false);
  const [settingsFailed, setSettingsFailed] = useState(false);

  const load = useCallback(
    () =>
      Promise.all([deskApi.tray('open', limit), deskApi.settings()]).then(
        ([r, s]) => {
          if (r.ok) {
            setItems(r.data.items);
            setTotal(r.data.total);
            setTrayFailed(false);
          } else {
            toast.error(r.error);
            setTrayFailed(true);
          }
          if (s.ok) {
            setSettings(s.data.settings);
            setSettingsFailed(false);
          } else setSettingsFailed(true);
        }
      ),
    [limit]
  );
  useEffect(() => {
    void load();
  }, [load]);

  const duty = settings?.dutyUserId ?? null;
  const dutyLabel =
    settings === null
      ? null
      : duty === null
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
                {t('tray.count', { count: Math.max(total, items.length) })}
                {oldest !== null && (
                  <span className="text-muted-foreground font-normal">
                    {' · '}
                    {t('tray.oldest', { age: formatAge(oldest, locale) })}
                  </span>
                )}
              </span>
            )}
            {settings !== null && (
              <span className="text-muted-foreground">
                {t('tray.duty')}: {dutyLabel}
              </span>
            )}
            {settings === null && settingsFailed && (
              <LoadFailed title={t('tray.duty')} onRetry={load} />
            )}
            {settings !== null && isLead && user && duty !== user.id && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDuty(user.id)}
              >
                {t('tray.takeDuty')}
              </Button>
            )}
            {settings !== null && isLead && duty !== null && (
              <Button size="sm" variant="ghost" onClick={() => setDuty(null)}>
                {t('tray.clearDuty')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
      {trayFailed && <LoadFailed onRetry={load} />}
      {items === null && !trayFailed && (
        <p className="text-muted-foreground text-sm">{t('loading')}</p>
      )}
      {items !== null && items.length === 0 && !trayFailed && (
        <p className="text-muted-foreground text-sm">{t('tray.empty')}</p>
      )}
      {items?.map((item) => (
        <TrayCard key={item.trayId} item={item} onDone={load} />
      ))}
      {items !== null && total > items.length && (
        <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-sm">
          <span>{t('tray.shown', { shown: items.length, total })}</span>
          {limit < TRAY_PAGE_MAX && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setLimit(limit + TRAY_PAGE)}
            >
              {t('tray.loadMore')}
            </Button>
          )}
        </div>
      )}
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
  const tf = useTranslations('DeskForms');
  const locale = useLocale();
  // Never pre-selected (design 035): the person chooses.
  const [caseId, setCaseId] = useState<string | null>(null);
  // Cases the person found with "Find case", listed after the item's own.
  const [foundCases, setFoundCases] = useState<TrayCandidate[]>([]);
  const candidates = mergeCandidates(item.candidates, foundCases);
  const [confirm, setConfirm] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // Advice only (design 035 D12): shown as text, never selected for you.
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const picked = candidates.find((c) => c.caseId === caseId) ?? null;
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
  const fileBlocked = trayFileBlock({
    picked: picked !== null,
    mustConfirm,
    confirm,
  });
  const dismissBlocked = trayDismissBlock(reason);

  const file = async () => {
    if (!picked) return;
    setBusy(true);
    // Busy until the list has been read again, so a finished item cannot
    // be filed or dismissed a second time meanwhile.
    try {
      const r = await deskApi.trayFile(
        item.trayId,
        picked.caseId,
        mustConfirm ? confirm : null
      );
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const filedOn = r.data.caseNumber;
      if (r.data.waiting) toast.info(t('tray.waiting'));
      else if (filedOn === null) toast.info(t('tray.filedAlready'));
      else if (filedOn === picked.caseNumber)
        toast.success(t('tray.filed', { caseNumber: filedOn }));
      else toast.info(t('tray.filedElsewhere', { caseNumber: filedOn }));
      await onDone();
    } finally {
      setBusy(false);
    }
  };
  const dismiss = async () => {
    setBusy(true);
    try {
      const r = await deskApi.trayDismiss(item.trayId, reason);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t('tray.dismissed'));
      await onDone();
    } finally {
      setBusy(false);
    }
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
              <span dir="ltr">{item.contactPhone}</span>
            </span>
          )}
          <span className="text-muted-foreground text-xs">
            {t('tray.received', { age: formatAge(item.ageSeconds, locale) })}
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
              href={chatMediaDisplayUrl(item.mediaUrl)}
              target="_blank"
              rel="noreferrer"
              className="text-primary text-sm underline underline-offset-2"
            >
              {t('tray.open')}
              {item.originalName ? ` · ${item.originalName}` : ''}
            </a>
          )}
          {item.reason === 'copy_failed' && (
            <span className="text-muted-foreground text-xs" dir="ltr">
              {[item.mime, formatFileSize(item.sizeBytes)]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
          {item.reason === 'copy_failed' && item.conversationId && (
            <Link
              href={`/inbox?c=${encodeURIComponent(item.conversationId)}`}
              className="text-primary text-sm underline underline-offset-2"
            >
              {t('tray.openChat')}
            </Link>
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
          {candidates.length === 0 && (
            <p className="text-muted-foreground text-xs">
              {t('tray.noCandidates')}
            </p>
          )}
          {candidates.map((c) => (
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
              {c.why.length === 0 && (
                <Badge variant="outline">{tf('find.badge')}</Badge>
              )}
            </label>
          ))}
        </fieldset>
        <TrayCaseFinder
          trayId={item.trayId}
          onFound={(f) => setFoundCases((prev) => mergeCandidates(prev, f))}
        />
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
            disabled={busy || fileBlocked !== null}
            aria-describedby={
              fileBlocked ? `tray-file-why-${item.trayId}` : undefined
            }
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
              disabled={busy || dismissBlocked !== null}
              aria-describedby={
                dismissBlocked ? `tray-dismiss-why-${item.trayId}` : undefined
              }
              onClick={dismiss}
            >
              {t('tray.dismiss')}
            </Button>
          </div>
        </div>
        {fileBlocked && (
          <DisabledHint id={`tray-file-why-${item.trayId}`}>
            {tf(`why.tray.${fileBlocked}`)}
          </DisabledHint>
        )}
        {dismissBlocked && (
          <DisabledHint id={`tray-dismiss-why-${item.trayId}`}>
            {tf('why.tray.dismiss')}
          </DisabledHint>
        )}
      </CardContent>
    </Card>
  );
}
