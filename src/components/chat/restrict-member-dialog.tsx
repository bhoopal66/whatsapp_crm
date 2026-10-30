'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import {
  MODERATION_REASON_MAX,
  moderationReasonValid,
  reasonLength,
  RESTRICT_DURATION_KEYS,
  type RestrictDuration,
} from '@/lib/chat/moderation';
import { cn } from '@/lib/utils';

/** Message keys for the durations (a key may not start with a digit). */
const DURATION_KEY: Record<RestrictDuration, string> = {
  '1h': 'members.restrictFor.h1',
  '8h': 'members.restrictFor.h8',
  '1d': 'members.restrictFor.d1',
  '3d': 'members.restrictFor.d3',
  '7d': 'members.restrictFor.d7',
  '30d': 'members.restrictFor.d30',
};

/**
 * A posting timeout (160): a duration and a reason of 5–500 characters,
 * which the database requires and logs. Restrict stays disabled until
 * the reason fits; the end time is worked out when it is pressed.
 */
export function RestrictMemberDialog({
  name,
  open,
  onOpenChange,
  onRestrict,
}: {
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestrict: (duration: RestrictDuration, reason: string) => void;
}) {
  const t = useTranslations('Chat');
  const [duration, setDuration] = useState<RestrictDuration>('1d');
  const [reason, setReason] = useState('');
  const valid = moderationReasonValid(reason);
  const close = (next: boolean) => {
    if (!next) {
      setReason('');
      setDuration('1d');
    }
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('members.restrictTitle', { name })}</DialogTitle>
          <DialogDescription>{t('members.restrictBody')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <p className="text-sm font-medium" id="chat-restrict-duration">
            {t('members.restrictDuration')}
          </p>
          <div
            role="radiogroup"
            aria-labelledby="chat-restrict-duration"
            className="flex flex-wrap gap-1.5"
          >
            {RESTRICT_DURATION_KEYS.map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={duration === d}
                onClick={() => setDuration(d)}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-sm',
                  duration === d
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'hover:bg-muted'
                )}
              >
                {t(DURATION_KEY[d])}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1">
          <label htmlFor="chat-restrict-reason" className="text-sm font-medium">
            {t('moderation.reasonLabel')}
          </label>
          <Textarea
            id="chat-restrict-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('members.restrictReasonPlaceholder')}
            rows={3}
          />
          <p
            className={cn(
              'text-xs',
              reasonLength(reason) > MODERATION_REASON_MAX
                ? 'text-destructive'
                : 'text-muted-foreground'
            )}
          >
            {t('moderation.reasonCount', {
              count: reasonLength(reason),
              max: MODERATION_REASON_MAX,
            })}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => close(false)}>
            {t('members.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!valid}
            onClick={() => {
              const r = reason.trim();
              const d = duration;
              close(false);
              onRestrict(d, r);
            }}
          >
            {t('members.restrictConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
