'use client';

/**
 * What the desk knows about the case number being typed: a hint while it
 * is incomplete, then the case's customer and bank (and product, stage)
 * once found, so the person sees where an upload will go before sending
 * it. Icon and words, never colour alone.
 */
import { CircleAlert, CircleCheck, Info, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useStageLabel } from '@/hooks/use-stage-label';
import type { DeskBank } from '@/lib/desk/store';

import type { CaseLookupState } from './use-case-lookup';

export function CaseRefStatus({
  lookup,
  banks,
}: {
  lookup: CaseLookupState;
  banks: readonly DeskBank[];
}) {
  const t = useTranslations('DeskForms');
  const showStage = useStageLabel();
  if (lookup.status === 'idle') return null;

  if (lookup.status === 'typing') {
    const k = lookup.ref.kind;
    if (k === 'incomplete')
      return <Note icon="info" text={t('lookup.keepTyping')} />;
    if (k === 'bad_check')
      return <Note icon="warn" text={t('lookup.badCheck')} />;
    return <Note icon="warn" text={t('lookup.invalid')} />;
  }
  if (lookup.status === 'loading')
    return <Note icon="busy" text={t('lookup.looking')} />;
  if (lookup.status === 'not_found')
    return <Note icon="warn" text={t('lookup.notFound')} />;
  if (lookup.status === 'unavailable')
    return <Note icon="info" text={t('lookup.unavailable')} />;
  if (lookup.status === 'error')
    return <Note icon="warn" text={t('lookup.error')} />;

  const c = lookup.found;
  const bank =
    c.bankCode === null
      ? '—'
      : (banks.find((b) => b.bankCode === c.bankCode)?.bankName ?? c.bankCode);
  return (
    <div
      className="bg-card-2 space-y-1 rounded-md p-3 text-sm"
      role="status"
      aria-live="polite"
    >
      <div className="text-success flex items-center gap-1.5 text-xs font-medium">
        <CircleCheck aria-hidden className="size-4" />
        {t('lookup.found')}
      </div>
      <div className="font-mono font-semibold">
        {c.caseNumber ?? c.caseId.slice(0, 8)}
      </div>
      <dl className="text-muted-foreground grid grid-cols-1 gap-x-4 sm:grid-cols-2">
        <Row label={t('lookup.customer')} value={c.companyName ?? '—'} />
        <Row label={t('lookup.bank')} value={bank} />
        {c.product && <Row label={t('lookup.product')} value={c.product} />}
        <Row label={t('lookup.stage')} value={showStage(c.stage)} />
      </dl>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1">
      <dt>{label}:</dt>
      <dd className="text-foreground break-words">{value}</dd>
    </div>
  );
}

function Note({
  icon,
  text,
}: {
  icon: 'info' | 'warn' | 'busy';
  text: string;
}) {
  const Icon = icon === 'busy' ? Loader2 : icon === 'warn' ? CircleAlert : Info;
  return (
    <p
      role="status"
      className={`flex items-start gap-1.5 text-xs ${
        icon === 'warn' ? 'text-warning' : 'text-muted-foreground'
      }`}
    >
      <Icon
        aria-hidden
        className={`mt-0.5 size-3.5 shrink-0 ${icon === 'busy' ? 'animate-spin' : ''}`}
      />
      {text}
    </p>
  );
}
