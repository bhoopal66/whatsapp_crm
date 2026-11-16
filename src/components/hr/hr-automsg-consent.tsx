'use client';

/**
 * "Automated messages" in the HR panel of a Recruiter chat (migration
 * 203): the chat's consent record and, for admins and the recruiter
 * team, Record / Withdraw. `lib/hr/automsg/consent-view.ts` decides what
 * to show; the RPCs re-check the caller.
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
  type AutoMsgConsentView,
  type ConsentSource,
} from '@/lib/hr/automsg/api';
import {
  CONSENT_SOURCES,
  consentPanel,
  consentSourceKey,
} from '@/lib/hr/automsg/consent-view';
import { decideErrorKey } from '@/lib/hr/agents/panel';

export function HrAutomsgConsent({
  conversationId,
  canAct,
}: {
  conversationId: string;
  canAct: boolean;
}) {
  const t = useTranslations('Hr');
  const [consent, setConsent] = useState<AutoMsgConsentView | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<ConsentSource>('recruiter_confirmed');
  // HrPanel is mounted keyed by the chat, so a switch starts empty; a
  // late answer for the chat left is still dropped.
  const current = useRef(conversationId);

  const load = useCallback(
    (id: string) =>
      automsgConsent(createClient(), id).then((res) => {
        if (current.current !== id) return;
        if ('error' in res) {
          setFailed(true);
          return;
        }
        setFailed(false);
        setConsent(res.data);
      }),
    []
  );

  useEffect(() => {
    current.current = conversationId;
    void load(conversationId);
  }, [conversationId, load]);

  async function save(granted: boolean) {
    const id = conversationId;
    setBusy(true);
    const res = await automsgSetConsent(createClient(), id, granted, source);
    setBusy(false);
    if ('error' in res) {
      toast.error(t(decideErrorKey(res.error)));
    } else {
      toast.success(t(granted ? 'consent.recorded' : 'consent.withdrawnToast'));
      if (current.current === id) setConsent(res.data);
    }
    await load(id);
  }

  const view = consent ? consentPanel(consent, canAct) : null;
  const state = view?.state;

  return (
    <fieldset className="border-input space-y-1.5 rounded-md border px-3 pt-1 pb-2.5">
      <legend className="text-muted-foreground px-1 text-xs font-medium">
        {t('consent.title')}
      </legend>
      {!view || !state ? (
        failed ? (
          <p className="text-muted-foreground text-xs">
            {t('consent.loadFailed')}
          </p>
        ) : (
          <Loader2
            className="text-muted-foreground size-3.5 animate-spin"
            aria-hidden
          />
        )
      ) : (
        <>
          <p className="text-xs">
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
          {view.canRecord && (
            <div className="flex flex-wrap items-center gap-1">
              <select
                aria-label={t('consent.sourceLabel')}
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
                disabled={busy}
                onClick={() => void save(true)}
              >
                {busy && <Loader2 className="animate-spin" aria-hidden />}
                {t('consent.record')}
              </Button>
            </div>
          )}
          {view.canWithdraw && (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void save(false)}
            >
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              {t('consent.withdraw')}
            </Button>
          )}
        </>
      )}
    </fieldset>
  );
}
