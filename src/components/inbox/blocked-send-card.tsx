'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  UNLOCK_POLL_MS,
  UNLOCK_REASON_MAX,
  findUnlockRow,
  reasonValid,
  ruleMessage,
  type SendRestriction,
  type UnlockCardEvent,
  type UnlockCardState,
} from '@/lib/team-activity/blocked-send';

/**
 * The composer's card for a send a team-activity rule refused
 * (204-205): the rule in words and, when the server allows it, a
 * one-time unlock request that waits for a leader's decision. The
 * states live in `unlockCardReducer` (lib); the thread keeps them per
 * chat, so this only renders one and talks to the unlock routes.
 */
export function BlockedSendCard({
  restriction,
  state,
  onEvent,
  onDismiss,
}: {
  restriction: SendRestriction;
  state: UnlockCardState;
  onEvent: (event: UnlockCardEvent) => void;
  onDismiss: () => void;
}) {
  const t = useTranslations('TeamActivity.blocked');
  const reasonId = useId();
  const [requestFailed, setRequestFailed] = useState(false);

  const requestId = state.phase === 'waiting' ? state.requestId : null;
  // The thread passes a fresh callback each render; the poll must not
  // restart (and fetch again) on every one of them.
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  // Ask whether the request was decided: now (the card may come back
  // to a chat after a while), then every UNLOCK_POLL_MS while waiting.
  useEffect(() => {
    if (!requestId) return;
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch('/api/team-activity/unlocks');
        if (!res.ok || cancelled) return;
        const row = findUnlockRow(await res.json(), requestId);
        if (!cancelled && row && row.status !== 'pending') {
          onEventRef.current({ type: 'decided', row });
        }
      } catch {
        // A missed poll is retried on the next tick.
      }
    };
    void check();
    const timer = setInterval(() => void check(), UNLOCK_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [requestId]);

  const submit = async () => {
    if (state.phase !== 'asking' || !reasonValid(state.reason)) return;
    const reason = state.reason.trim();
    setRequestFailed(false);
    onEvent({ type: 'submit' });
    try {
      const res = await fetch('/api/team-activity/unlocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blockId: restriction.blockId, reason }),
      });
      const body = (await res.json().catch(() => null)) as {
        id?: unknown;
      } | null;
      if (res.ok && typeof body?.id === 'string') {
        onEvent({ type: 'submitted', requestId: body.id });
        return;
      }
    } catch {
      // Falls through to the failure below.
    }
    setRequestFailed(true);
    onEvent({ type: 'submitFailed' });
  };

  const rule = ruleMessage(restriction);
  const sentence =
    rule.key === null ? rule.text : t(`rule.${rule.key}`, rule.values);

  return (
    <div
      role="alert"
      className="bg-warning-soft border-warning/40 border-t px-3 py-2 text-xs sm:px-4"
    >
      <div className="flex items-start gap-2">
        <ShieldAlert
          className="text-destructive mt-0.5 h-3.5 w-3.5 shrink-0"
          aria-hidden
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-destructive font-medium">{t('title')}</p>
          {sentence && <p className="text-foreground">{sentence}</p>}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onDismiss}
          aria-label={t('dismiss')}
        >
          <X />
        </Button>
      </div>

      {state.phase === 'blocked' && restriction.unlockable && (
        <div className="mt-2 ps-5">
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => onEvent({ type: 'ask' })}
          >
            {t('ask')}
          </Button>
        </div>
      )}

      {(state.phase === 'asking' || state.phase === 'submitting') && (
        <div className="bg-card-2 mt-2 ms-5 space-y-2 rounded-md p-2">
          <label htmlFor={reasonId} className="block font-medium">
            {t('reasonLabel')}
          </label>
          <Textarea
            id={reasonId}
            value={state.reason}
            maxLength={UNLOCK_REASON_MAX}
            disabled={state.phase === 'submitting'}
            onChange={(e) => onEvent({ type: 'edit', reason: e.target.value })}
            className="min-h-16 text-xs"
          />
          <p className="text-muted-foreground">{t('reasonHelp')}</p>
          {requestFailed && state.phase === 'asking' && (
            <p className="text-destructive">{t('requestFailed')}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={state.phase === 'submitting'}
              onClick={() => onEvent({ type: 'cancel' })}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={
                state.phase === 'submitting' || !reasonValid(state.reason)
              }
              onClick={() => void submit()}
            >
              {t('send')}
            </Button>
          </div>
        </div>
      )}

      {state.phase === 'waiting' && (
        <p className="text-muted-foreground mt-2 ps-5">{t('waiting')}</p>
      )}
      {state.phase === 'approved' && (
        <p className="text-success mt-2 ps-5 font-medium">{t('approved')}</p>
      )}
      {state.phase === 'denied' && (
        <p className="text-destructive mt-2 ps-5">
          {state.note ? t('deniedNote', { note: state.note }) : t('denied')}
        </p>
      )}
      {state.phase === 'expired' && (
        <p className="text-muted-foreground mt-2 ps-5">{t('expired')}</p>
      )}
    </div>
  );
}
