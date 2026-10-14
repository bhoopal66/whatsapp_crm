'use client';

// "My status" in the Calls screen's header: the status a person sets on
// their own extension, as Linkus offered it (PUT /api/pbx/me/presence).
// It starts from /api/pbx/me's `presence` and follows the live phone
// row of the caller's own extension, so a change on the desk phone shows
// here too (shownStatus, lib/pbx/my-status.ts). A pick shows at once and
// rolls back, with a toast, if the PBX refuses it.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useCalls } from '@/components/pbx/call-provider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/hooks/use-auth';
import { usePhonePresence } from '@/hooks/use-phone-presence';
import {
  MY_STATUSES,
  MY_STATUS_KEY,
  isMyStatus,
  shownStatus,
  type HeldStatus,
  type MyStatus as Status,
} from '@/lib/pbx/my-status';

export function MyStatus() {
  const me = useCalls()?.me ?? null;
  // Keyed by the extension: another workspace's extension starts afresh.
  return me ? (
    <MyStatusSelect
      key={`${me.connectionId}:${me.extension}`}
      extension={me.extension}
      initial={isMyStatus(me.presence) ? me.presence : null}
    />
  ) : null;
}

function MyStatusSelect({
  extension,
  initial,
}: {
  extension: string;
  initial: Status | null;
}) {
  const t = useTranslations('CallsPage.status');
  const { user } = useAuth();
  const phone = usePhonePresence();
  const mine = user ? phone[user.id.toLowerCase()] : undefined;
  const view = mine?.extension === extension ? mine.state : undefined;
  const [held, setHeld] = useState<HeldStatus>({
    status: initial,
    viewAt: undefined,
  });
  const [busy, setBusy] = useState(false);
  const status = shownStatus(held, view);

  const choose = async (next: Status) => {
    if (busy || next === status) return;
    const before = held;
    setHeld({ status: next, viewAt: view });
    setBusy(true);
    try {
      const r = await fetch('/api/pbx/me/presence', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as {
          code?: string;
        } | null;
        throw new Error(body?.code ?? String(r.status));
      }
      toast.success(t('saved', { status: t(MY_STATUS_KEY[next]) }));
    } catch (err) {
      setHeld(before);
      toast.error(
        err instanceof Error && err.message === 'extension_not_on_pbx'
          ? t('notOnPbx')
          : t('failed')
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Select
      value={status ?? ''}
      onValueChange={(v) => {
        if (isMyStatus(v)) void choose(v);
      }}
      disabled={busy}
    >
      <SelectTrigger className="w-44" aria-label={t('label')}>
        <SelectValue>
          {status ? t(MY_STATUS_KEY[status]) : t('unknown')}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {MY_STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            {t(MY_STATUS_KEY[s])}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
