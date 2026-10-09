'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Activity, Loader2, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import type { AiActivitySummary } from '@/lib/ai/activity';
import { AI_DISPATCH_OUTCOMES } from '@/lib/ai/outcomes';

type ActivityResponse = AiActivitySummary & {
  window_days: number;
  truncated: boolean;
};

const KNOWN_OUTCOMES = new Set<string>(AI_DISPATCH_OUTCOMES);
const TOP_REASONS = 5;

/**
 * What the auto-reply bot did over the last 7 days (migration 077's
 * `ai_reply_events`, plus auto-reply token spend). Admin-only, like the
 * API and RLS behind it, so for anyone else the card is not rendered.
 */
export function AiActivityCard({
  accountId,
  canEdit,
}: {
  accountId: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations('Settings.aiActivity');
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchActivity = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/activity?days=7');
      const body = await res.json();
      if (res.ok) setData(body);
      else toast.error(body.error ?? t('loadFailed'));
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!canEdit || !accountId || loadedAccountIdRef.current === accountId)
      return;
    loadedAccountIdRef.current = accountId;
    void fetchActivity();
  }, [accountId, canEdit, fetchActivity]);

  if (!canEdit) return null;

  const reasonLabel = (outcome: string) =>
    KNOWN_OUTCOMES.has(outcome)
      ? t(`reason.${outcome}` as Parameters<typeof t>[0])
      : outcome;

  const maxTier = data ? Math.max(1, ...data.tiers.map((x) => x.replies)) : 1;
  const pct = (share: number) => `${Math.round(share * 100)}%`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="text-primary h-4 w-4" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading && !data ? (
          <div className="text-muted-foreground flex items-center py-2 text-sm">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
          </div>
        ) : !data || data.total === 0 ? (
          <p className="text-muted-foreground text-sm">{t('empty')}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(
                [
                  ['replied', data.replied],
                  ['handedOff', data.handed_off],
                  ['heldForReview', data.held_for_review],
                  ['notReplied', data.not_replied],
                ] as const
              ).map(([key, value]) => (
                <div key={key} className="border-border rounded-md border p-3">
                  <p className="text-foreground text-2xl font-semibold tabular-nums">
                    {value}
                  </p>
                  <p className="text-muted-foreground text-xs">{t(key)}</p>
                </div>
              ))}
            </div>

            <div className="space-y-2">
              <p className="text-foreground text-sm font-medium">
                {t('byTier')}
              </p>
              {data.tiers.map((tier) => (
                <div key={tier.tier} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="text-foreground">
                      {t(`tier.${tier.tier}`)}
                      {tier.model && (
                        <span className="text-muted-foreground">
                          {' '}
                          · {tier.model}
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {tier.replies}
                    </span>
                  </div>
                  <div className="bg-muted h-2 overflow-hidden rounded-full">
                    <div
                      className="bg-primary h-full rounded-full"
                      style={{ width: `${(tier.replies / maxTier) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
              <p className="text-muted-foreground text-xs">
                {data.routing.routed > 0
                  ? t('routingShare', {
                      jev: pct(data.routing.share.jev),
                      heuristic: pct(data.routing.share.heuristic),
                      fixed: pct(data.routing.share.fixed),
                    })
                  : t('routingNone')}
                {' · '}
                {t('escalated', { count: data.escalated })}
              </p>
            </div>

            {data.not_replied_reasons.length > 0 && (
              <div className="space-y-2">
                <p className="text-foreground text-sm font-medium">
                  {t('topReasons')}
                </p>
                <ul className="divide-border border-border divide-y rounded-md border">
                  {data.not_replied_reasons
                    .slice(0, TOP_REASONS)
                    .map((reason) => (
                      <li
                        key={reason.outcome}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                      >
                        <span className="text-foreground">
                          {reasonLabel(reason.outcome)}
                        </span>
                        <span className="text-muted-foreground tabular-nums">
                          {reason.count}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
            )}

            {data.tokens_by_model.length > 0 && (
              <div className="space-y-2">
                <p className="text-foreground text-sm font-medium">
                  {t('tokensByModel')}
                </p>
                <ul className="text-sm">
                  {data.tokens_by_model.map((row) => (
                    <li
                      key={row.model}
                      className="flex items-center justify-between gap-3 py-0.5"
                    >
                      <span className="text-foreground">{row.model}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {t('tokens', {
                          tokens: row.total_tokens.toLocaleString(),
                          calls: row.calls,
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {data.truncated && (
              <p className="text-muted-foreground text-xs">{t('truncated')}</p>
            )}
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void fetchActivity()}
          disabled={loading}
        >
          <RefreshCw className="mr-2 h-4 w-4" /> {t('refresh')}
        </Button>
      </CardContent>
    </Card>
  );
}
