'use client';

import { CircleAlert, CircleCheck, CircleHelp, Smartphone } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { AccountNumber } from '@/hooks/use-whatsapp-numbers';
import {
  numberHealth,
  numberName,
  type NumberState,
} from '@/lib/dashboard/home/numbers';
import { cn } from '@/lib/utils';
import { providerLabel } from '@/lib/whatsapp/channel-management';

import { DashboardPanel, PanelEmpty } from './panel';

export interface NumbersCardProps {
  /** The account's numbers (the page's load); null until loaded. */
  numbers: AccountNumber[] | null;
  /** The load failed with nothing to show. */
  error?: boolean;
  onRetry?: () => void;
  className?: string;
}

const STATE_DOT: Record<NumberState, string> = {
  connected: 'bg-success',
  disconnected: 'bg-destructive',
  unknown: 'bg-muted-foreground',
};

const STATE_TEXT: Record<NumberState, string> = {
  connected: 'text-success',
  disconnected: 'text-destructive',
  unknown: 'text-muted-foreground',
};

/**
 * Is every WhatsApp number up? One summary line, then each number with
 * its provider, the primary marker and the health monitor's verdict.
 */
export function NumbersCard({
  numbers,
  error,
  onRetry,
  className,
}: NumbersCardProps) {
  const t = useTranslations('Dashboard.home.numbers');
  const health = numbers ? numberHealth(numbers) : null;

  return (
    <DashboardPanel
      title={t('title')}
      icon={Smartphone}
      tone="emerald"
      action={{ href: '/settings?tab=numbers', label: t('manage') }}
      loading={health === null && !error}
      error={error}
      onRetry={onRetry}
      className={className}
    >
      {health && health.total === 0 ? (
        <PanelEmpty
          icon={Smartphone}
          title={t('empty')}
          action={{ href: '/settings?tab=whatsapp', label: t('connect') }}
        />
      ) : health ? (
        <div className="space-y-3">
          <Summary health={health} />
          <ul className="space-y-1.5">
            {health.rows.map(({ number: n, state }) => (
              <li
                key={n.id}
                className="bg-card-2 flex min-w-0 items-center gap-2 rounded-lg px-3 py-2"
              >
                <span
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    STATE_DOT[state]
                  )}
                  aria-hidden
                />
                <span className="text-foreground min-w-0 truncate text-sm font-medium">
                  {numberName(n) ?? t('cloudNumber')}
                </span>
                <span className="border-border text-muted-foreground shrink-0 rounded border px-1.5 text-xs leading-4">
                  {providerLabel(n.provider)}
                </span>
                {n.is_primary && (
                  <span className="bg-primary-soft text-primary shrink-0 rounded px-1.5 text-xs leading-4 font-medium">
                    {t('primary')}
                  </span>
                )}
                <span
                  className={cn(
                    'ml-auto shrink-0 text-xs font-medium',
                    STATE_TEXT[state]
                  )}
                >
                  {t(`state.${state}`)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </DashboardPanel>
  );
}

function Summary({ health }: { health: ReturnType<typeof numberHealth> }) {
  const t = useTranslations('Dashboard.home.numbers');
  const { total, connected, disconnected } = health;
  const [Icon, tone, text] =
    health.summary === 'some_disconnected'
      ? [
          CircleAlert,
          'text-destructive',
          t('someDisconnected', { down: disconnected, total }),
        ]
      : health.summary === 'partly_known'
        ? [
            CircleHelp,
            'text-muted-foreground',
            t('partlyKnown', { connected, total }),
          ]
        : [CircleCheck, 'text-success', t('allConnected', { total })];
  return (
    <p className={cn('flex items-center gap-2 text-sm font-medium', tone)}>
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      {text}
    </p>
  );
}
