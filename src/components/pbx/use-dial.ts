'use client';

// The one way the app places a call (module 015): POST
// /api/pbx/calls/dial, which enforces do-not-contact and rings the
// caller's own extension first (the browser softphone when it is on,
// else the desk phone), then the callee. Never softphone.call(): that
// would skip the route's checks. CallButton, the Calls screen's keypad
// and directory, and the team-chat DM button all dial through here.

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  dialBody,
  dialResult,
  type DialResult,
  type DialTarget,
  type ParticipantBlockCode,
} from '@/lib/pbx/call-ui';

export const BLOCK_KEYS: Record<ParticipantBlockCode, string> = {
  bank_guests_off: 'bankGuestsOff',
  not_callable: 'notCallable',
  room_closed: 'roomClosed',
  no_number: 'noNumber',
  bank_calls_recorded: 'bankCallsRecorded',
};

export interface DialOptions {
  /** An owner's or admin's logged reason to call a do-not-contact. */
  overrideReason?: string;
  /** In place of "Your phone rings first, then the customer". */
  success?: string;
}

/**
 * `dial(target, opts)` posts the call and toasts the answer. It resolves
 * to the route's answer (null when the request itself failed), so a
 * caller can disable itself on a do-not-contact or a block.
 */
export function useDial(): {
  busy: boolean;
  dial: (target: DialTarget, opts?: DialOptions) => Promise<DialResult | null>;
} {
  const t = useTranslations('PbxCall');
  const [busy, setBusy] = useState(false);
  const dial = useCallback(
    async (
      target: DialTarget,
      opts: DialOptions = {}
    ): Promise<DialResult | null> => {
      setBusy(true);
      try {
        const res = await fetch('/api/pbx/calls/dial', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dialBody(target, opts.overrideReason)),
        });
        const r = dialResult(res.status, await res.json().catch(() => null));
        if (r.kind === 'ok') toast.success(opts.success ?? t('ringsFirst'));
        else if (r.kind === 'do_not_contact')
          toast.error(
            t('dncTooltip', { reason: r.reason ?? t('dncNoReason') })
          );
        else if (r.kind === 'blocked') toast.error(t(BLOCK_KEYS[r.code]));
        else if (r.kind === 'no_extension') toast.error(t('noExtension'));
        else toast.error(r.message ?? t('dialFailed'));
        return r;
      } catch {
        toast.error(t('dialFailed'));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [t]
  );
  return { busy, dial };
}
