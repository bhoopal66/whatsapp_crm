'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Lock, Phone } from 'lucide-react';

import type { SharedCallCard } from '@/lib/chat';
import { sharedCallCardView } from '@/lib/chat/share';
import { OUTCOMES, formatTimer, type Outcome } from '@/lib/pbx/call-ui';

/**
 * A phone call shared into chat (103), read live from the call: its
 * details for someone who may see the call now, "no access" for anyone
 * else, and only "erased" once the call's record was erased.
 */
export function SharedCallCardBox({ card }: { card: SharedCallCard }) {
  const t = useTranslations('Chat.callCard');
  const tc = useTranslations('PbxCall');
  const locale = useLocale();
  const view = sharedCallCardView(card);

  const shell = (body: React.ReactNode) => (
    <div className="bg-card mt-1.5 max-w-[730px] overflow-hidden rounded-xl border">
      <div className="bg-muted/50 flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        <Phone className="size-3.5 text-[#0E7C5A]" aria-hidden />
        <span className="text-muted-foreground flex-1">{t('header')}</span>
        {view.access && !view.erased && view.outcome && (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-800 [[data-mode=dark]_&]:bg-emerald-500/20 [[data-mode=dark]_&]:text-emerald-200">
            {(OUTCOMES as readonly string[]).includes(view.outcome)
              ? tc(`outcomes.${view.outcome as Outcome}`)
              : view.outcome}
          </span>
        )}
      </div>
      {body}
    </div>
  );

  if (!view.access || view.erased)
    return shell(
      <p className="text-muted-foreground flex items-center gap-2 px-3 py-2.5 text-sm">
        <Lock className="size-3.5 shrink-0" aria-hidden />
        {view.access ? t('erased') : t('noAccess')}
      </p>
    );

  const who = view.who ?? t('unknownCaller');
  const when = view.startedAt
    ? new Date(view.startedAt).toLocaleString(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : null;
  return shell(
    <div className="space-y-1.5 px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        {view.contactId ? (
          <Link
            href={`/contacts/${view.contactId}`}
            className="min-w-0 flex-1 truncate font-bold hover:underline"
          >
            {who}
          </Link>
        ) : (
          <span className="min-w-0 flex-1 truncate font-bold">{who}</span>
        )}
        {view.agentName && (
          <span className="text-muted-foreground shrink-0 text-xs">
            {t('agent', { name: view.agentName })}
          </span>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {[
          tc(`directions.${view.direction}`),
          when,
          formatTimer(view.talkSeconds * 1000),
          view.outcome ? null : tc('noOutcome'),
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {view.notes && (
        <p className="line-clamp-3 text-sm break-words whitespace-pre-wrap">
          {view.notes}
        </p>
      )}
      {view.contactId && (
        <Link
          href={`/contacts/${view.contactId}`}
          className="text-primary inline-block text-xs font-semibold hover:underline"
        >
          {t('openCustomer')}
        </Link>
      )}
    </div>
  );
}
