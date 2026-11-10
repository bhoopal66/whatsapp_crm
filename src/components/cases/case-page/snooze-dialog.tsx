'use client';

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import {
  fromLocalInput,
  SNOOZE_REASON_MAX,
  snoozeErrorKey,
  toLocalInput,
} from '@/lib/cases/case-page';
import {
  isValidSnoozeUntil,
  SNOOZE_MAX_DAYS,
  snoozePresets,
  type SnoozePresetKey,
} from '@/lib/cases/views-ui';
import { cn } from '@/lib/utils';

import { sendCaseRequest } from './case-dialogs';

const DAY_MS = 86_400_000;

/** The viewer's own zone; presets land at 09:00 there. */
const viewerTimeZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * Snooze a case (185): a preset or a custom end within 30 days, and an
 * optional reason. The route and SQL decide; this only shapes the request.
 */
export function SnoozeDialog({
  open,
  onOpenChange,
  caseId,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  caseId: string;
  onChanged: () => void;
}) {
  const t = useTranslations('CaseSnooze');
  const locale = useLocale();
  // Taken once per opening: the dialog is mounted only while open.
  const [now] = useState(() => new Date());
  const presets = useMemo(() => snoozePresets(now, viewerTimeZone()), [now]);
  const [preset, setPreset] = useState<SnoozePresetKey | null>('tomorrow');
  const [custom, setCustom] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const fmt = (d: Date) =>
    new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);

  const customIso = custom ? fromLocalInput(custom) : null;
  const until: Date | null = custom
    ? customIso
      ? new Date(customIso)
      : null
    : (presets.find((p) => p.key === preset)?.until ?? null);
  const customInvalid =
    custom !== '' && (!until || !isValidSnoozeUntil(until, new Date()));
  const canSubmit =
    !busy &&
    until !== null &&
    !customInvalid &&
    reason.length <= SNOOZE_REASON_MAX;

  const submit = async () => {
    if (!until || !isValidSnoozeUntil(until, new Date())) {
      toast.error(t('errors.invalid'));
      return;
    }
    setBusy(true);
    const trimmed = reason.trim();
    const r = await sendCaseRequest(`/api/cases/${caseId}/snooze`, 'POST', {
      until: until.toISOString(),
      ...(trimmed ? { reason: trimmed } : {}),
    });
    setBusy(false);
    if (r.ok) {
      toast.success(t('done', { when: fmt(until) }));
      onOpenChange(false);
      onChanged();
      return;
    }
    const key = snoozeErrorKey(
      r.status,
      (r.json as { code?: unknown } | null)?.code
    );
    toast.error(t(`errors.${key}`));
    // A closed case or a lost permission changes what the header shows.
    if (key === 'caseClosed' || key === 'notAllowed') {
      onOpenChange(false);
      onChanged();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('body', { days: SNOOZE_MAX_DAYS })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div
            role="radiogroup"
            aria-label={t('presets')}
            className="grid gap-1.5"
          >
            {presets.map((p) => {
              const on = !custom && preset === p.key;
              return (
                <button
                  key={p.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => {
                    setPreset(p.key);
                    setCustom('');
                  }}
                  className={cn(
                    'flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors',
                    on
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'bg-card-2 hover:bg-muted text-foreground'
                  )}
                >
                  <span className="font-medium">{t(`preset.${p.key}`)}</span>
                  <span className="text-muted-foreground text-xs">
                    {fmt(p.until)}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="case-snooze-custom">{t('custom')}</Label>
            <Input
              id="case-snooze-custom"
              type="datetime-local"
              value={custom}
              min={toLocalInput(now.toISOString())}
              max={toLocalInput(
                new Date(now.getTime() + SNOOZE_MAX_DAYS * DAY_MS).toISOString()
              )}
              onChange={(e) => setCustom(e.target.value)}
              aria-invalid={customInvalid || undefined}
            />
            {customInvalid && (
              <p className="text-destructive text-xs" role="alert">
                {t('customInvalid', { days: SNOOZE_MAX_DAYS })}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="case-snooze-reason">{t('reason')}</Label>
            <Textarea
              id="case-snooze-reason"
              value={reason}
              maxLength={SNOOZE_REASON_MAX}
              rows={2}
              placeholder={t('reasonPlaceholder')}
              onChange={(e) => setReason(e.target.value)}
            />
            <p className="text-muted-foreground text-right text-xs">
              {reason.length}/{SNOOZE_REASON_MAX}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t('cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
