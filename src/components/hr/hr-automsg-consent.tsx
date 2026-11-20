'use client';

/**
 * "Automated messages" in the HR panel of a Recruiter chat (migration
 * 203): the chat's consent record per channel (WhatsApp, RCS: consent is
 * kept per channel) and, for admins and the recruiter team, Record /
 * Withdraw on each. `lib/hr/automsg/consent-view.ts` decides what to
 * show; the RPCs re-check the caller.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { format } from 'date-fns';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/client';
import {
  automsgConsent,
  automsgSetConsent,
  type ConsentSource,
} from '@/lib/hr/automsg/api';
import {
  AUTOMSG_CHANNELS,
  type AutomsgChannel,
} from '@/lib/hr/automsg/channel';
import {
  CONSENT_SOURCES,
  consentRows,
  consentSourceKey,
  sharedNotice,
  type ConsentRead,
  type ConsentRow,
} from '@/lib/hr/automsg/consent-view';
import { decideErrorKey } from '@/lib/hr/agents/panel';

type Reads = Partial<Record<AutomsgChannel, ConsentRead>>;

export function HrAutomsgConsent({
  conversationId,
  canAct,
}: {
  conversationId: string;
  canAct: boolean;
}) {
  const t = useTranslations('Hr');
  const [reads, setReads] = useState<Reads>({});
  const [busy, setBusy] = useState<AutomsgChannel | null>(null);
  // HrPanel is mounted keyed by the chat, so a switch starts empty; a
  // late answer for the chat left is still dropped.
  const current = useRef(conversationId);

  const loadOne = useCallback(
    (id: string, channel: AutomsgChannel) =>
      automsgConsent(createClient(), id, channel).then((res) => {
        if (current.current !== id) return;
        const read: ConsentRead =
          'error' in res
            ? { status: 'failed' }
            : { status: 'ok', consent: res.data };
        setReads((prev) => ({ ...prev, [channel]: read }));
      }),
    []
  );

  useEffect(() => {
    current.current = conversationId;
    // Both reads in parallel; each settles its own row.
    for (const channel of AUTOMSG_CHANNELS)
      void loadOne(conversationId, channel);
  }, [conversationId, loadOne]);

  async function save(
    channel: AutomsgChannel,
    granted: boolean,
    source: ConsentSource
  ) {
    const id = conversationId;
    setBusy(channel);
    const res = await automsgSetConsent(
      createClient(),
      id,
      granted,
      source,
      channel
    );
    setBusy(null);
    if ('error' in res) {
      toast.error(t(decideErrorKey(res.error)));
    } else {
      toast.success(t(granted ? 'consent.recorded' : 'consent.withdrawnToast'));
      if (current.current === id)
        setReads((prev) => ({
          ...prev,
          [channel]: { status: 'ok', consent: res.data },
        }));
    }
    // Opt-out and a personal chat hold every row, so re-read both.
    await Promise.all(AUTOMSG_CHANNELS.map((c) => loadOne(id, c)));
  }

  const rows = consentRows(reads, canAct);
  const notice = sharedNotice(rows);

  return (
    <fieldset className="border-input space-y-1.5 rounded-md border px-3 pt-1 pb-2.5">
      <legend className="text-muted-foreground px-1 text-xs font-medium">
        {t('consent.title')}
      </legend>
      {notice ? (
        <p className="text-xs">
          {t(notice === 'personal' ? 'consent.personal' : 'consent.optedOut')}
        </p>
      ) : (
        <>
          {rows.map((row) => (
            <ChannelRow
              key={row.channel}
              row={row}
              busy={busy === row.channel}
              disabled={busy !== null}
              onSave={(granted, source) =>
                void save(row.channel, granted, source)
              }
            />
          ))}
          <p className="text-muted-foreground text-[11px]">
            {t('consent.perChannel')}
          </p>
        </>
      )}
    </fieldset>
  );
}

function ChannelRow({
  row,
  busy,
  disabled,
  onSave,
}: {
  row: ConsentRow;
  busy: boolean;
  disabled: boolean;
  onSave: (granted: boolean, source: ConsentSource) => void;
}) {
  const t = useTranslations('Hr');
  const [source, setSource] = useState<ConsentSource>('recruiter_confirmed');
  const label = t(row.labelKey);

  if (row.status !== 'ok') {
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <span className="font-medium">{label}</span>
        {row.status === 'failed' ? (
          <span className="text-muted-foreground">
            {t('consent.loadFailed')}
          </span>
        ) : (
          <Loader2
            className="text-muted-foreground size-3.5 animate-spin"
            aria-hidden
          />
        )}
      </div>
    );
  }

  const { state } = row;
  return (
    <div className="space-y-1">
      <p className="text-xs">
        <span className="font-medium">{label}</span>
        {' · '}
        {state.kind === 'personal'
          ? t('consent.personal')
          : state.kind === 'optedOut'
            ? t('consent.optedOut')
            : state.kind === 'given'
              ? t('consent.given')
              : state.kind === 'withdrawn'
                ? t('consent.withdrawn')
                : t('consent.none')}
      </p>
      {state.kind === 'given' && (state.source || state.notedAt) && (
        <p className="text-muted-foreground text-[11px]">
          {[
            state.source ? t(consentSourceKey(state.source)) : null,
            state.notedAt ? format(new Date(state.notedAt), 'PP') : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {row.canRecord && (
        <div className="flex flex-wrap items-center gap-1">
          <select
            aria-label={t('consent.sourceLabelFor', { channel: label })}
            className="border-input bg-card dark:bg-input/30 h-6 rounded-md border px-1.5 text-xs"
            value={source}
            onChange={(e) => setSource(e.target.value as ConsentSource)}
          >
            {CONSENT_SOURCES.map((s) => (
              <option key={s} value={s}>
                {t(consentSourceKey(s))}
              </option>
            ))}
          </select>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => onSave(true, source)}
          >
            {busy && <Loader2 className="animate-spin" aria-hidden />}
            {t('consent.record')}
          </Button>
        </div>
      )}
      {row.canWithdraw && (
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => onSave(false, 'recruiter_confirmed')}
        >
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          {t('consent.withdraw')}
        </Button>
      )}
    </div>
  );
}
