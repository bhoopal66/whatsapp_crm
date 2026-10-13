'use client';

// Click-to-call (module 015). Hidden for a person with no extension;
// the server rings their OWN extension first, then the customer.
// Disabled for a do-not-contact customer, except that an owner or admin
// may "Call anyway" with a reason, which the dial route logs first. A
// number with no contact (the Calls screen's unknown caller) is dialled
// as typed; the route checks it for do-not-contact across the workspace,
// and its 409 disables the button the same way.

import { useState } from 'react';
import { Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useAuth } from '@/hooks/use-auth';
import { hasMinRole } from '@/lib/auth/roles';
import {
  OVERRIDE_REASON_MAX,
  consentState,
  dialResult,
  type ConsentFields,
} from '@/lib/pbx/call-ui';
import { useCalls } from './call-provider';

export function CallButton({
  contact,
  number,
  conversationId,
  label,
  size = 'sm',
}: {
  /** The customer; a do-not-contact stamp disables the button. */
  contact?: ConsentFields & { id: string };
  /** Or a number nobody's contact holds (team leader and up may dial it). */
  number?: string;
  conversationId?: string;
  /** In place of "Call", e.g. "Call back" on a missed call. */
  label?: string;
  size?: 'sm' | 'xs';
}) {
  const calls = useCalls();
  const { accountRole } = useAuth();
  const t = useTranslations('PbxCall');
  const [refused, setRefused] = useState<{ reason: string | null } | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  if (!calls?.me || (!contact && !number)) return null;

  const consent = consentState(contact ?? {});
  const dnc = !consent.callsOk || refused !== null;
  const dncReason = refused?.reason ?? consent.dncReason;
  const admin = accountRole ? hasMinRole(accountRole, 'admin') : false;

  const dial = async (overrideReason?: string) => {
    setBusy(true);
    try {
      const res = await fetch('/api/pbx/calls/dial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(conversationId
            ? { conversationId }
            : contact
              ? { contactId: contact.id }
              : { number }),
          ...(overrideReason ? { overrideReason } : {}),
        }),
      });
      const r = dialResult(res.status, await res.json().catch(() => null));
      if (r.kind === 'ok') {
        toast.success(t('ringsFirst'));
        setAsking(false);
      } else if (r.kind === 'do_not_contact') {
        setRefused({ reason: r.reason });
        toast.error(t('dncTooltip', { reason: r.reason ?? t('dncNoReason') }));
      } else if (r.kind === 'no_extension') toast.error(t('noExtension'));
      else toast.error(r.message ?? t('dialFailed'));
    } catch {
      toast.error(t('dialFailed'));
    } finally {
      setBusy(false);
    }
  };

  const green =
    'bg-emerald-600 text-white hover:bg-emerald-500 disabled:bg-emerald-600/50';
  const icon = size === 'xs' ? 'size-3' : 'size-4';
  const text = label ?? t('call');
  if (!dnc)
    return (
      <Button
        size={size}
        className={green}
        disabled={busy}
        onClick={() => void dial()}
      >
        <Phone className={icon} />
        {text}
      </Button>
    );

  return (
    <span className="inline-flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger render={<span tabIndex={0} />}>
          <Button size={size} className={green} disabled>
            <Phone className={icon} />
            {text}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {t('dncTooltip', { reason: dncReason ?? t('dncNoReason') })}
        </TooltipContent>
      </Tooltip>
      {admin && (
        <Button size={size} variant="outline" onClick={() => setAsking(true)}>
          {t('callAnyway')}
        </Button>
      )}
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('callAnyway')}</DialogTitle>
            <DialogDescription>{t('callAnywayDesc')}</DialogDescription>
          </DialogHeader>
          <textarea
            value={reason}
            maxLength={OVERRIDE_REASON_MAX}
            onChange={(e) => setReason(e.target.value)}
            aria-label={t('reason')}
            placeholder={t('reason')}
            className="border-input bg-background min-h-20 w-full rounded-lg border p-2 text-sm"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsking(false)}>
              {t('cancel')}
            </Button>
            <Button
              className={green}
              disabled={busy || !reason.trim()}
              onClick={() => void dial(reason.trim())}
            >
              <Phone className="size-4" />
              {t('call')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </span>
  );
}
